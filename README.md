# Komt ie?

> Live Dutch public transport tracker — see if your bus or tram is actually coming.

The core problem: 9292 shows a bus is due in 3 minutes. The bus doesn't show up.
**Komt ie?** shows you live vehicle positions and flags whether a departure is broadcasting a real position (`LIVE`) or just a timetable entry (`SCHEDULED`).

Live at: **https://ov.jarryd.co.za**

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + MapLibre GL JS |
| Backend | AWS Lambda (Node.js 20) + API Gateway v2 |
| Infra | CloudFront, S3, DynamoDB, SQS, EventBridge |
| Data | OVapi + GTFS KV7 + openov-nl (GOVI) |
| Map tiles | OpenFreeMap |

---

## Getting Started (local dev)

### Prerequisites
- Node.js 20+
- npm

### 1. Start the backend

```bash
cd backend
npm install
npm run dev
```

Backend runs on `http://localhost:3001`.

On first start it downloads and merges KV7 + openov-nl GTFS stops and caches them to `stops_cache.json`. Subsequent starts load from disk.

### 2. Start the frontend

```bash
cd frontend
npm install
npm start
```

Frontend runs on `http://localhost:3000`. Vite proxies `/api/*` and `/ws` to `localhost:3001`.

---

## Architecture

```
Browser
  │
  └─ HTTPS ──► CloudFront (ov.jarryd.co.za)
                 ├─ /api/* ──► API Gateway HTTP ──► Lambda (http_*)
                 ├─ /*    ──► S3 (React build)
                 └─ (WS)  ──► API Gateway WebSocket ──► Lambda (connect/disconnect/ws_message)
                                                         └─ DynamoDB (connections table)
```

### Lambda functions

| Function | Trigger | Purpose |
|---|---|---|
| `connect` | WS `$connect` | Writes connection record to DynamoDB |
| `disconnect` | WS `$disconnect` | Removes connection record from DynamoDB |
| `ws_message` | WS `$default` | Stores stop subscription in DynamoDB (future push path) |
| `http_stops` | `GET /api/stops/nearby` | Returns nearby stops from S3-cached GTFS data |
| `http_departures` | `GET /api/departures` | Returns departures with DynamoDB cache (14 s TTL) |
| `http_vehicles` | `GET /api/vehicles` | Returns vehicle positions with two-tier cache |
| `http_journey` | `GET /api/journey` | Journey planning via Nominatim + Motis |
| `http_trip` | `GET /api/trip` | Returns trip stops for a vehicle (used by TripPanel + dead reckoning) |
| `refresh_stops` | EventBridge (03:00 UTC daily) | Downloads KV7 + openov-nl GTFS, merges, writes to S3 |

### Caching strategy

**Departures** — DynamoDB cache-aside (14 s TTL, 30 s DynamoDB auto-delete via TTL attribute). Cache key = sorted stop codes joined by comma. All Lambda containers share one OVapi call per stop group per 14 s.

**Vehicles** — Two-tier:
1. Per-container in-memory (5 s) — avoids S3 latency on warm containers
2. S3 shared (`vehicles_cache.json`, 8 s TTL) — one OVapi protobuf fetch per 8 s across all containers

**Stops** — S3 (`stops_cache.json`, 7-day in-memory TTL). Rebuilt daily by `refresh_stops` Lambda. Held in Lambda module memory across warm invocations.

### Departure data flow

Departures are fetched by the frontend via HTTP polling. The WebSocket is used for connection tracking only:

```
Frontend (every ~14 s)
  → GET /api/departures?stops=TPC1,TPC2
    → DynamoDB cache check (14 s TTL)
    → cache hit:  return immediately
    → cache miss: OVapi fetch → DynamoDB write (fire-and-forget) → return
```

The WebSocket `subscribe` message is accepted and stored in DynamoDB but does not trigger server push today — it is ready for a future push path.

---

## How it works

1. Browser requests GPS location
2. Frontend calls `GET /api/stops/nearby` to find nearby stops
3. Frontend polls `GET /api/departures?stops=...` every ~14 s for live departure data
4. Each departure is tagged `LIVE` (vehicle broadcasting GPS) or `SCHEDULED` (timetable only)
5. Live vehicle positions are fetched from the GTFS-RT protobuf feed every 2 s (client-side polling)
6. Clicking a stop on the map subscribes the departure board to that stop's departures
7. Tracking a departure draws its route on the map using Motis itinerary geometry
8. Clicking a vehicle marker shows its full route stops in a slide-in TripPanel
9. Vehicle positions are smoothly animated: 1.5s interpolation to GPS fix, then route-snapped dead reckoning along the vehicle's trip path
10. Dark/light theme toggle persists to localStorage

---

## API Endpoints

```
GET  /api/stops/nearby?lat=&lon=&radius=   Nearby stops (radius in km, default 1.5)
GET  /api/departures?stops=TPC1,TPC2       Live departures with DynamoDB cache
GET  /api/vehicles                         Live vehicle positions (GTFS-RT, two-tier cache)
GET  /api/journey?from=&to=                Journey planner (Motis + Nominatim geocoding)
GET  /api/journey?fromLat=&fromLon=&to=    Journey planner with exact boarding coordinates
GET  /api/trip?vehicleId=&line=             Vehicle trip stops (for TripPanel + route paths)

WSS  wss://ws.ov.jarryd.co.za
     → send: { type: 'subscribe', stopCodes: ['TPC1', 'TPC2'] }  (stored, no push yet)
```

---

## Stops data

The stops cache merges two GTFS sources:

| Source | Coverage | OVapi compatible |
|---|---|---|
| KV7 (`gtfs.ovapi.nl/govi/`) | Bus, tram, metro (regional operators) | Yes — 8-digit TPC codes |
| openov-nl (`gtfs.ovapi.nl/openov-nl/`) | Full NL network incl. NS rail, ferry | No — 7-digit stop IDs |

openov-nl stops within 15 m of a KV7 stop are deduplicated. The merged set gives full visual coverage on the map; only KV7 stops (8-digit TPC) are used for OVapi departure lookups.

---

## External APIs

| API | Purpose |
|---|---|
| `v0.ovapi.nl/tpc/{codes}` | Live departure data (GOVI license) |
| `gtfs.ovapi.nl/govi/gtfs-kv7-YYYYMMDD.zip` | KV7 stop data (bus/tram/metro TPC codes) |
| `gtfs.ovapi.nl/openov-nl/gtfs-openov-nl.zip` | Full NL GTFS (train, ferry, all operators) |
| `gtfs.ovapi.nl/nl/vehiclePositions.pb` | Live vehicle GPS (GTFS-RT protobuf) |
| `europe.motis-project.de/api/v1/plan` | Journey planning |
| `nominatim.openstreetmap.org` | Geocoding for journey planner |
| OpenFreeMap | Map tiles |

---

## Deploy

### Frontend

```bash
cd frontend
npm run build
aws s3 sync dist/ s3://komt-ie-frontend-886152100748/ --delete
aws cloudfront create-invalidation --distribution-id EELD59XYZNKO4 --paths "/*"
```

### Lambda backend

```bash
cd terraform
terraform apply
```

Terraform zips `lambda/` (including `node_modules/`) and uploads to all Lambda functions. On code-only changes this is the only command needed — Terraform detects the zip hash change automatically.

### Prime the stops cache (first deploy only)

```bash
aws lambda invoke --function-name komt-ie-refresh-stops \
  --region eu-west-1 /dev/null
```

After that, EventBridge runs it daily at 03:00 UTC automatically.

---

## Data License

OV data is provided under the **GOVI license** via OVapi.
- Source attribution required
- Data may not be stored for more than 30 minutes
- Not suitable for performance analysis of operators

---

## Known Issues

| # | Issue | Status |
|---|---|---|
| 1 | **NS/ferry departures unavailable** | openov-nl stops show on the map but have 7-digit IDs not recognised by OVapi. Clicking them falls back to nearby KV7 stops if available. |
| 2 | **Stops update only at zoom ≥ 13** | By design — the radius is meaningless at country scale. |
| 3 | **WebSocket push disabled** | WS `subscribe` is stored but not acted on. Departures use HTTP polling. The SQS→Lambda poll loop was disabled after AWS triggered recursive loop detection. |
| 4 | **`minutesUntil` is stale** | Computed at OVapi fetch time, not updated client-side. A "4'" departure could be "2'" by the time the user reads it. |
| 5 | **Stops cache cold start** | First request on a cold Lambda container loads stops from S3. No pre-warming configured. |
| 6 | **No offline support** | No service worker. Requires a network connection for all data. |
| 7 | **Journey planner covers all of Europe** | Motis is EU-wide; no NL filter is applied. |
| 8 | **First-load speed is zero** | Speed/bearing are computed from consecutive position deltas. On Lambda cold start, there are no previous positions, so speed is 0 for ~5 seconds until the next poll. |

---

## Roadmap

- [x] Live departure board with LIVE/SCHEDULED confidence indicator
- [x] Nearby stop detection via GPS
- [x] HTTP-polled departures with DynamoDB shared cache
- [x] Live vehicle dots on map (GTFS-RT), viewport-culled with smooth interpolation
- [x] Journey planner (Motis + Nominatim)
- [x] AWS Lambda deployment (API Gateway v2 + CloudFront + S3)
- [x] Pan-map stop discovery (moveend → fetch stops, zoom-adaptive radius)
- [x] Clickable stop markers — subscribe departure board to selected stop
- [x] Trip tracking — click departure → highlight vehicle + draw route on map
- [x] Route drawing — Motis leg geometry decoded and rendered as polyline
- [x] Journey selection — "Select this journey" from planner → subscribe + draw route
- [x] Save trips to localStorage with countdown
- [x] Merged KV7 + openov-nl stops (map shows full NL network)
- [x] Incremental stop marker updates (no flicker on stop selection)
- [x] Vehicle click → TripPanel showing route stops with timeline
- [x] Route-snapped dead reckoning (smooth vehicle movement along actual routes)
- [x] Speed/bearing computation from position deltas (GTFS-RT feed provides zeros)
- [x] Dark/light theme toggle with localStorage persistence
- [x] Comprehensive design system (CSS tokens, shadows, radii, animations)
- [x] Polished mobile-responsive UI
- [ ] Re-enable WebSocket push (server-push departures via SQS → poll Lambda)
- [ ] NS/ferry departure data (requires separate API integration)
- [ ] Push notifications when tracked bus is < 2 min away
- [ ] Zoom-aware stop search radius
- [ ] "Bus didn't come" report button
