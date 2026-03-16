# server.js — Express + WebSocket Server

## Role
Entry point and HTTP/WS server. Serves all REST endpoints under `/api`, handles WebSocket connections, and manages the shared poll-group registry that deduplicates OVapi requests across clients.

## REST Endpoints
| Method | Path | Description |
|---|---|---|
| GET | `/health` | ALB health check (no `/api` prefix — ALB hits container directly) |
| GET | `/api/health` | Same, accessible through CloudFront |
| GET | `/api/stops/nearby` | Returns up to 30 deduplicated stops within given radius |
| GET | `/api/departures` | One-off departure fetch (not used by frontend — WS is preferred) |
| GET | `/api/vehicles` | Live vehicle positions from GTFS-RT |
| GET | `/api/journey` | Journey planning via Nominatim geocoding + Motis |

### `/api/stops/nearby` params
| Param | Default | Description |
|---|---|---|
| `lat` | required | Latitude |
| `lon` | required | Longitude |
| `radius` | `1.0` | Search radius in km (frontend sends 1.0–1.5) |

Returns `{ stops: Stop[] }` — up to 30 stops sorted by distance, proximity-deduplicated (20 m threshold).

### `/api/vehicles` caching
- Backend caches the last successful GTFS-RT fetch for 8 s
- On 429 or any fetch error, serves cached positions with a log warning
- Cache is in-process (resets on container restart)

## Shared Poll Registry

The key architectural feature — all clients watching the same set of stops share a **single** OVapi poll instead of each polling independently.

```
pollGroups: Map<key, { stopCodes, interval, subscribers: Set<ws> }>
clientToKey: Map<ws, key>
```

**Key** = sorted stop codes joined by comma — order-independent.

### Subscribe flow
1. `unsubscribe(ws)` — leave previous group (delete group if it becomes empty)
2. If group key exists → add `ws` to `subscribers`
3. Else → create group, call `fetchAndBroadcast` immediately, start 15 s interval

### Unsubscribe flow
1. Remove `ws` from group's subscriber set
2. If set is now empty → `clearInterval`, delete group

### fetchAndBroadcast
Calls `getDeparturesMulti(stopCodes)` → `parseTpcResponse` → broadcasts JSON to all `OPEN` subscribers. On error, broadcasts `{ type: 'error', message }`.

**Poll interval: 15 s** — matches OVapi's data refresh rate.

## Journey Planner (`/api/journey`)
1. Geocodes `from` and `to` via Nominatim (NL-restricted, single result)
2. Calls Motis `https://europe.motis-project.de/api/v1/plan` with lat/lon pairs
3. Returns `{ from, to, itineraries }`

## Known Issues
- **No authentication** — endpoints are publicly accessible. OVapi rate limits are per IP, so heavy use from many clients could get the server IP throttled.
- **WebSocket subscribe cap at 20** — clients can subscribe to at most 20 stop codes. Nearby stops query returns up to 30, so the last 10 are never subscribed.
- **No rate limiting on `/api/vehicles`** — clients could hammer this endpoint; server-side 5 s cache mitigates but doesn't prevent abuse.
- **Nominatim User-Agent** — hardcoded as `KomtIe/1.0 (live-ov-tracker)`. Nominatim ToS requires a valid contact address.
- **No WebSocket authentication** — any client can subscribe to any stop codes, including bulk scraping.
- **Single ECS task** — no horizontal scaling; one task means one process holds all poll groups and WS connections.
- **ALB idle timeout** — default 60 s; WebSocket connections idle > 60 s are killed by ALB without the server knowing.

## Planned Changes
- **Raise subscribe cap to 30** — align with the stops API's maxResults.
- **Keepalive / ping-pong** — send WS pings every 30 s to prevent ALB idle timeout drops.
- **Rate limiting** — add `express-rate-limit` to REST endpoints to prevent scraping.
- **Horizontal scaling** — move poll state to Redis pub/sub so multiple ECS tasks can share one OVapi poll per stop group.
- **GTFS-RT vehicle caching to Redis** — share vehicle cache across tasks.
