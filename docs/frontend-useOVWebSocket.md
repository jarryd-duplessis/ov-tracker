# useOVWebSocket.js — WebSocket Hook

## Role
Manages the single persistent WebSocket connection to the backend. Exposes departures, connection state, and a `subscribe` function. Handles automatic reconnection and re-subscription after disconnect.

## Returns
| Key | Type | Description |
|---|---|---|
| `departures` | `Departure[]` | Latest departure list pushed by the server |
| `connected` | `boolean` | True when the WS is in `OPEN` state |
| `lastUpdate` | `Date\|null` | Timestamp from the last `departures` push |
| `error` | `string\|null` | Connection error message |
| `subscribe` | `(stopCodes: string[]) => void` | Sets the stop codes to watch |

## Connection URL
```js
`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`
```
Relative to the current host so it works in both dev (proxy to localhost:3001) and production (CloudFront → ALB → ECS).

## Reconnection
- On close: `setTimeout(connect, 3000)` — 3 s flat delay, no exponential backoff.
- On reconnect (`onopen`): immediately re-sends the last known `stopCodes` without debounce delay (fast recovery).

## Subscribe debounce
`subscribe(stopCodes)` is debounced **800 ms** — if called multiple times within that window (GPS update + map moveend firing in quick succession), only the last set of stop codes is sent to the server. This prevents rapid group churn on the backend.

The debounce timer is stored in `subscribeTimerRef` and cleared on unmount.

## Message protocol
Incoming messages from server:
```js
{ type: 'departures', departures: Departure[], fetchedAt: string }
{ type: 'error', message: string }
```
Outgoing messages to server:
```js
{ type: 'subscribe', stopCodes: string[] }
{ type: 'unsubscribe' }
```

## Refs
| Ref | Purpose |
|---|---|
| `ws` | The `WebSocket` instance |
| `reconnectTimer` | Timer ID for reconnect delay |
| `subscribeTimer` | Timer ID for subscribe debounce |
| `currentStops` | Last stop codes passed to `subscribe` — used for re-subscription on reconnect |

## Known Issues
- **Flat 3 s reconnect delay** — no exponential backoff. If the server is down for an extended period, reconnect attempts happen every 3 s forever.
- **No heartbeat / ping** — some load balancers (AWS ALB default: 60 s idle timeout) will kill idle WebSocket connections silently. The client detects this only when the next send fails or the close event fires.
- **Single shared connection** — if the component mounts twice (React StrictMode in dev), two connections are created. The second one wins; the first leaks briefly. Not an issue in production.
- **No message queueing** — if `subscribe` is called before the WS is open, it sets `currentStops` but the send is deferred to `onopen`. If `onopen` has already fired, the first call is lost (covered by the `onopen` re-sub only if `currentStops` was set before connect).

## Planned Changes
- **Exponential backoff** — start at 1 s, double up to 30 s, reset on successful message.
- **Ping/keepalive** — send a `{ type: 'ping' }` every 30 s to keep the ALB connection alive.
- **Connection quality indicator** — expose latency/round-trip time so the UI can show degraded vs healthy live data.
