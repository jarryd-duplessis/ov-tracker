# useOVWebSocket.js — WebSocket Hook

## Role
Manages the single persistent WebSocket connection to the backend. Handles automatic reconnection and re-subscription after disconnect. In the current architecture, **departures are fetched via HTTP polling** (not pushed over WebSocket). The hook polls `GET /api/departures` on a timer, exposes the results, and maintains the WebSocket connection for future server-push capability.

## Returns
| Key | Type | Description |
|---|---|---|
| `departures` | `Departure[]` | Latest departure list from the most recent HTTP poll |
| `connected` | `boolean` | True when the WS is in `OPEN` state |
| `lastUpdate` | `Date\|null` | Timestamp from the last successful departures poll |
| `error` | `string\|null` | Connection or fetch error message |
| `subscribe` | `(stopCodes: string[]) => void` | Sets the stop codes to watch; filters to KV7 only (≥ 8-digit TPC) before sending |

## KV7 filter
`subscribe(stopCodes)` filters the input to stops with TPC codes of length ≥ 8 before sending the WS message or starting the HTTP poll. This excludes openov-nl stops (7-digit IDs) that OVapi does not recognise.

```js
const kv7 = stops.filter(s => s.length >= 8);
if (kv7.length === 0) { setDepartures([]); return; }
```

## HTTP polling for departures
Every ~14 s, the hook fetches `GET /api/departures?stops=TPC1,TPC2` and updates `departures`. The 14 s interval matches the DynamoDB cache TTL so the response is nearly always served from cache.

On subscribe, the first poll fires immediately (no wait for the timer), so the departure board populates as soon as a stop is selected.

## WebSocket subscription
The WS `subscribe` message is sent alongside the HTTP poll:
```js
ws.send(JSON.stringify({ type: 'subscribe', stopCodes: kv7 }))
```
The backend stores this in DynamoDB for future use (when server-push is re-enabled) but does not respond with departure data.

## Connection URL
```js
`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
```
In production this resolves to `wss://ws.ov.jarryd.co.za` (separate subdomain with custom domain on the WS API). In local dev, the Vite proxy forwards `/ws` to `ws://localhost:3001`.

## Reconnection
- On WS close: `setTimeout(connect, 3000)` — 3 s flat delay, no exponential backoff
- On reconnect (`onopen`): immediately re-sends the last known `stopCodes` without debounce delay (fast recovery)
- HTTP polling continues during a WS disconnect; only the `connected` flag changes

## Subscribe debounce
`subscribe(stopCodes)` is debounced **800 ms** — if called multiple times within that window (GPS update + map moveend firing in quick succession), only the last set of stop codes is sent and polled. This prevents rapid poll-interval churn when the user is panning.

## Refs
| Ref | Purpose |
|---|---|
| `ws` | The `WebSocket` instance |
| `reconnectTimer` | Timer ID for WS reconnect delay |
| `subscribeTimer` | Timer ID for subscribe debounce |
| `pollTimer` | Timer ID for the HTTP poll interval |
| `currentStops` | Last KV7 stop codes passed to `subscribe` — used for re-subscription on WS reconnect and poll restart |

## Known Issues
- **Flat 3 s reconnect delay** — No exponential backoff. If the server is down for an extended period, reconnect attempts happen every 3 s indefinitely.
- **No WS heartbeat / ping** — AWS API Gateway WebSocket has a 10-minute idle timeout (not ALB's 60 s). Clients idle for > 10 min may be disconnected silently. HTTP polling continues regardless.
- **HTTP polling is best-effort** — If `/api/departures` returns an error (e.g. OVapi down, cache empty), the previous `departures` array is retained and the `error` state is set. No retry within the current poll cycle.
- **Single shared WS connection** — React StrictMode in dev mounts the component twice; the second connection wins. Not an issue in production.

## Planned Changes
- **Exponential backoff** — Start at 1 s, double up to 30 s, reset on successful message.
- **Switch to WS push when re-enabled** — When the backend re-enables the poll Lambda, replace HTTP polling with server-push for lower latency and reduced Lambda invocations.
- **Connection quality indicator** — Expose round-trip time so the UI can show degraded vs healthy live data.
