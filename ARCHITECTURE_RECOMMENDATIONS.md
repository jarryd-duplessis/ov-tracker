# Komt ie? — Architecture Recommendations

**Date:** 2026-03-18
**Based on:** Transport Engineering Skill audit of current codebase

---

## Current Architecture Summary

| Component | Technology | Purpose |
|---|---|---|
| Frontend | React + MapLibre GL JS + Vite | SPA with real-time map |
| API | API Gateway (HTTP) + Lambda (Node.js 20) | Serverless HTTP endpoints |
| Data cache | S3 (stops, trips, vehicles) | Persistent state |
| Session cache | DynamoDB (departures 14s TTL) | Short-lived request dedup |
| CDN | CloudFront | Frontend hosting + API caching |
| Data sources | OVapi (GTFS-RT protobuf, REST), Nominatim, Motis | External APIs |
| Scheduled | EventBridge (daily 03:00 UTC) | GTFS refresh |

### Current data flow

```
OVapi GTFS-RT protobuf ──→ http_vehicles Lambda ──→ S3 cache (3s) ──→ CloudFront (3s) ──→ Frontend (2s poll)
OVapi REST /tpc/{codes} ──→ http_departures Lambda ──→ DynamoDB (14s) ──→ Frontend (15s poll)
KV7 + openov-nl GTFS ZIP ──→ refresh_stops Lambda (daily) ──→ S3 (stops_cache.json, trips/*.json)
Nominatim + Motis ──→ http_journey Lambda ──→ Frontend
```

---

## Current Costs

### At 1 user (current — testing only)

| Resource | Usage/day | Cost/month |
|---|---|---|
| Lambda invocations | ~21,600 (avg 256MB, 400ms) | $0.54 |
| API Gateway requests | ~21,600 | $0.65 |
| S3 storage + requests | 40MB, ~20K GET | $0.02 |
| DynamoDB (PAY_PER_REQUEST) | ~5K reads, 350 writes | $0.05 |
| CloudFront requests + transfer | ~648K req, ~500MB/day | $2.50 |
| Data transfer | ~500MB/day | $1.35 |
| **Total** | | **~$5/month** |

### Projected at scale (no changes)

| DAU | Primary cost driver | Monthly cost |
|---|---|---|
| 1 | — | $5 |
| 100 | CloudFront transfer (5.4TB — 900KB vehicles × 30 req/min × 100 users × 12h) | **$475** |
| 1,000 | CloudFront transfer (54TB) | **$4,700** |
| 10,000 | CloudFront transfer (540TB) | **$47,000** |

**Root cause:** The `/api/vehicles` endpoint returns ALL ~4,000 vehicles (~900KB JSON) every 2 seconds to every client, regardless of what's visible on their map.

---

## Recommended Changes

### Phase 1: Viewport-filtered vehicles (CRITICAL — do first)

**Problem:** 900KB payload × 2s polling × N users = unsustainable transfer costs.

**Changes:**
1. Add `bbox` parameter to `/api/vehicles`: `?south=52.0&west=4.8&north=52.1&east=5.2`
2. Server filters to vehicles within viewport before responding
3. Add `ETag` / `If-None-Match` headers — return 304 when data unchanged
4. Increase client poll interval from 2s to 5s (matches actual data refresh rate)

**Implementation:**
- `lambda/http_vehicles.js`: Accept bbox query params, filter vehicles array
- `frontend/src/Map.jsx`: Pass map bounds with each vehicle fetch

**Impact:**
| Metric | Before | After |
|---|---|---|
| Response size | 900KB | 20-50KB (95% reduction) |
| Requests/user/min | 30 | 12 |
| Transfer/user/day (12h) | 5.4GB | ~50MB |
| 100 DAU monthly cost | $475 | **~$30** |
| 1,000 DAU monthly cost | $4,700 | **~$250** |

**Additional cost:** $0 (code change only)

---

### Phase 2: Server-side interpolation

**Problem (per transport engineering best practice):**
- Client-side interpolation means every user sees a different position for the same vehicle
- Cannot log interpolated vs actual positions for accuracy measurement
- 600+ lines of complex animation code in Map.jsx
- Ingestion and serving are coupled in the same Lambda

**Changes:**
1. Separate ingestion Lambda (EventBridge trigger every 3s) fetches GTFS-RT, computes bearing/speed/interpolated positions, writes pre-computed state to S3
2. Serving Lambda reads pre-computed state, applies bbox filter, returns
3. Client animation simplified: just smooth-move markers to server-provided positions

**Architecture:**
```
[EventBridge 3s] ──→ [Ingestion Lambda] ──→ [S3: interpolated vehicle state]
                         │                         │
                         │ fetch protobuf           │ read + filter
                         ↓                         ↓
                    [OVapi GTFS-RT]         [Serving Lambda] ──→ [Client]
```

**Implementation:**
- New `lambda/ingest_vehicles.js`: Fetch protobuf, compute positions, dead-reckon along routes, write S3
- Modify `lambda/http_vehicles.js`: Read from S3 only (no OVapi fetch)
- Simplify `frontend/src/Map.jsx`: Remove findOnPath, walkAlongPath, snapToPath, animation loop (~400 lines removed)

**Cost:**
| Component | Monthly |
|---|---|
| EventBridge rule (3s = 864K triggers/month) | $0.30 |
| Ingestion Lambda (864K × 256MB × 500ms) | $0.70 |
| S3 writes (864K PUTs) | $0.004 |
| **Total** | **~$1/month** |

---

### Phase 3: Event persistence

**Problem:** No historical data persisted. Cannot build reliability scoring, ghost bus detection, delay prediction, or seasonal analysis. The transport engineering skill states: "Storage is cheap. Transit data that you didn't persist is gone forever."

**Changes:**
1. Ingestion Lambda (from Phase 2) writes raw events to S3 alongside the live state
2. Daily batch job compresses to Parquet format
3. After 90 days, move to S3 Infrequent Access

**Data volume:**
| Metric | Value |
|---|---|
| Vehicles per update | ~4,000 |
| Updates per day (every 3s) | 28,800 |
| Records per day | ~115M |
| Raw JSON per day | ~2GB |
| Compressed Parquet per day | ~200MB |
| Monthly storage | ~6GB |

**Cost:**
| Component | Monthly |
|---|---|
| S3 Standard (recent 90 days, 18GB) | $0.41 |
| S3 Infrequent Access (older) | $0.23 |
| Lambda for Parquet conversion (daily) | $0.01 |
| **Total** | **~$0.65/month** |

**Enables (future features):**
- Reliability scoring per line/stop/time-of-day
- Ghost bus detection (scheduled trip with no position data)
- Delay prediction using historical segment times
- Weather correlation (pair with Buienradar/KNMI data)
- Dead zone mapping (areas with poor data coverage)

---

### Phase 4: NDOV ZeroMQ (production-grade data source)

**Problem:** OVapi is a community project with no SLA. The transport engineering skill explicitly warns: "Useful for prototyping but has no SLA — production systems should consume NDOV directly."

**Changes:**
1. Run a persistent ZeroMQ subscriber (EC2 t4g.nano or ECS Fargate)
2. Subscribe to NDOV real-time streams: KV6 (vehicle events), KV15 (disruptions), KV17 (cancellations)
3. Write events to SQS for Lambda processing
4. Fall back to OVapi GTFS-RT if NDOV is unavailable

**Architecture:**
```
[NDOV ZeroMQ] ──→ [EC2 t4g.nano ZMQ subscriber] ──→ [SQS] ──→ [Processing Lambda]
                                                                     │
                                                               [S3 vehicle state]
                                                               [S3 event archive]
```

**Benefits:**
- Sub-second data freshness (vs 3-5s OVapi polling)
- Direct KV6 events: ARRIVAL, DEPARTURE, ONSTOP, INIT, END
- Access to KV15 disruption messages (not available via GTFS-RT)
- Access to KV17 cancellations (enables ghost bus detection)
- Production-grade: NDOV is operated by DOVA with institutional backing

**Cost:**
| Component | Monthly |
|---|---|
| EC2 t4g.nano (always-on) | $3.07 |
| OR: ECS Fargate (0.25 vCPU, 0.5GB) | $7.30 |
| SQS queue (~2.6M messages/day) | $1.04 |
| **Total** | **$4-8/month** |

**Note:** NDOV data access is free (open data under EU Directive 2019/1024). Registration required at data.ndovloket.nl.

---

### Phase 5: Store all journeys per route

**Problem:** The openov-nl trip index stores only ONE representative journey per route (typically the earliest trip of the day). When viewing any other journey, stop times are wrong (e.g., 05:34 AM for an afternoon bus). Current workaround: time-shift hack in http_trip.js that roughly adjusts times based on current time of day.

**Changes:**
1. Modify `buildOpenOvTripIndex()` in `lambda/lib/trips.js` to store ALL journeys, not just the representative
2. Remove the time-shift hack from `lambda/http_trip.js`
3. `findJourney()` will find exact matches for any journey number

**Impact:**
| Metric | Before | After |
|---|---|---|
| S3 trip storage | 34MB | ~200MB |
| S3 cost increase | — | $0.005/month |
| Refresh Lambda duration | ~9 min | ~15 min |
| Time accuracy | Approximate (±15 min) | Exact |

**Additional cost: ~$0.01/month**

---

### Phase 6: 5-tier confidence system

**Problem:** Current system has 2 confidence levels (live/scheduled). The transport engineering skill recommends 5 tiers to honestly communicate data quality.

**Changes:**
Add server-computed confidence tier to each vehicle position:

| Tier | Condition | Visual treatment |
|---|---|---|
| **Live** | Fresh GPS < 15s old | Solid icon, pulsing dot |
| **Recent** | GPS 15-60s old | Solid icon, no pulse |
| **Estimated** | Interpolating, last data 1-5 min old | Semi-transparent, radius ring |
| **Scheduled** | No real-time data, schedule position only | Outline/ghost icon |
| **Unknown** | No data for > 5 min | Not shown or grey |

**Implementation:**
- Ingestion Lambda computes tier from data age + feed characteristics
- Frontend renders different marker styles per tier
- Departure board shows confidence-aware messaging: "2 min away (live)" vs "~4 min (estimated)"

**Cost:** $0 (logic change only)

---

## Implementation Priority

| Priority | Phase | Effort | Monthly cost | Impact |
|---|---|---|---|---|
| 1 | Phase 1: Viewport filtering | 2-3 hours | $0 | **Prevents cost disaster at scale** |
| 2 | Phase 5: All journeys | 3-4 hours | $0.01 | **Fixes wrong stop times** |
| 3 | Phase 2: Server-side interpolation | 1-2 days | $1 | **Architecture correctness, simpler frontend** |
| 4 | Phase 6: Confidence tiers | 4-6 hours | $0 | **User trust, data honesty** |
| 5 | Phase 3: Event persistence | 2-3 hours | $0.65 | **Enables all future analytics** |
| 6 | Phase 4: NDOV ZeroMQ | 2-3 days | $4-8 | **Production-grade data, sub-second freshness** |

---

## Revised cost strategy: Smart Hybrid

The Phase 1 bbox approach still generates unique responses per user (uncacheable).
The real savings come from a fundamentally different delivery model.

### Key insight

Most users are NOT watching the map continuously. They check departures (text),
glance at the map for ~5 minutes, then put their phone away. The current architecture
polls 900KB every 2 seconds whether the user is looking or not.

### Five changes that cut costs 95%

**1. Stop polling when idle.** If the user hasn't touched the map in 30 seconds,
stop fetching vehicles entirely. Resume on touch/scroll. Use the Page Visibility
API to stop ALL polling when the browser tab is in the background. This alone
cuts 80%+ of vehicle requests.

**2. Geographic tiles.** Pre-compute ~150 tiles covering NL (e.g., `/api/vehicles/tile/52.0/5.0`).
Each tile is ~8KB containing 20-40 vehicles. CloudFront caches each tile for 3 seconds.
All users viewing the same area get the SAME cached response — no per-user computation.
A background Lambda refreshes all tiles every 5 seconds.

**3. Single-vehicle tracking endpoint.** When tracking a departure, don't poll the
full vehicle feed. Add `GET /api/vehicles/{id}` returning just one vehicle (~500 bytes
vs 900KB). Only the tracked vehicle needs frequent updates.

**4. Reduce departure poll interval.** 15s is aggressive for text departure data.
30s would halve requests with minimal UX impact — departures rarely change faster
than that.

**5. Binary format (optional).** Tiles in MessagePack or Protocol Buffers instead
of JSON cuts payload 60% further (8KB → 3KB per tile).

### Cost at scale with Smart Hybrid

| DAU | Departures | Map tiles | Tile origin | Tracking | Misc | **Total** | **Per user** |
|---|---|---|---|---|---|---|---|
| 1,000 | $9 | $17 | $32 | $0 | $5 | **$63/mo** | $0.063 |
| 5,000 | $43 | $85 | $32 | $2 | $5 | **$167/mo** | $0.033 |
| 10,000 | $85 | $171 | $32 | $4 | $5 | **$298/mo** | $0.030 |

### Comparison: all strategies at 10,000 DAU

| Strategy | Monthly cost |
|---|---|
| A) Current (900KB, 2s poll, no cache) | $331,000 |
| B) Bbox filter (40KB, 5s poll, uncacheable) | $10,500 |
| C) Geographic tiles (8KB, 5s, 95% cache hit) | $8,250 |
| D) Tiles + binary format (3KB) | $6,500 |
| E) WebSocket push (2KB deltas) | $1,900 |
| **F) Smart Hybrid (tiles + idle detection + single-vehicle tracking)** | **$298** |

Strategy F wins because it models **realistic user behaviour** — not every user
staring at the map 8 hours straight, but brief interactive sessions with long
idle periods.

### Assumptions for Strategy F

- Average user has 2 sessions/day, ~5 min map viewing per session (10 min total)
- Departure checking: ~30 min total across the day
- 20% of users track a specific vehicle for ~3 min per session
- Geographic tiles: 150 tiles covering NL, refreshed every 5s by background Lambda
- CloudFront cache hit rate: 95% (same tile served to all users in same area)
- Tile size: ~8KB JSON (~20-40 vehicles per tile)

---

## Total cost at 1,000 DAU (all phases + smart hybrid)

| Component | Monthly |
|---|---|
| Lambda — tile refresh (background, 77.8M invocations) | $32 |
| Lambda — API handlers (departures, stops, trips, journey) | $10 |
| CloudFront — edge requests + transfer | $17 |
| API Gateway — cache misses only | $2 |
| S3 (storage + requests) | $2 |
| DynamoDB (departures cache) | $3 |
| EC2 t4g.nano (NDOV subscriber — Phase 4) | $3 |
| Event archive S3 (Phase 3) | $1 |
| **Total** | **~$70/month** |

vs **$4,700/month** with current architecture at 1,000 DAU.

---

## Gaps identified by transport engineering audit

| Gap | Skill recommendation | Status | Phase |
|---|---|---|---|
| Client-side interpolation | Server-side | Not started | Phase 2 |
| No event persistence | Store all raw events | Not started | Phase 3 |
| No reliability scoring | Precompute per line/stop | Not started | Requires Phase 3 |
| No ghost bus detection | Compare schedule vs actual | Not started | Requires Phase 3+4 |
| 2-tier confidence | 5-tier system | Not started | Phase 6 |
| OVapi dependency (no SLA) | NDOV ZeroMQ direct | Not started | Phase 4 |
| No disruption ingestion | KV15/KV17/SIRI-SX | Not started | Phase 4 |
| No weather correlation | Buienradar/KNMI integration | Not started | Requires Phase 3 |
| No feed health monitoring | Track latency/completeness | Not started | Phase 2 |
| Dead reckoning overshoots stops | Hold at 95%, reduce confidence | Not started | Phase 2+6 |
| Single journey per route | Store all journeys | Not started | Phase 5 |
| Coupled ingestion/serving | Separate via queue/S3 | Not started | Phase 2 |
