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
| Backend | Node.js + Express + WebSocket |
| Infra | AWS (ECS Fargate, CloudFront, S3, ALB, Route53) |
| Data | OVapi + GTFS KV7 (GOVI) |
| Map tiles | OpenFreeMap |

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

Backend runs on `http://localhost:3001`.

On first start it downloads the KV7 GTFS stops file (~37 MB) and caches it to `stops_cache.json`. Subsequent starts load from disk.

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
  └─ HTTPS ──► CloudFront
                 ├─ /api/* ──► ALB ──► ECS Fargate (Node.js)
                 ├─ /ws   ──► ALB ──► ECS Fargate (WebSocket)
                 └─ /*    ──► S3 (React build)
```

- **ECS Fargate** (ARM64, 0.25 vCPU / 512 MB) — Express + WebSocket server
- **S3 + CloudFront** — static frontend with SPA fallback (403/404 → index.html)
- **ACM + Route53** — HTTPS certificate for `ov.jarryd.co.za`
- All infra is in `terraform/`

### Shared poll registry

Multiple users watching the same stops share **one** OVapi call every 15 s — not one per user.

```
pollGroups: Map<key, { stopCodes, interval, subscribers: Set<ws> }>
```

1000 users at Amsterdam Centraal = 1 OVapi request per 15 s.

---

## How it works

1. Browser requests GPS location
2. Frontend opens a WebSocket and subscribes to the nearest stop codes
3. Map `moveend` event also fetches stops for whatever area the user is viewing
4. Backend polls OVapi every 15 s and broadcasts to all subscribers of those stops
5. Each departure is tagged `LIVE` (vehicle broadcasting GPS) or `SCHEDULED` (timetable only)
6. Live vehicle positions are fetched from the GTFS-RT protobuf feed every 15 s

---

## API Endpoints

```
GET  /health                              ALB health check
GET  /api/health                          App health (pollGroups, connectedClients)
GET  /api/stops/nearby?lat=&lon=&radius=  Nearby stops (radius in km, default 0.5)
GET  /api/departures?stops=TPC1,TPC2      Live departures for given stop codes
GET  /api/vehicles                        Live vehicle positions (GTFS-RT)
GET  /api/journey?from=&to=               Journey planner (Motis + Nominatim)

WS   /ws                                  WebSocket for live departure updates
     → send: { type: 'subscribe', stopCodes: ['TPC1', 'TPC2'] }
     ← recv: { type: 'departures', departures: [...] }
     → send: { type: 'unsubscribe' }
```

---

## External APIs

| API | Purpose |
|---|---|
| `v0.ovapi.nl/tpc/{codes}` | Live departure data (GOVI license) |
| `gtfs.ovapi.nl/govi/gtfs-kv7-YYYYMMDD.zip` | KV7 stop data with correct OVapi timing point codes |
| `gtfs.ovapi.nl/nl/vehiclePositions.pb` | Live vehicle GPS (GTFS-RT protobuf) |
| `europe.motis-project.de/api/v1/plan` | Journey planning |
| `nominatim.openstreetmap.org` | Geocoding for journey planner |
| OpenFreeMap | Map tiles |

### Why KV7, not `/nl/gtfs-nl.zip`?

The generic GTFS zip uses different stop IDs (e.g. `2992167`) that OVapi does not recognise — it returns HTTP 404 or empty arrays. The KV7 feed (`/govi/`) uses the correct timing point codes for bus, tram, and metro. It is also 37 MB vs 216 MB, making Docker build pre-seeding practical.

**Limitation:** KV7 covers bus/tram/metro only. NS train stops are not included.

---

## Terraform deploy

```bash
cd terraform
terraform init
terraform apply

# After apply, push new backend image:
aws ecr get-login-password --region eu-west-1 | \
  docker login --username AWS --password-stdin <ECR_URL>
docker build --platform linux/arm64 -t komt-ie-backend .
docker tag komt-ie-backend:latest <ECR_URL>:latest
docker push <ECR_URL>:latest
aws ecs update-service --cluster komt-ie-cluster \
  --service komt-ie-backend --force-new-deployment --region eu-west-1

# After apply, push new frontend build:
npm run build --prefix frontend
aws s3 sync frontend/dist/ s3://<BUCKET>/ --delete
aws cloudfront create-invalidation --distribution-id <CF_ID> --paths "/*"
```

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
| 1 | **NS trains not shown** | KV7 GTFS does not include NS rail stops. Train departure data requires a separate NS API integration. |
| 2 | **Stops update only at zoom >= 13** | Panning while zoomed out does not refresh stops. By design — the radius (0.5 km) is meaningless at country scale. |
| 3 | **Stop radius is fixed at 500 m** | The `/stops/nearby` call always uses a 500 m radius regardless of zoom level. Dense cities show many stops; rural areas may show none. |
| 4 | **GTFS-RT vehicle positions are Netherlands-wide** | `/api/vehicles` fetches all vehicles in NL every 15 s. The frontend renders every dot regardless of viewport, which can be slow on low-end devices when many vehicles are present. |
| 5 | **Journey planner covers all of Europe** | Motis covers EU-wide transit. No filtering is applied to keep results within NL. |
| 6 | **No offline support** | The app requires a network connection. There is no service worker or caching of departure data. |
| 7 | **WebSocket reconnect drops subscription** | On reconnect, `useOVWebSocket` re-subscribes automatically, but there is a brief gap (up to the 3 s reconnect delay) where no departures are received. |
| 8 | **Stops cache expires at midnight** | The KV7 GTFS filename includes today's date. If the container runs past midnight, the cached stops are still valid for 24 h, but the next refresh will correctly fetch the new day's file. |

---

## Roadmap

- [x] Live departure board with LIVE/SCHEDULED confidence indicator
- [x] Nearby stop detection via GPS
- [x] WebSocket real-time updates with shared poll registry
- [x] Live vehicle dots on map (GTFS-RT)
- [x] Journey planner (Motis + Nominatim)
- [x] AWS deployment (ECS Fargate + CloudFront + S3)
- [x] Pan-map stop discovery (moveend → fetch stops)
- [ ] NS train integration
- [ ] Filter vehicle markers to current viewport
- [ ] Zoom-aware stop search radius
- [ ] Push notifications (iOS)
- [ ] "Bus didn't come" report button
