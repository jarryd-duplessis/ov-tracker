# lambda/lib/vehicles.js — GTFS-RT Vehicle Positions

## Role
Fetches live vehicle positions from the OVapi GTFS-RT protobuf feed and enriches them with route metadata (line name, transport category, colour) from the bundled `routes.txt`. Computes speed and bearing from consecutive position deltas, as the Dutch GTFS-RT feed provides zero for both fields. Implements a two-tier cache so all concurrent Lambda containers share a single upstream OVapi call per 8 seconds.

## External API
`https://gtfs.ovapi.nl/nl/vehiclePositions.pb`

- Protocol: HTTPS
- Format: GTFS-RT protobuf (`FeedMessage` → `FeedEntity[]` → `VehiclePosition`)
- Rate limits: unofficial; frequently returns `429 Too Many Requests`
- License: GOVI

## Functions

### `getVehiclePositions()`
Returns `{ vehicles: Vehicle[], fetchedAt: number }`. Checks the two-tier cache in order:

**Tier 1 — in-memory** (5 s TTL): Per-container module-level variable `vehicleCache`. Zero latency; works across warm Lambda invocations for the same container.

**Tier 2 — S3 shared** (`vehicles_cache.json`, 8 s TTL): Read from S3 on in-memory miss. Shared across all Lambda containers so at most one OVapi protobuf fetch occurs per 8 s regardless of concurrency.

**Tier 3 — OVapi fetch**: On S3 miss, fetches the protobuf, decodes with `gtfs-realtime-bindings`, enriches with route data, updates both caches (S3 write is fire-and-forget).

On non-2xx response:
- If `vehicleCache.vehicles.length > 0` → returns stale in-memory cache (graceful degradation)
- If cache is empty → throws (handler returns HTTP 500 to client)

The `fetchedAt` field in the return value is the timestamp of the actual OVapi fetch (not the response time), so callers can echo it to clients for cache-age debugging.

### `loadRoutes()`
Reads `routes.txt` from the Lambda package directory once on first call, caches in `routesCache` for the container lifetime. Maps `route_id` → `{ shortName, category, color }`.

### `routeTypeToCategory(type)`
Maps GTFS `route_type` integer to a category string:
| GTFS type | Category |
|---|---|
| 0, 900 | TRAM |
| 1 | SUBWAY |
| 2, 100–199 | RAIL |
| 4 | FERRY |
| 3, 700–799, other | BUS |

### `computeBearing(lat1, lon1, lat2, lon2)`
Computes the initial bearing between two points in degrees (0-360). Uses the standard forward azimuth formula.

### `haversineM(lat1, lon1, lat2, lon2)`
Returns the great-circle distance in meters between two lat/lon points.

### Speed/bearing computation (in parsing loop)
For each vehicle entity, if the feed reports `speed === 0` and a previous position exists for the same entity ID:
- Computes elapsed time since last observation
- If 0.5s < dt < 120s and distance > 2m:
  - `speed = distance / dt` (capped at 50 m/s)
  - `bearing = computeBearing(prev, current)`
- Previous positions are stored in a module-level `prevPositions` object keyed by entity ID

### `parseCSVLine(line)`
RFC 4180-compliant CSV field parser (same pattern as `lib/stops.js`).

## Vehicle object shape
```js
{
  id: string,           // GTFS-RT entity ID
  lat: number,
  lon: number,
  bearing: number,      // degrees (0-360), computed from position deltas (feed provides 0)
  speed: number,        // m/s, computed from position deltas (feed provides 0)
  routeId: string,
  tripId: string,       // used by frontend to match tracked departures
  line: string,         // route_short_name from routes.txt
  category: string,     // 'BUS' | 'TRAM' | 'SUBWAY' | 'RAIL' | 'FERRY'
  color: string,        // hex color from routes.txt, e.g. '#4CAF50'
}
```

## Cache structure
```js
// Tier 1 — in-memory (per container)
let vehicleCache = { vehicles: Vehicle[], fetchedAt: number }
const MEM_TTL = 5000  // ms

// Tier 2 — S3 shared (across containers)
S3 key: 'vehicles_cache.json'
S3 body: { vehicles: Vehicle[], fetchedAt: number }
const S3_TTL = 8000  // ms
```

## routes.txt
Bundled static file in `lambda/`. Sourced from the GTFS-NL dataset. Maps every Dutch OV `route_id` to its short name, type, and brand colour. Not updated automatically — requires manual refresh when routes change significantly.

## Known Issues
- **429s from OVapi** — The GTFS-RT feed occasionally rate-limits. Stale positions are served from in-memory cache silently. Under sustained 429s, positions could lag longer than 8 s.
- **S3 write contention** — Multiple containers may simultaneously read a stale S3 cache, all fetch from OVapi, and all try to write. Writes are last-writer-wins; no data loss, but extra OVapi calls occur briefly.
- **`routes.txt` is static** — New routes, renumberings, or colour changes are not reflected until the file is manually updated and Lambda redeployed.
- **`routesCache` is never invalidated** — Read once at first call, held for the container lifetime. A `routes.txt` change requires a Lambda deployment.
- **First-poll speed is zero** — Speed/bearing are computed from consecutive position deltas. On Lambda cold start, `prevPositions` is empty, so the first response has speed=0 and bearing=0 for all vehicles. Subsequent polls (every ~5s) have computed values.
- **In-memory cache shared within container only** — The 5 s Tier 1 cache benefits warm containers; cold containers always pay the S3 latency.

## Planned Changes
- **Retry on 429** — Back off and retry once after 2 s before serving stale data.
- **Auto-refresh `routes.txt`** — Periodically re-download routes from GTFS-NL so line metadata stays current without manual deployments.
- **Null bearing handling** — Expose a `hasBearing: boolean` field so the map can render a circle instead of a directional arrow when bearing is unknown.
