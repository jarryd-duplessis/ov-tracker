# lambda/lib/stops.js — GTFS Stop Cache

## Role
S3-backed stop dataset for Lambda. Loads the merged KV7 + openov-nl GTFS stops from S3 (`stops_cache.json`) and provides `findNearbyStops` for the `/api/stops/nearby` endpoint. Module-level in-memory cache persists across warm Lambda invocations.

The cache is refreshed daily by the `refresh_stops` Lambda (EventBridge at 03:00 UTC), which downloads, merges, deduplicates, and writes a fresh `stops_cache.json` to S3.

## Data Sources (populated by `refresh_stops`)

### KV7 GTFS (`gtfs.ovapi.nl/govi/gtfs-kv7-YYYYMMDD.zip`)
- Bus, tram, and metro stops from Dutch regional operators
- Daily file — tries today and 3 previous days if today's isn't published yet
- `stop_id` values correspond directly to OVapi TPC codes (8-digit format)
- Stops outside NL bounds (lat 50.5–53.7, lon 3.3–7.3) excluded

### openov-nl GTFS (`gtfs.ovapi.nl/openov-nl/gtfs-openov-nl.zip`)
- Full NL network: includes NS rail stations, ferry stops, and stops missing from KV7
- Stop IDs are 7-digit GTFS stop_id values — **not** recognised by OVapi's `/tpc/` endpoint
- Only stops more than 15 m from any KV7 stop are added (deduplication via spatial grid)

The merged result is written to S3 as `{ stops: Stop[], timestamp: number }`.

## Cache Hierarchy

```
1. In-memory (module variable)  — fastest; survives warm Lambda invocations
2. S3 (stops_cache.json)        — shared across all containers; cold start reads from here
3. Error                        — if S3 fails and no in-memory cache: throws (HTTP 500)
```

**In-memory TTL: 7 days** — if the in-memory cache is within 7 days old, it is used as-is without hitting S3.

## Functions

### `getStops()`
Returns the full stops array. Checks in-memory cache first; on miss (cold start or TTL expired), reads from S3. Applies NL-bounds filter on load to strip any bogus-coordinate entries. If S3 fails and in-memory cache is non-empty, returns stale cache with a warning.

### `findNearbyStops(lat, lon, maxResults = 30, maxDistanceKm = 1.0)`
1. Calls `getStops()`
2. Computes Haversine distance to each stop
3. Filters to `<= maxDistanceKm`
4. Sorts ascending by distance
5. Deduplicates: any stop within 10 m of an already-kept stop is dropped
6. Returns up to `maxResults` stops

### `downloadStops()` (called only by `refresh_stops` Lambda)
Uses `fetch` + `jszip` (no `wget` or `unzip` — Lambda has no shell utilities).
1. Downloads KV7 zip for today or up to 3 prior days
2. Downloads openov-nl zip
3. Parses both `stops.txt` files
4. Builds a spatial grid from KV7 stops (100 m cells)
5. Adds openov-nl stops that are > 15 m from any KV7 stop
6. Returns merged array

### `buildSpatialGrid(stops)` / `isNearAny(lat, lon, grid, distKm)`
Spatial grid keyed by `floor(lat*1000),floor(lon*1000)` (~100 m cells). Used to efficiently check whether an openov-nl stop is already represented by a nearby KV7 stop.

### `parseCsvLine(line)`
RFC 4180-compliant CSV field splitter — handles quoted fields and `""` escape sequences.

### `haversineDistance(lat1, lon1, lat2, lon2)`
Returns distance in km between two WGS-84 coordinates.

### `saveToS3(data)` (called by `refresh_stops` Lambda)
Writes `{ stops, timestamp }` to `stops_cache.json` in the ops S3 bucket.

## Stop object shape
```js
{
  id: string,       // GTFS stop_id (= OVapi TPC code for KV7 stops)
  name: string,     // stop_name from GTFS
  lat: number,
  lon: number,
  tpc: string,      // same as id — used by frontend for stop identification
  distance: number, // km from query point, added by findNearbyStops
}
```

## KV7 vs openov-nl stop types

The frontend distinguishes stop types by TPC code length:
- **KV7 stops**: 8-digit TPC (e.g. `NL:Q:13006600`-style, stored as 8+ chars) — valid OVapi TPC codes
- **openov-nl stops**: 7-digit IDs — visible on map, but not recognised by OVapi

When a user clicks an openov-nl stop, `App.jsx` (`handleStopClick`) finds nearby KV7 stops and subscribes to those instead. If no KV7 stops are within 300 m, it calls `fetchNearbyStops` on that location to find any.

## Known Issues
- **openov-nl stops have no departure data** — 7-digit IDs are unknown to OVapi. They appear on the map but clicking them falls back to nearby KV7 stops.
- **KV7 coverage varies by day** — The daily KV7 zip size has ranged from ~4 MB (partial) to ~37 MB (full national). The merged cache retains whichever set was loaded most recently by `refresh_stops`.
- **No size guard in Lambda version** — The Express backend had an 80% size guard preventing a small KV7 file from replacing a large cache. The Lambda `refresh_stops` does not currently implement this guard.
- **10 m dedup threshold** — Adjacent stops on opposite sides of a road (typically 15–30 m apart) are kept distinct. Stops within 10 m are assumed to be the same physical pole.
- **S3 cold start** — First request on a cold Lambda container reads `stops_cache.json` from S3 (~20 ms). No pre-warming.

## Planned Changes
- **Size guard on refresh** — Warn and abort if new KV7 download contains fewer stops than 80% of the cached set.
- **Partial merge on refresh** — Only replace stops from operators present in the new download; preserve other operators' stops.
- **RAIL/FERRY TPC codes** — If OVapi gains endpoints for NS trains or ferry operators, sourcing those TPC codes would require extending the KV7 or a separate feed.
