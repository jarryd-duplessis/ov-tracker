# stops.js — GTFS Stop Cache

## Role
Downloads and caches the KV7 GTFS stops dataset. Provides `findNearbyStops` for the `/api/stops/nearby` endpoint. Uses a two-tier cache (in-memory + disk) backed by a pre-baked `stops_cache.json` in the Docker image.

## Data Source
`https://gtfs.ovapi.nl/govi/gtfs-kv7-YYYYMMDD.zip`

- KV7 GTFS: bus/tram/metro stops from Dutch regional operators
- Daily file, date in filename — tries today and 3 previous days if today's isn't published yet
- `stop_id` in KV7 corresponds directly to the TPC codes used by OVapi's `/tpc/` endpoint
- `location_type != '0'` entries (station nodes, entrances) are excluded; only physical platforms are kept
- Stops outside Netherlands bounds (lat 50.5–53.7, lon 3.3–7.3) are excluded at import time

## Cache Hierarchy

```
1. In-memory (stopsCache)         — fastest, lost on container restart
2. Disk (stops_cache.json)        — baked into Docker image at build time, survives between requests
3. Fresh KV7 download             — triggered when disk cache is stale (> 7 days)
```

**TTL: 7 days** — if the disk cache is within 7 days old it is used as-is. On expiry, a fresh download is attempted. If the download fails, the stale in-memory cache is served with a log warning and the TTL clock is reset (no hammering on repeated requests).

**Size guard on refresh** — a fresh download is only written to disk if it contains ≥ 80% of the existing stop count. This prevents a partial/regional KV7 file (e.g. ~1,500 stops for one operator) from silently replacing the full national cache (~33,000+ stops).

## Functions

### `getStops()`
Returns the full stops array. Checks in-memory cache → disk cache → download, in that order. Always loads the disk cache into memory even if stale, so it's available as a fallback. Applies NL-bounds filter when loading from disk to strip any bogus-coordinate entries.

### `findNearbyStops(lat, lon, maxResults = 30, maxDistanceKm = 1.0)`
1. Calls `getStops()`
2. Computes Haversine distance from `(lat, lon)` to each stop
3. Filters to `<= maxDistanceKm`
4. Sorts by distance ascending
5. Proximity-deduplicates: any stop within 20m of an already-kept stop is dropped
6. Returns up to `maxResults` stops

### `downloadStops()`
Tries each KV7 GTFS URL (today → 3 days back) with `wget`. Extracts `stops.txt` from the zip via `unzip -p` (20 MB buffer). Parses with RFC 4180-compliant CSV parser. Skips stops outside NL bounds. Returns array of stop objects.

### `parseCsvLine(line)`
RFC 4180-compliant CSV field splitter. Handles quoted fields and `""` escape sequences inside quoted strings.

### `haversineDistance(lat1, lon1, lat2, lon2)`
Returns distance in km between two WGS-84 coordinates.

## Stop object shape
```js
{
  id: string,       // GTFS stop_id (= OVapi TPC code)
  name: string,     // stop_name from GTFS
  lat: number,
  lon: number,
  tpc: string,      // same as id — used by frontend for WebSocket subscribe
}
```

## Docker image pre-baking
The `stops_cache.json` file is committed to the repo and included in the Docker image (removed from `.dockerignore`). At image build time the Dockerfile stamps its `timestamp` field to the build time, so containers start with a fresh 7-day TTL and never need to download on boot.

## Known Issues
- **Bogus coordinates in source data** — 4,697 stops in the baked-in cache had coordinates at (47.97°N, 3.31°E) — a location in France — due to a placeholder value in the upstream GTFS export. These entries have been filtered out of `stops_cache.json` and are now excluded at load time. The affected stops (mostly rural Connexxion/Arriva routes: 20xxx, 22xxx, 66xxx TPC ranges) will remain invisible until OVapi corrects the source data.
- **KV7 coverage varies by day** — the KV7 daily zip size has ranged from ~4.6 MB (1,501 stops, single operator) to ~37 MB (full national set). The size guard prevents a small file from replacing a large cache, but means a partial download silently falls back with no benefit.
- **No partial refresh** — if the download fails, the entire stale cache is served. There's no incremental update.
- **`wget` synchronous** — `downloadStops` calls `execSync`, blocking the Node event loop for the duration of the download. Concurrent requests during download will be delayed.
- **20m dedup threshold** — some legitimate adjacent stops (e.g. two directions at the same intersection) may be within 20m and one will be dropped.
- **No RAIL/FERRY/SUBWAY TPC codes** — KV7 only includes bus/tram/metro. Rail station TPC codes are not in this dataset.
- **OVapi KV7 rate limiting** — the daily zip download returns 429 when hit repeatedly from the same IP. The fallback to existing cache handles this gracefully but means fresh data isn't always available.

## Planned Changes
- **Async download** — replace `execSync` + `wget` with `node-fetch` streaming download to avoid blocking the event loop.
- **Configurable dedup threshold** — expose the 20m threshold so it can be tuned per-environment.
- **RAIL stop coverage** — source NS/ProRail TPC codes to enable rail departure lookups.
- **Coordinate repair** — when a fresh KV7 download provides correct coordinates for a TPC code that previously had bogus ones, merge them into the existing cache rather than doing a full replace.
