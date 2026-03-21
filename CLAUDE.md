# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Frontend (`cd frontend`)
```bash
npm install        # install dependencies
npm start          # start Vite dev server
npm run build      # production build
npm run preview    # preview production build
```
Frontend runs on `http://localhost:3000`.

### Lambda deploy (`cd terraform`)
```bash
terraform apply    # zip lambda/, update all Lambda functions, wire API Gateway
```

To force-deploy Lambda code when terraform doesn't detect changes:
```bash
cd lambda && python3 -c "
import zipfile, os
with zipfile.ZipFile('/tmp/lambda_deploy.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk('.'):
        dirs[:] = [d for d in dirs if d != '.cache']
        for f in files:
            fp = os.path.join(root, f)
            z.write(fp, os.path.relpath(fp, '.'))
"
aws lambda update-function-code --function-name komt-ie-FUNCTION_NAME --zip-file fileb:///tmp/lambda_deploy.zip
```

### Rebuild trip index
```bash
aws lambda invoke --function-name komt-ie-refresh-stops --payload '{}' /tmp/out.json --cli-read-timeout 900
```
Takes ~5 minutes. Processes 875K+ trips across 3,170 routes. Uses batched S3 uploads to stay under the 3GB memory limit.

There are no test suites in this project.

## Architecture

**Komt ie?** is a live Dutch public transport tracker with a separated ingestion/serving pipeline.

### Production stack

```
[EventBridge 1min] → [ingest_vehicles Lambda] → [S3 tiles + events]
                          ↑ GTFS-RT protobuf         ↓
                                              [CloudFront (3s cache)]
                                                      ↓
Browser → CloudFront → API Gateway HTTP → Lambda → S3 tile read
       → CloudFront → S3 (React build)
```

### Data pipeline

**Ingestion (server-side, every ~10s):**
1. `ingest_vehicles` Lambda runs continuously (EventBridge 1min trigger, internal 10s loop)
2. Fetches GTFS-RT protobuf from OVapi
3. Computes bearing/speed from consecutive position deltas (feed provides zeros)
4. Computes 5-tier confidence: `live` (<15s) / `recent` (<1min) / `estimated` (<5min) / `scheduled` / `unknown`
5. Buckets vehicles into geographic tiles (0.1° lat × 0.15° lon ≈ 11km × 10km)
6. Writes ~280 tile files + manifest to S3
7. Persists raw events to S3 for analytics (`events/YYYY/MM/DD/HH-MM.json`)
8. Saves `prevPositions` to S3 for speed computation across Lambda invocations

**Serving:**
1. `http_vehicles` reads pre-computed tiles from S3, filters by viewport bbox
2. CloudFront caches responses for 3s — all users viewing same area share cached tile
3. Frontend polls every 5s (pauses after 30s idle, pauses when tab hidden)
4. Client-side animation smooths movement with 4s interpolation + 20s dead reckoning along route shapes

**Departures:**
1. Frontend polls `GET /api/departures?stops=TPC1,TPC2` every 15s
2. Lambda checks DynamoDB cache (14s TTL) → on miss fetches OVapi
3. OVapi provides KV6-derived status: `DRIVING`, `ARRIVED`, `DEPARTED`, `PLANNED`, `UNKNOWN`
4. Delay computed from `ExpectedDepartureTime - TargetDepartureTime`

**Daily refresh (03:00 UTC):**
1. `refresh_stops` Lambda downloads KV7 + openov-nl GTFS
2. Merges stops (KV7-first, dedup at 15m) → `stops_cache.json`
3. Builds trip index: ALL journeys per route (not just representative trips)
4. Batched S3 uploads (200 routes at a time) to stay under 3GB memory limit
5. Outputs: `trips/{operator}_{route}.json` with stops + shapes, `line_index.json`

### Lambda modules (`lambda/`)

- **`ingest_vehicles.js`** — Background ingestion pipeline. EventBridge trigger every 1 min, loops at 10s internally. Fetches GTFS-RT, computes bearing/speed/confidence, writes geographic tiles to S3, persists raw events. Maintains `prevPositions` in S3 for speed computation across invocations.
- **`http_vehicles.js`** — Serves vehicle positions from pre-computed S3 tiles. Supports `?bbox=south,west,north,east` for viewport filtering and `/{id}` for single vehicle lookup. Falls back to direct GTFS-RT fetch if tiles unavailable.
- **`http_stops.js`** — Returns nearby stops (`?lat=&lon=&radius=`) or searches by name (`?q=`). S3-backed with 7-day in-memory cache.
- **`http_departures.js`** — Cache-aside with DynamoDB (14s TTL). On miss: fetches OVapi, writes cache fire-and-forget.
- **`http_journey.js`** — Geocodes via Nominatim → fetches Motis itineraries. Accepts `fromLat/fromLon` and `toLat/toLon` to bypass geocoding for transit stop coordinates.
- **`http_trip.js`** — Returns trip stops + shape for a vehicle. Used by TripPanel and route visualization.
- **`refresh_stops.js`** — Daily GTFS refresh. Downloads KV7 + openov-nl, builds trip index with all journeys, batched S3 uploads.
- **`lib/ovapi.js`** — OVapi client. Parses `TripStopStatus` (DRIVING/ARRIVED/DEPARTED/PLANNED), computes delay from departure times.
- **`lib/stops.js`** — Stop loading, nearby search (haversine + 10m dedup), name search (scored ranking).
- **`lib/trips.js`** — Trip index building. KV7 (timing stops only) + openov-nl (complete stop lists). Batched flush to S3 to avoid OOM with 875K trips.
- **`lib/vehicles.js`** — Legacy two-tier vehicle cache (memory 3s + S3 3s). Used as fallback when tiles unavailable.

### Frontend modules (`frontend/src/`)

- **`App.jsx`** — Root component. Key state: `userLocation`, `nearbyStops`, `selectedStop`, `departureStop` (KV7 stop for OVapi), `trackedDeparture`, `journeyRoute`, `selectedVehicle`, `mode`, `theme`. Idle/visibility detection pauses all polling. For 7-digit stops, fetches nearby stops to find the nearest 8-digit KV7 stop for departure data.
- **`useOVWebSocket.js`** — HTTP polling hook (15s interval, despite the name). Accepts `{ paused }` to stop polling when idle/hidden. Filters to KV7 stops (≥8-digit TPC).
- **`Map.jsx`** — MapLibre GL JS map. Vehicle animation: 4s smoothstep interpolation → 20s dead reckoning along route shapes (fallback 30 km/h). Viewport-filtered vehicle fetch (`?bbox=`). Idle detection pauses after 30s. Route visualization with stop markers, progress line (traveled vs remaining), and confidence-based styling. Zoom-only detection (doesn't reset stop selection).
- **`DepartureBoard.jsx`** — Departure list with KV6 status indicators (DRIVING/on time, ARRIVED/at stop, delayed +N'). "Full route on map" tracking panel. Transport mode filter tabs. Shows which KV7 stop departures come from when it differs from selected stop.
- **`JourneyPlanner.jsx`** — Journey search with transit stop autocomplete (searches stops API + Nominatim in parallel). Transit stops shown with bus icon, use exact coordinates (bypasses Nominatim geocoding that routed to wrong cities).
- **`TripPanel.jsx`** — Vehicle stop timeline with platform codes.
- **`SavedTrips.jsx`** — LocalStorage-persisted starred trips.
- **`BottomSheet.jsx`** — Mobile draggable sheet (peek/half/full snap).

### Key design decisions

- **Ingestion separated from serving** — `ingest_vehicles` Lambda writes to S3 on a schedule; `http_vehicles` Lambda reads from S3. Feed outages don't block user requests.
- **Geographic tiles** — Vehicles bucketed into ~280 tiles. CloudFront caches each tile for 3s. All users viewing the same area share the same cached response.
- **Idle detection** — All polling pauses after 30s of no map interaction or when the browser tab is hidden. Resumes immediately on interaction.
- **KV7 vs openov-nl** — KV7 stops (8+ digit TPC) work with OVapi for departures. openov-nl stops (7-digit) have complete route data but no departure data. When a 7-digit stop is clicked, the app finds the nearest 8-digit KV7 stop for departures.
- **Vehicle matching** — OVapi uses different operator codes (UOV) than GTFS-RT (CXX). Tracked departures match vehicles by journey number + line + geographic proximity (30km max). Falls back to any same-line vehicle nearby for route shape.
- **All journeys stored** — Trip index contains all 875K journeys (not just one representative per route). Stop times are always correct for the specific journey requested.

### External APIs

| API | Purpose |
|-----|---------|
| `v0.ovapi.nl/tpc/{codes}` | Live departure data for bus/tram/metro (KV6-derived) |
| `gtfs.ovapi.nl/nl/vehiclePositions.pb` | Live vehicle GPS positions (GTFS-RT protobuf) |
| `gtfs.ovapi.nl/govi/gtfs-kv7-YYYYMMDD.zip` | KV7 GTFS (timing stops, OVapi-compatible TPCs) |
| `gtfs.ovapi.nl/openov-nl/gtfs-openov-nl.zip` | Full NL GTFS (complete stops + shapes) |
| `gateway.apiportal.ns.nl` | NS API: train departures, disruptions, journey detail, stations, rail geometry, OV-fiets (key in .env) |
| `europe.motis-project.de/api/v1/plan` | Journey planning |
| `nominatim.openstreetmap.org` | Geocoding (fallback when no transit stop coordinates) |
| OpenFreeMap | Map tiles (dark/light themes) |

### Cost at scale

| DAU | Monthly cost |
|-----|-------------|
| 100 | ~$35 |
| 1,000 | ~$70 |
| 10,000 | ~$300 |

Key optimizations: viewport-filtered tiles (95% payload reduction), idle detection (80% fewer requests), CDN-cacheable tiles (shared across users), 5s poll interval.
