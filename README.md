# 🚌 Komt ie?

> Live Dutch public transport tracker — see if your bus or tram is actually coming.

The core problem: 9292 shows a bus is due in 3 minutes. The bus doesn't show up.
**Komt ie?** shows you live vehicle positions and flags whether a departure is broadcasting a real position (`LIVE`) or just a timetable entry (`SCHEDULED`).

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + MapLibre GL JS |
| Backend | Node.js + Express + WebSocket |
| Data | OVapi (free, CC-0) |
| Map tiles | OpenFreeMap (free) |

---

## Getting Started

### Prerequisites
- Node.js 18+
- npm

### 1. Start the backend

```bash
cd backend
npm install
npm run dev
```

Backend runs on `http://localhost:3001`

On first start it downloads the GTFS stops file (~200MB) and caches it locally.
Subsequent starts use the disk cache.

### 2. Start the frontend

```bash
cd frontend
npm install
npm start
```

Frontend runs on `http://localhost:3000`

---

## How it works

1. Browser requests user's GPS location
2. Frontend calls `GET /api/stops/nearby?lat=&lon=` to find nearby stops
3. Frontend opens a WebSocket connection and subscribes to those stop codes
4. Backend polls OVapi every 15 seconds for live departure data
5. Each departure is tagged as `LIVE` (vehicle broadcasting position) or `SCHEDULED` (timetable only)
6. Frontend updates the map and departure board in real time

---

## API Endpoints

```
GET  /health                           Health check
GET  /stops/nearby?lat=&lon=&radius=   Find nearby stops (radius in km)
GET  /departures?stops=TPC1,TPC2       Get live departures for stops

WS   /                                 WebSocket for live updates
     → send: { type: 'subscribe', stopCodes: ['TPC1', 'TPC2'] }
     ← recv: { type: 'departures', departures: [...] }
```

---

## Data License

OV data is provided under the **GOVI license** via OVapi.
- Source attribution required
- Data may not be stored for more than 30 minutes
- Not suitable for performance analysis of operators

---

## Roadmap

- [x] Live departure board with confidence indicator
- [x] Nearby stop detection via GPS
- [x] WebSocket real-time updates
- [ ] Live vehicle dots on map (GTFS-RT vehicle positions)
- [ ] NS train integration
- [ ] Push notifications (iOS)
- [ ] "Bus didn't come" report button
- [ ] Ad integration (Google AdSense / AdMob)
