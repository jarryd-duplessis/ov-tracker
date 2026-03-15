# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Backend (`cd backend`)
```bash
npm install        # install dependencies
npm run dev        # start with nodemon (auto-reload)
npm start          # start without auto-reload
```
Backend runs on `http://localhost:3001`. On first start it downloads the GTFS stops file (~200MB) and caches it to `stops_cache.json`.

### Frontend (`cd frontend`)
```bash
npm install        # install dependencies
npm start          # start Vite dev server
npm run build      # production build
npm run preview    # preview production build
```
Frontend runs on `http://localhost:3000`.

There are no test suites in this project.

## Architecture

**Komt ie?** is a live Dutch public transport tracker. The core value proposition is showing whether a departure is `LIVE` (vehicle broadcasting a GPS position) vs `SCHEDULED` (timetable only).

### Data flow

1. Frontend requests browser GPS → calls `GET /api/stops/nearby` → opens WebSocket → sends `{ type: 'subscribe', stopCodes: [...] }`
2. Backend per-client interval (15s) polls OVapi → parses response → pushes `{ type: 'departures', departures: [...] }` over WebSocket
3. Frontend updates the map and departure board in real time

### Backend modules

- **`server.js`** — Express + WebSocket server. Manages per-client subscriptions in `clientSubscriptions` Map (ws → `{ stopCodes, interval }`). Also has REST endpoints for `/departures`, `/vehicles`, and `/journey` (journey planner via Motis + Nominatim geocoding).
- **`ovapi.js`** — OVapi client. `parseTpcResponse` converts raw OVapi passtime objects into clean departure objects. `confidence` field is `'live'` or `'scheduled'` based on whether `RealtimeArrival` is present.
- **`stops.js`** — GTFS stop data. Downloads `stops.txt` from OVapi on first run, caches to disk (`stops_cache.json`) and in memory, refreshes every 24h. `findNearbyStops` uses Haversine distance.
- **`vehicles.js`** — Fetches live vehicle positions from GTFS-RT protobuf feed (`vehiclePositions.pb`). Uses `routes.txt` (bundled in repo) to enrich with line name and color.

### Frontend modules

- **`App.jsx`** — Root component. Owns `userLocation`, `nearbyStops`, and mode (`nearby` | `journey`). Calls `useOVWebSocket` and wires location → stop fetch → WebSocket subscription.
- **`useOVWebSocket.js`** — Custom hook managing a single WebSocket connection with auto-reconnect (3s delay). Exposes `{ departures, connected, lastUpdate, error, subscribe }`.
- **`Map.jsx`** — MapLibre GL JS map showing user location, nearby stop markers, and departures.
- **`DepartureBoard.jsx`** — Sidebar departure list; shows line, destination, minutes until arrival, and LIVE/SCHEDULED badge.
- **`JourneyPlanner.jsx`** — Journey planning UI; calls backend `/journey` endpoint.

### Vite proxy

Frontend proxies `/api/*` → `http://localhost:3001` and `/ws` → `ws://localhost:3001`, so all fetch/WebSocket calls use relative paths in frontend code.

### External APIs

| API | Purpose |
|-----|---------|
| `v0.ovapi.nl/tpc/{codes}` | Live departure data (GOVI license — data must not be stored >30 min) |
| `gtfs.ovapi.nl/new/stops.txt` | All Dutch OV stops with coordinates |
| `gtfs.ovapi.nl/nl/vehiclePositions.pb` | Live vehicle GPS positions (GTFS-RT protobuf) |
| `europe.motis-project.de/api/v1/plan` | Journey planning |
| `nominatim.openstreetmap.org` | Geocoding for journey planner |
| OpenFreeMap | Map tiles |
