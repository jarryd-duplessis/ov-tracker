# Komt ie? — Implementation Plan

**Date:** 2026-03-18
**Goal:** Re-architect from $331K/month at 10K DAU to ~$300/month

---

## Build order

Each step is deployable independently. No step depends on a later step.
Estimated total: 4-5 days of focused work.

---

## Step 1: Stop polling when idle (2 hours)

**Why first:** Free. Cuts 80% of requests immediately. Zero infrastructure changes.

### Changes

**`frontend/src/Map.jsx`**
- Track last user interaction time (touch, mouse move, scroll, zoom)
- After 30s of no interaction, pause the vehicle fetch interval
- Resume immediately on any interaction
- Add `document.addEventListener('visibilitychange')` — pause ALL polling when tab is hidden

**`frontend/src/useOVWebSocket.js`**
- Accept a `paused` prop or expose `pause()`/`resume()` methods
- When paused, clear the poll interval and don't start new ones
- When resumed, fetch immediately then restart interval

**`frontend/src/App.jsx`**
- Track visibility state: `document.hidden`
- Pass paused state to both the vehicle fetcher and departure poller

### Test
- Open the app, wait 30s without touching → vehicle requests stop (check Network tab)
- Touch the map → requests resume immediately
- Switch to another browser tab → all requests stop
- Switch back → requests resume

---

## Step 2: Single-vehicle tracking endpoint (2 hours)

**Why second:** When tracking a departure, the user only cares about ONE vehicle. No need to fetch all 4,000.

### Changes

**`lambda/http_vehicles.js`**
- Add route: `GET /api/vehicles/{id}` — returns single vehicle by entity ID
- Read from the same S3 vehicle cache
- Response: ~500 bytes (one vehicle object)
- Cache-Control: `public, max-age=3`

**`terraform/lambda.tf`**
- Add API Gateway route for `GET /api/vehicles/{id}`

**`frontend/src/App.jsx`**
- When `trackedDeparture` is set and `journeyRoute._vehicleId` is known:
  - Poll `GET /api/vehicles/{vehicleId}` every 5s instead of the full feed
  - Only need position updates for the one tracked vehicle

**`frontend/src/Map.jsx`**
- The vehicle animation system already handles individual vehicle updates
- Feed the single-vehicle response into the same animation state

### Test
- Click a departure to track → Network tab shows `/api/vehicles/2026-03-18:CXX:U008:72` (500 bytes)
- NOT the full `/api/vehicles` (900KB)

---

## Step 3: Geographic vehicle tiles (4 hours)

**Why third:** Makes vehicle data CDN-cacheable. All users viewing the same area share the same response.

### Design

Split the Netherlands into a grid of tiles. Each tile covers a geographic area and contains the vehicles currently within it.

```
Tile grid: 0.1° latitude × 0.15° longitude ≈ 11km × 10km per tile
Netherlands: lat 50.5-53.7, lon 3.3-7.3
Grid: 32 rows × 27 columns = 864 tiles (most are sea/empty)
Active tiles (with vehicles): ~150-200
```

Tile URL: `/api/vehicles/tile/{latBucket}/{lonBucket}`
Example: `/api/vehicles/tile/521/49` (lat 52.1-52.2, lon 4.9-5.05)

### Changes

**New: `lambda/tile_vehicles.js`** (EventBridge trigger, every 5s)
- Fetch GTFS-RT protobuf (same as current `lib/vehicles.js`)
- Compute bearing/speed from position deltas (same logic)
- Bucket each vehicle into its tile by `floor(lat * 10)` / `floor(lon / 0.15)`
- Write each non-empty tile to S3: `tiles/{latBucket}_{lonBucket}.json`
- Write a tile manifest: `tiles/manifest.json` listing active tiles with vehicle counts
- Total S3 writes per cycle: ~200 PUTs (active tiles + manifest)

**`lambda/http_vehicles.js`**
- Keep the current `/api/vehicles` endpoint for backward compatibility (deprecated)
- Add: `GET /api/vehicles/tile/{lat}/{lon}` — read tile from S3, return with `Cache-Control: public, max-age=3`
- Response per tile: ~5-15KB (20-60 vehicles)

**`terraform/lambda.tf`**
- Add EventBridge rule: rate(5 seconds) → tile_vehicles Lambda
- Add API Gateway route: `GET /api/vehicles/tile/{lat}/{lon}`

**`frontend/src/Map.jsx`**
- Replace single `/api/vehicles` fetch with multi-tile fetch:
  1. Get current map bounds
  2. Calculate which tiles overlap the viewport
  3. Fetch each tile: `GET /api/vehicles/tile/{lat}/{lon}`
  4. Merge results, feed into existing vehicle animation system
- Typically 2-6 tiles per viewport at zoom 14-15
- CloudFront caches tiles → most fetches served from edge (sub-10ms)

### Cache flow
```
[EventBridge 5s] → [tile_vehicles Lambda] → [S3: tiles/*.json]
                                                    ↓
[User browser] → [CloudFront edge cache (3s)] → [API Gateway] → [http_vehicles Lambda] → [S3 read]
                        ↑
                  95% served from here
                  (same tile for all users in same area)
```

### Test
- Open app zoomed to Utrecht → Network tab shows 2-4 tile requests, each 5-15KB
- Two browsers viewing the same area → CloudFront logs show cache HITs
- Pan to Amsterdam → different tiles load, Utrecht tiles stop

---

## Step 4: Separate ingestion from serving (3 hours)

**Why fourth:** The tile Lambda from Step 3 already does ingestion. This step formalises the separation and moves interpolation server-side.

### Changes

**`lambda/tile_vehicles.js`** (enhance from Step 3)
- Add server-side dead reckoning:
  1. On each cycle, read previous positions from S3 (`tiles/state.json`)
  2. For each vehicle: compute interpolated position based on speed + bearing + route shape
  3. Write interpolated positions to tiles (not raw GPS)
  4. Store current raw positions as new state
- Add confidence tier computation:
  - `live`: GPS < 15s old
  - `recent`: GPS 15-60s old
  - `estimated`: interpolating, last GPS 1-5 min old
  - `scheduled`: no real-time data
  - `unknown`: no data > 5 min → exclude from tile
- Include confidence tier in each vehicle object in the tile

**`frontend/src/Map.jsx`**
- Remove client-side dead reckoning (findOnPath, walkAlongPath, snapToPath, animation loop)
- Replace with simple smooth-move: on new data, animate marker from current position to server-provided position over ~2s
- Read confidence tier from vehicle data, apply visual styling (solid/transparent/outline)
- **~400 lines of animation code removed**

**Route path data**
- Move route path fetching to the ingestion Lambda
- Ingestion Lambda maintains a cache of route shapes (from `/api/trip`)
- Uses route shapes for server-side interpolation
- Frontend no longer fetches route paths for individual vehicles

### Test
- All vehicles move smoothly (server provides pre-interpolated positions)
- Two browsers show IDENTICAL vehicle positions (server-side interpolation is shared)
- Vehicle markers show confidence tier visually (solid vs transparent vs outline)

---

## Step 5: Event persistence (2 hours)

**Why fifth:** The ingestion Lambda from Step 4 already processes all vehicle data. Just add S3 writes.

### Changes

**`lambda/tile_vehicles.js`** (enhance)
- On each 5s cycle, append raw vehicle positions to a buffer
- Every 5 minutes, flush buffer to S3: `events/YYYY/MM/DD/HH-MM.json.gz`
- Each file: ~500KB compressed (5 min × 4000 vehicles × 12 updates)
- Daily: 288 files × 500KB = ~140MB

**New: `lambda/compact_events.js`** (EventBridge trigger, daily 04:00 UTC)
- Read all event files for previous day from S3
- Convert to Parquet format (columnar, compressed)
- Write to: `archive/YYYY/MM/DD.parquet` (~200MB/day)
- Delete raw JSON files after compaction
- Apply S3 lifecycle rule: move to Infrequent Access after 90 days

**`terraform/lambda.tf`**
- Add EventBridge rule: daily 04:00 UTC → compact_events Lambda
- Add S3 lifecycle rule on `archive/` prefix

### Data schema (per event)
```
timestamp: int64 (Unix ms)
vehicle_id: string
lat: float32
lon: float32
bearing: float32
speed: float32
route_id: string
trip_id: string
line: string
category: string (BUS/TRAM/METRO)
confidence: string (live/recent/estimated/scheduled)
```

### Test
- After 5 min: S3 has `events/2026/03/19/14-30.json.gz`
- After daily job: `archive/2026/03/18.parquet` exists
- Athena query: `SELECT COUNT(*) FROM events WHERE date = '2026-03-18'` returns ~115M

---

## Step 6: Store all journeys per route (3 hours)

**Why sixth:** Eliminates the time-shift hack. Correct stop times for every journey.

### Changes

**`lambda/lib/trips.js` — `buildOpenOvTripIndex()`**
- Currently: stores only ONE representative trip per route
- Change: store ALL trips (same as `buildTripIndex()` does for KV7)
- Each route file grows from ~1 journey to ~50-100 journeys
- S3 storage: 34MB → ~200MB (still tiny)

**`lambda/http_trip.js`**
- Remove the time-shift hack (lines 34-78)
- `findJourney()` now finds exact journey matches with correct times
- Keep fuzzy matching as fallback (within ±5 of target)

**`lambda/refresh_stops.js`**
- Increase timeout from 900s to 1200s (20 min) to handle larger index
- Add progress logging

### Test
- Click on a bus at 15:00 → TripPanel shows 15:XX times (not 05:34)
- Different journeys on the same route show different times
- All stops have correct arrival/departure times

---

## Step 7: 5-tier confidence system (3 hours)

**Why seventh:** Requires server-side interpolation (Step 4). Honest data quality display.

### Changes

**`lambda/tile_vehicles.js`**
- Already computing confidence from Step 4
- Add to tile output: `confidence: "live" | "recent" | "estimated" | "scheduled" | "unknown"`
- Vehicles with `unknown` confidence (>5 min stale): exclude from tile entirely

**`frontend/src/Map.jsx`**
- Vehicle marker styling based on confidence:

  | Tier | Icon style | Example |
  |---|---|---|
  | `live` | Solid fill, pulsing green dot | 🟢 Fresh GPS |
  | `recent` | Solid fill, no pulse | GPS 15-60s old |
  | `estimated` | Semi-transparent, dashed radius ring | Interpolating 1-5 min |
  | `scheduled` | Outline only, grey | Schedule position only |

- Departure board: include confidence in countdown display
  - "2 min (live)" vs "~4 min (estimated)" vs "4 min (scheduled)"

**`frontend/src/DepartureBoard.jsx`**
- Update status indicators to use backend-provided confidence
- Show confidence-aware language in the countdown

### Test
- Vehicles near the user with fresh GPS: solid icons with pulse
- Vehicles far away or with stale data: semi-transparent or outline
- Departure board shows "(live)" or "(scheduled)" next to countdown

---

## Step 8: NDOV ZeroMQ integration (2 days)

**Why last:** Largest infrastructure change. Requires always-on compute (EC2/ECS). Current OVapi works for now.

### Changes

**New: EC2 t4g.nano instance** (or ECS Fargate task)
- Run a ZeroMQ subscriber process (Node.js or Python)
- Subscribe to NDOV streams:
  - `/RIG/KV6posinfo` — Vehicle events (INIT, ARRIVAL, DEPARTURE, ONSTOP, END)
  - `/RIG/KV15messages` — Disruption messages
  - `/RIG/KV17cvlinfo` — Cancellations and mutations
- On each message: parse, transform, write to SQS

**New: `lambda/process_kv6.js`** (SQS trigger)
- Process KV6 events
- Update vehicle state in S3 (same state used by tile_vehicles)
- Convert Rijksdriehoek (EPSG:28992) to WGS84
- Persist raw events for archive

**New: `lambda/process_kv15.js`** (SQS trigger)
- Process disruption messages
- Store active disruptions in DynamoDB
- Expose via new endpoint: `GET /api/disruptions`

**New: `lambda/process_kv17.js`** (SQS trigger)
- Process cancellations/mutations
- Flag cancelled trips in the departure data
- Enable ghost bus detection (scheduled trip with no KV6 events)

**`lambda/tile_vehicles.js`**
- Read from KV6-updated vehicle state instead of GTFS-RT protobuf
- Fall back to GTFS-RT if KV6 data is stale (>60s)

**`frontend/src/DepartureBoard.jsx`**
- Show disruption banners for affected routes
- Show cancelled trips with strikethrough

**`terraform/`**
- Add EC2 t4g.nano instance (or ECS Fargate service)
- Add SQS queues (kv6, kv15, kv17)
- Add Lambda functions (process_kv6, process_kv15, process_kv17)
- Add DynamoDB table for disruptions

### Architecture after Step 8
```
[NDOV ZeroMQ] → [EC2 ZMQ subscriber] → [SQS kv6/kv15/kv17]
                                              ↓
                                    [Process Lambdas]
                                              ↓
                              [S3 vehicle state + DynamoDB disruptions]
                                              ↓
[EventBridge 5s] → [tile_vehicles Lambda] → [S3 tiles/*.json]
                                              ↓
[Browser] → [CloudFront edge (3s cache)] → [API Gateway] → [Lambda] → [S3]
```

### Fallback
- If NDOV ZMQ connection drops: fall back to GTFS-RT protobuf (current approach)
- If both fail: fall back to schedule data, mark all vehicles as `confidence: scheduled`

### Test
- Compare KV6-sourced positions with GTFS-RT positions — should be identical or more frequent
- Disruption messages appear as banners in the departure board
- Cancelled trips show strikethrough in departure list
- Kill the ZMQ subscriber → system falls back to GTFS-RT within 60s

---

## Summary

| Step | What | Effort | Monthly cost delta | Cumulative savings at 10K DAU |
|---|---|---|---|---|
| 1 | Stop polling when idle | 2h | $0 | 80% of vehicle requests eliminated |
| 2 | Single-vehicle tracking endpoint | 2h | $0 | Tracked departures: 900KB → 500 bytes |
| 3 | Geographic vehicle tiles | 4h | +$32 (tile Lambda) | All vehicle data CDN-cacheable (95% hit) |
| 4 | Server-side interpolation | 3h | $0 (reuses tile Lambda) | Consistent positions, simpler frontend |
| 5 | Event persistence | 2h | +$1 (S3 storage) | Historical data for future analytics |
| 6 | All journeys per route | 3h | +$0.01 (S3 storage) | Correct stop times, no time-shift hack |
| 7 | 5-tier confidence | 3h | $0 | Honest data quality indicators |
| 8 | NDOV ZeroMQ | 2 days | +$4-8 (EC2 + SQS) | Sub-second data, disruptions, ghost bus detection |
| **Total** | | **~4-5 days** | **+$37-41/month** | **$331K → $298/month at 10K DAU** |

---

## Files changed per step

### Step 1 (idle detection)
```
MODIFY  frontend/src/Map.jsx           — idle timer, pause vehicle fetch
MODIFY  frontend/src/useOVWebSocket.js — pause/resume support
MODIFY  frontend/src/App.jsx           — visibility API, pass paused state
```

### Step 2 (single-vehicle endpoint)
```
MODIFY  lambda/http_vehicles.js        — add /{id} route handler
MODIFY  terraform/lambda.tf            — add API Gateway route
MODIFY  frontend/src/App.jsx           — poll single vehicle when tracking
```

### Step 3 (geographic tiles)
```
CREATE  lambda/tile_vehicles.js        — background tile generator
MODIFY  lambda/http_vehicles.js        — add /tile/{lat}/{lon} handler
MODIFY  terraform/lambda.tf            — EventBridge rule + API route
MODIFY  frontend/src/Map.jsx           — multi-tile fetch, merge results
```

### Step 4 (server-side interpolation)
```
MODIFY  lambda/tile_vehicles.js        — add interpolation + confidence
MODIFY  frontend/src/Map.jsx           — remove client dead reckoning (~400 lines)
```

### Step 5 (event persistence)
```
MODIFY  lambda/tile_vehicles.js        — buffer + flush raw events to S3
CREATE  lambda/compact_events.js       — daily Parquet compaction
MODIFY  terraform/lambda.tf            — EventBridge rule + S3 lifecycle
```

### Step 6 (all journeys)
```
MODIFY  lambda/lib/trips.js            — store all journeys in openov index
MODIFY  lambda/http_trip.js            — remove time-shift hack
MODIFY  lambda/refresh_stops.js        — increase timeout
```

### Step 7 (confidence tiers)
```
MODIFY  lambda/tile_vehicles.js        — emit confidence field
MODIFY  frontend/src/Map.jsx           — confidence-based marker styling
MODIFY  frontend/src/DepartureBoard.jsx — confidence labels on countdowns
```

### Step 8 (NDOV ZeroMQ)
```
CREATE  infra/zmq_subscriber/          — EC2/ECS ZMQ subscriber service
CREATE  lambda/process_kv6.js          — KV6 event processor
CREATE  lambda/process_kv15.js         — disruption processor
CREATE  lambda/process_kv17.js         — cancellation processor
MODIFY  lambda/tile_vehicles.js        — read from KV6 state
MODIFY  terraform/                     — EC2, SQS, Lambda, DynamoDB
MODIFY  frontend/src/DepartureBoard.jsx — disruption banners, cancelled trips
```

---

## Architecture: before and after

### Before (current)
```
[OVapi GTFS-RT]  ──→  [http_vehicles Lambda]  ──→  [CloudFront]  ──→  [Browser]
                       (fetch + serve coupled)      (uncacheable)      (client-side
                       (900KB full payload)          (per-user unique)   dead reckoning)
```

### After (all steps)
```
[NDOV ZeroMQ]  ──→  [EC2 subscriber]  ──→  [SQS]  ──→  [Process Lambda]
                                                              ↓
                                                    [S3 vehicle state]
                                                              ↓
[EventBridge 5s]  ──→  [tile_vehicles Lambda]  ──→  [S3 tiles + events]
                        (interpolation,                    ↓
                         confidence,              [CloudFront edge]  ──→  [Browser]
                         tiling)                   (3s cache, shared)     (simple smooth-move,
                                                   (5-15KB per tile)      confidence display)
```

### Key architectural wins
1. **Ingestion decoupled from serving** — NDOV/GTFS-RT failures don't affect user requests
2. **CDN-cacheable** — same tile served to all users in same area
3. **Server-side interpolation** — consistent positions, simpler frontend
4. **Event persistence** — enables all future analytics features
5. **Idle detection** — 80% fewer requests from realistic usage patterns
6. **Confidence tiers** — honest data quality, builds user trust
