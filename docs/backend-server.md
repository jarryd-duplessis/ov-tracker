# Lambda Backend — Architecture Overview

## Role
The production backend is a set of AWS Lambda functions (Node.js 20) fronted by API Gateway v2 (HTTP and WebSocket). There is no persistent server process — each HTTP request or WebSocket event invokes an isolated Lambda execution. Shared state lives in DynamoDB (connections table, departures cache) and S3 (stops cache, vehicles cache).

For **local development**, `backend/server.js` is an Express + WebSocket server that mirrors Lambda behaviour. The Vite dev proxy routes `/api/*` and `/ws` to `localhost:3001`.

---

## Lambda functions

### HTTP API (`GET /api/*` via API Gateway HTTP)

| Handler | Path | Description |
|---|---|---|
| `http_stops.js` | `GET /api/stops/nearby` | Returns nearby stops from S3-cached GTFS data |
| `http_departures.js` | `GET /api/departures` | Departures with DynamoDB cache-aside (14 s TTL) |
| `http_vehicles.js` | `GET /api/vehicles` | Vehicle positions with two-tier cache (in-memory 5 s + S3 8 s) |
| `http_journey.js` | `GET /api/journey` | Journey planning via Nominatim geocoding + Motis |

### WebSocket API (`wss://ws.ov.jarryd.co.za` via API Gateway WebSocket)

| Handler | Route | Description |
|---|---|---|
| `connect.js` | `$connect` | Writes `{ connectionId, ttl }` to DynamoDB `connections` table |
| `disconnect.js` | `$disconnect` | Deletes connection record from DynamoDB |
| `ws_message.js` | `$default` | On `subscribe`: stores `{ groupKey, stopCodes, ttl }` in DynamoDB; no active push |

### Scheduled

| Handler | Schedule | Description |
|---|---|---|
| `refresh_stops.js` | EventBridge, 03:00 UTC daily | Downloads KV7 + openov-nl GTFS, merges, writes `stops_cache.json` to S3 |

---

## Departure data flow

Departures arrive at the client via HTTP polling — the WebSocket does not push departure data today.

```
GET /api/departures?stops=CODE1,CODE2
  1. cacheKey = sort(stopCodes).join(',')
  2. DynamoDB GetItem({ stopKey: cacheKey })
  3. Cache hit (age < 14 s): return immediately
  4. Cache miss: OVapi fetch → parse → DynamoDB PutItem (fire-and-forget) → return
```

Cache key is order-independent (sorted), so all clients and Lambda containers watching the same stop group share one OVapi call per 14 s.

---

## WebSocket: connection bookkeeping

```
Client → $connect → connect.js
  DynamoDB PutItem({ connectionId, ttl: now+7200 })

Client → { type: 'subscribe', stopCodes: [...] } → ws_message.js
  DynamoDB UpdateItem({ groupKey, stopCodes: slice(0,20), ttl: now+7200 })

Client → $disconnect → disconnect.js
  DynamoDB DeleteItem({ connectionId })
```

The SQS→poll Lambda event source mapping (`aws_lambda_event_source_mapping.poll_sqs`) is disabled (`enabled = false`) after AWS triggered recursive loop detection on the Lambda→SQS→Lambda self-scheduling pattern. Departure data reaches clients via HTTP polling only.

---

## DynamoDB tables

| Table | PK | TTL attr | Purpose |
|---|---|---|---|
| `komt-ie-connections` | `connectionId` (S) | `ttl` (2 h) | WebSocket session records |
| `komt-ie-departures-cache` | `stopKey` (S) | `ttl` (30 s) | Departure cache; Streams enabled (NEW_IMAGE) for future push path |

---

## S3 bucket (`komt-ie-ops-*`)

| Key | Written by | Read by | TTL |
|---|---|---|---|
| `stops_cache.json` | `refresh_stops` | `http_stops` | 7 days in-memory |
| `vehicles_cache.json` | `http_vehicles` | `http_vehicles` | 8 s |

---

## `/api/stops/nearby` params
| Param | Default | Description |
|---|---|---|
| `lat` | required | Latitude |
| `lon` | required | Longitude |
| `radius` | `1.5` | Search radius in km |

Returns `{ stops: Stop[] }` sorted by distance, deduplicated at 10 m.

---

## `/api/journey` params
| Param | Required | Description |
|---|---|---|
| `from` | if `fromLat`/`fromLon` absent | Free-text location, geocoded via Nominatim |
| `to` | yes | Destination string, geocoded via Nominatim |
| `fromLat` + `fromLon` | optional | Exact coordinates — bypasses Nominatim for the origin (used when tracking a departure from a known stop) |

Returns `{ from, to, itineraries }` — Motis itineraries with leg geometry.

---

## Known Issues
- **WebSocket push disabled** — The SQS→poll event source is `enabled = false`. Departures are HTTP-only.
- **No rate limiting** — API Gateway throttling (500 burst / 1000 rate) prevents extreme spikes, but there is no per-IP limit. A scraper could exhaust DynamoDB write capacity or OVapi quota.
- **Cold start latency on stops** — First request on a cold `http_stops` container loads `stops_cache.json` from S3 (~20 ms). No pre-warming configured.
- **`ws_message` subscribe cap at 20** — `stopCodes.slice(0, 20)` is stored. The stops query returns up to ~50 stops; codes beyond 20 are silently ignored for future push bookkeeping.
- **No CORS for WebSocket** — API Gateway WebSocket doesn't support CORS headers; cross-origin restrictions are enforced at the browser's WS implementation level.

## Planned Changes
- **Re-enable WebSocket push** — Restore SQS event source on `poll` Lambda with a dead-letter queue and idempotency token to prevent the recursive loop.
- **Push cached departures on connect** — When a client subscribes, read DynamoDB cache and immediately POST to `@connections/{connectionId}` so the client gets data without waiting for the next HTTP poll.
- **WAF rate limiting** — Add CloudFront WAF rules capping requests per IP per minute.
