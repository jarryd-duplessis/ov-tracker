# NS API Integration Spec

**Date:** 2026-03-21
**API Key:** Stored in `.env` as `NS_API`
**Base URL:** `https://gateway.apiportal.ns.nl`
**Auth:** `Ocp-Apim-Subscription-Key` header

---

## Available Endpoints (verified working)

| Endpoint | URL | Cache | Purpose |
|----------|-----|-------|---------|
| Departures | `GET /reisinformatie-api/api/v2/departures?station={code}` | 5s | Real-time departures with delays, platforms, cancellations |
| Arrivals | `GET /reisinformatie-api/api/v2/arrivals?station={code}` | 5s | Real-time arrivals |
| Stations | `GET /reisinformatie-api/api/v2/stations` | Static | 744 stations (397 NL) with codes, lat/lng, platform lists |
| Disruptions | `GET /reisinformatie-api/api/v3/disruptions` | Dynamic | Active disruptions + planned maintenance with severity, affected stations |
| Disruptions/station | `GET /reisinformatie-api/api/v3/disruptions/station/{code}` | Dynamic | Disruptions for specific station |
| Trip Planning | `GET /reisinformatie-api/api/v3/trips?fromStation={}&toStation={}` | Dynamic | Multi-leg journeys with crowd forecast |
| Journey Detail | `GET /reisinformatie-api/api/v2/journey?train={number}` | Dynamic | Full route of a running train with per-stop delays |
| Virtual Train | `GET /virtual-train-api/api/v1/trein` | 60s | Rolling stock composition for ~4,000 trains |
| Rail Map | `GET /Spoorkaart-API/api/v1/spoorkaart` | Static | GeoJSON track geometry (700 segments) |
| OV-fiets | `GET /places-api/v2/ovfiets` | Dynamic | Bike rental locations with real-time availability |

---

## Phase 1: NS Departures (Priority — solves the train station gap)

### Problem
openov-nl stops (7-digit IDs) show train stations on the map but OVapi only accepts 8-digit KV7 TPCs. Clicking a train station shows no departures or falls back to nearby bus stops.

### Solution
Use the NS Departures API for stations identified as train stations.

### Implementation

#### 1. Station Code Mapping
During `refresh_stops.js`, build a mapping from openov-nl stop IDs to NS station codes:
- Download NS stations list (`/reisinformatie-api/api/v2/stations`)
- For each NS station, find the closest openov-nl stop within 200m using lat/lng
- Store as `ns_station_mapping.json` in S3: `{ "openov_stop_id": "NS_code", ... }`

#### 2. Departure Fetcher
New function in `lib/ovapi.js` (or new `lib/ns.js`):
```javascript
async function getNSDepartures(stationCode) {
  const res = await fetch(
    `https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/departures?station=${stationCode}`,
    { headers: { 'Ocp-Apim-Subscription-Key': process.env.NS_API } }
  );
  const data = await res.json();
  return data.payload.departures.map(dep => ({
    line: dep.product.shortCategoryName || dep.trainCategory,
    destination: dep.direction,
    plannedTime: dep.plannedDateTime,
    expectedTime: dep.actualDateTime || dep.plannedDateTime,
    delay: Math.round((new Date(dep.actualDateTime) - new Date(dep.plannedDateTime)) / 60000),
    platform: dep.actualTrack || dep.plannedTrack,
    platformChanged: dep.actualTrack !== dep.plannedTrack,
    cancelled: dep.cancelled,
    status: dep.departureStatus, // ON_STATION, INCOMING, DEPARTED
    operator: dep.product.operatorName,
    trainNumber: dep.product.number,
    transportType: 'TRAIN',
    routeStations: dep.routeStations?.map(s => s.mediumName) || [],
    messages: dep.messages?.map(m => m.message) || [],
    confidence: 'live', // NS API is always real-time
    source: 'NS',
  }));
}
```

#### 3. Update `http_departures.js`
- On request, check if any requested stop code maps to an NS station
- If so, fetch NS departures in parallel with OVapi departures
- Merge results, sort by expectedTime
- Cache in DynamoDB (same 14s TTL)

#### 4. Frontend: Platform Change Indicator
In `DepartureBoard.jsx`, show platform changes:
```jsx
{dep.platformChanged && (
  <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
    Spoor {dep.platform} ⚠️
  </span>
)}
```

#### 5. Frontend: Cancelled Train Indicator
```jsx
{dep.cancelled && (
  <span style={{ color: 'var(--red)', fontWeight: 600, textDecoration: 'line-through' }}>
    Cancelled
  </span>
)}
```

### Data Fields Gained
| Field | Source | Value |
|-------|--------|-------|
| Real-time delay | `actualDateTime - plannedDateTime` | Seconds precision |
| Platform changes | `actualTrack !== plannedTrack` | Alert user |
| Cancellations | `cancelled: true` | Strike-through display |
| Departure status | `ON_STATION` / `INCOMING` / `DEPARTED` | Status indicator |
| Route stations | `routeStations[]` | Show calling points |
| Service messages | `messages[]` | "Stopt niet in..." |

---

## Phase 2: Disruptions Overlay

### Implementation
- New Lambda: `http_disruptions.js`
  - Fetches `GET /reisinformatie-api/api/v3/disruptions?isActive=true`
  - Returns affected station coordinates for map rendering
  - Caches in DynamoDB (60s TTL)
- Frontend: draw affected route segments in red/orange on the map
- Show disruption banners in the departure board when a disruption affects the selected station

### API Response Key Fields
```json
{
  "type": "DISRUPTION",
  "isActive": true,
  "impact": { "value": 3 },  // 1-5 severity
  "publicationSections": [{
    "section": {
      "stations": [{ "stationCode": "GN", "coordinate": { "lat": 53.21, "lng": 6.56 } }]
    },
    "consequence": {
      "description": "Geen treinen",
      "level": "NO_OR_MUCH_LESS_TRAVEL_OPTIONS"
    }
  }]
}
```

---

## Phase 3: Train Journey Detail

### Implementation
- When user tracks a train departure, fetch `GET /reisinformatie-api/api/v2/journey?train={number}`
- Show in TripPanel: full route with per-stop delays, crowd forecast, rolling stock
- Display train facilities (wifi, power, bike, quiet coach)

### Key Data
- Per-stop: `delayInSeconds`, `plannedTrack`, `actualTrack`, `cancelled`
- Stock: `trainType`, `numberOfSeats`, `numberOfParts`, `facilities[]`
- `crowdForecast`: `LOW`, `MEDIUM`, `HIGH` per stop

---

## Phase 4: Rail Network Geometry

### Implementation
- During `refresh_stops.js`, download Spoorkaart GeoJSON (846 KB, 700 segments)
- Store as `rail_network.json` in S3
- Frontend: render as a subtle rail line layer on the map (below vehicle markers)
- Use for more accurate train route drawing (currently uses stop-to-stop straight lines)

---

## Phase 5: OV-fiets Availability

### Implementation
- New endpoint: `GET /api/ovfiets?station={code}`
- Show bike count badge on station markers
- In journey planner results, show "X bikes available" for last-mile cycling legs

---

## Cost Impact

NS API is free. No additional AWS costs except:
- DynamoDB cache writes for NS departures (minimal, same pattern as OVapi)
- Lambda invocation time (~50ms per NS API call)
- Estimated: < $1/month additional at any traffic level

---

## Environment Setup

```bash
# .env
NS_API=7f23101806de4bebb5fbac8f959cc1da
```

Lambda needs `NS_API` as environment variable (add to Terraform).
