# vehicles.js — GTFS-RT Vehicle Positions

## Role
Fetches live vehicle positions from the OVapi GTFS-RT protobuf feed and enriches them with route metadata (line name, transport category, colour) from the bundled `routes.txt`. Provides an 8-second server-side cache so all concurrent client requests share a single upstream fetch.

## External API
`https://gtfs.ovapi.nl/nl/vehiclePositions.pb`

- Protocol: HTTPS
- Format: GTFS-RT protobuf (`FeedMessage` → `FeedEntity[]` → `VehiclePosition`)
- Rate limits: unofficial; frequently returns `429 Too Many Requests`
- License: GOVI

## Functions

### `getVehiclePositions()`
Returns `Vehicle[]`. Checks the in-process cache first (TTL 8 s). On cache miss, fetches the protobuf, decodes with `gtfs-realtime-bindings`, enriches with route data, updates cache, and returns.

On non-2xx response:
- If stale cache exists → returns it with a `console.warn` (graceful degradation)
- If cache is empty → throws (server returns HTTP 500 to client)

### `loadRoutes()`
Reads `routes.txt` from `__dirname` once, caches in `routesCache`. Maps `route_id` → `{ shortName, category, color }`.

### `routeTypeToCategory(type)`
Maps GTFS `route_type` integer to a category string:
| GTFS type | Category |
|---|---|
| 0, 900 | TRAM |
| 1 | SUBWAY |
| 2, 100–199 | RAIL |
| 4 | FERRY |
| 3, 700–799, other | BUS |

### `parseCSVLine(line)`
RFC 4180-compliant CSV field parser (shared pattern with `stops.js`).

## Vehicle object shape
```js
{
  id: string,           // GTFS-RT entity ID
  lat: number,
  lon: number,
  bearing: number,      // degrees, 0 if not broadcast
  speed: number,        // m/s, 0 if not broadcast
  routeId: string,
  tripId: string,
  line: string,         // route_short_name from routes.txt
  category: string,     // 'BUS' | 'TRAM' | 'SUBWAY' | 'RAIL' | 'FERRY'
  color: string,        // hex color from routes.txt, e.g. '#4CAF50'
}
```

## Caching
```js
vehicleCache = { vehicles: Vehicle[], fetchedAt: number }
VEHICLE_CACHE_TTL = 5000  // ms
```
In-process only — resets on container restart. Cache is shared across all HTTP requests to `/api/vehicles`.

## routes.txt
Bundled static file in `backend/`. Sourced from the GTFS-NL dataset. Maps every Dutch OV `route_id` to its short name, type, and brand colour. Not updated automatically — must be manually refreshed when routes change.

## Known Issues
- **429s from OVapi** — the GTFS-RT feed occasionally rate-limits. Stale positions are served silently when this happens. Under normal conditions the 5 s TTL means positions are at most ~5 s stale. A server-side cache ensures all clients share one upstream request, keeping the overall request rate low enough to avoid sustained 429s.
- **`routes.txt` is static** — new routes, renumberings, or colour changes won't be reflected until the file is manually updated and the image rebuilt.
- **In-process cache only** — cache is not shared across ECS tasks. With horizontal scaling, each task makes independent upstream fetches.
- **No bearing/speed fallback** — vehicles that don't broadcast bearing show `bearing: 0` (pointing north), which is visually misleading.
- **`routesCache` is never invalidated** — `routes.txt` is read once at first call and held in memory for the container's lifetime. A file change requires a restart.
- **Empty lat/lon filtered, but zero-bearing not** — `bearing: 0` is indistinguishable from "no bearing data"; the map renders all vehicles with a direction arrow pointing north.

## Planned Changes
- **Retry on 429** — back off and retry once after 2 s before serving stale data.
- **Redis cache** — share vehicle cache across ECS tasks for horizontal scaling.
- **Auto-refresh `routes.txt`** — periodically re-download routes from GTFS-NL so line metadata stays current without manual rebuilds.
- **Null bearing handling** — expose a `hasBearing: boolean` field so the map can render a circle instead of a directional arrow when bearing is unknown.
