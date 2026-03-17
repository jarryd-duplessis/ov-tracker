# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Local dev backend (`cd backend`)
```bash
npm install        # install dependencies
npm run dev        # start with nodemon (auto-reload)
npm start          # start without auto-reload
```
Backend runs on `http://localhost:3001`. On first start it downloads and merges KV7 + openov-nl GTFS stops and caches to `stops_cache.json`.

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

There are no test suites in this project.

## Architecture

**Komt ie?** is a live Dutch public transport tracker. The core value proposition is showing whether a departure is `LIVE` (vehicle broadcasting a GPS position) vs `SCHEDULED` (timetable only).

### Production: Lambda + API Gateway v2

```
Browser → CloudFront → API Gateway HTTP → Lambda (http_*)
       → CloudFront → S3 (React build)
       → API Gateway WebSocket → Lambda (connect/disconnect/ws_message)
```

### Data flow

1. Frontend requests GPS → calls `GET /api/stops/nearby` → renders stop markers on map
2. Frontend polls `GET /api/departures?stops=TPC1,TPC2` every ~14 s
3. `http_departures` Lambda checks DynamoDB cache (14 s TTL) → on miss fetches OVapi and writes cache (fire-and-forget)
4. Frontend updates departure board in real time
5. WebSocket is open for future server-push; subscribe messages are stored in DynamoDB but not acted on today

### Lambda modules (`lambda/`)

- **`http_stops.js`** — Returns nearby stops from S3-cached GTFS data.
- **`http_departures.js`** — Cache-aside with DynamoDB (14 s TTL). On miss: fetches OVapi, writes cache fire-and-forget.
- **`http_vehicles.js`** — Returns vehicle positions. Delegates to `lib/vehicles.js` for two-tier cache (in-memory 5 s + S3 8 s).
- **`http_journey.js`** — Geocodes via Nominatim → fetches Motis itineraries. Accepts `fromLat`/`fromLon` to bypass geocoding for known stop coordinates.
- **`http_trip.js`** — Returns trip stops for a vehicle. Accepts `vehicleId` and optional `line` param. Used by TripPanel and for route-snapped dead reckoning path data.
- **`connect.js` / `disconnect.js`** — WS lifecycle; read/write DynamoDB `connections` table.
- **`ws_message.js`** — Stores subscribe payload in DynamoDB. No active push (SQS loop disabled).
- **`refresh_stops.js`** — Downloads KV7 + openov-nl GTFS, merges (KV7-first, dedup at 15 m), writes `stops_cache.json` to S3. Triggered by EventBridge daily at 03:00 UTC.
- **`lib/ovapi.js`** — OVapi client + parser. `confidence: 'live'` when `RealtimeArrival` present.
- **`lib/stops.js`** — S3-backed stops cache. Module-level in-memory cache across warm invocations.
- **`lib/vehicles.js`** — Two-tier vehicle cache. Computes speed and bearing from consecutive position deltas (the Dutch GTFS-RT feed provides zero for both). Returns `{ vehicles, fetchedAt }`.

### Frontend modules (`frontend/src/`)

- **`App.jsx`** — Root component. Owns `userLocation`, `nearbyStops`, `journeyRoute`, `mapCenter`, `trackedDeparture`, `savedTrips`, `selectedVehicle`, `theme`, mode (`nearby` | `journey` | `saved`). `userSelectedStopRef` prevents GPS/pan overrides after explicit stop selection. `routeEpochRef` invalidates in-flight route fetches on stop/vehicle clicks. Dark/light theme toggle persisted to localStorage.
- **`useOVWebSocket.js`** — Manages WS connection + auto-reconnect. Exposes `{ departures, connected, lastUpdate, error, subscribe }`. Filters to KV7 stops only (≥ 8-digit TPC) before sending to OVapi.
- **`Map.jsx`** — MapLibre GL JS map with dark/light tile switching. Incremental stop marker updates (keyed by TPC, no flicker). Route polyline from Motis leg geometry. Vehicle animation system: smooth GPS interpolation (1.5s) → route-snapped dead reckoning along fetched trip paths. `userInitiated` flag prevents programmatic flyTo from re-triggering stop fetches.
- **`DepartureBoard.jsx`** — Departure list. Tracked rows show expanded panel ("Route shown on map" + "Stop tracking" button). Filter tabs auto-reset when transport types change.
- **`JourneyPlanner.jsx`** — Journey search. "Select this journey" button switches to map view and draws route.
- **`SavedTrips.jsx`** — Starred trips persisted in localStorage with 30 s countdown ticks.
- **`TripPanel.jsx`** — Slide-in panel showing a vehicle's route stops with timeline visualization. Fetches from `/api/trip`. Shown when a vehicle marker is clicked on the map.

### Vite proxy (local dev)

Frontend proxies `/api/*` → `http://localhost:3001` and `/ws` → `ws://localhost:3001`.

### External APIs

| API | Purpose |
|-----|---------|
| `v0.ovapi.nl/tpc/{codes}` | Live departure data (GOVI license — data must not be stored >30 min) |
| `gtfs.ovapi.nl/govi/gtfs-kv7-YYYYMMDD.zip` | KV7 bus/tram/metro stops (OVapi TPC codes) |
| `gtfs.ovapi.nl/openov-nl/gtfs-openov-nl.zip` | Full NL GTFS incl. NS rail and ferry |
| `gtfs.ovapi.nl/nl/vehiclePositions.pb` | Live vehicle GPS positions (GTFS-RT protobuf) |
| `europe.motis-project.de/api/v1/plan` | Journey planning |
| `nominatim.openstreetmap.org` | Geocoding for journey planner |
| OpenFreeMap | Map tiles |
