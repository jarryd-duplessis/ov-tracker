# lambda/lib/ovapi.js — OVapi Client

## Role
Fetches and parses live departure data from the OVapi v0 API. Handles timezone correction (OVapi returns Dutch local time without a timezone suffix) and filters to relevant transport types.

## External API
`http://v0.ovapi.nl/tpc/{comma-separated-codes}`

- Protocol: HTTP (not HTTPS)
- Response: JSON with nested structure `{ [tpc]: { Passes: { [journeyKey]: passtime } } }`
- License: GOVI — data must not be stored or cached for more than 30 minutes
- Rate limits: unofficial; typically allows ~1 req/s per IP

## Functions

### `getDeparturesMulti(timingPointCodes: string[])`
Single request for multiple TPC codes (comma-joined). Returns raw OVapi JSON.

Only KV7 stops (8-digit TPC codes) are passed here — the filter at the call site (`http_departures.js`) ensures 7-digit openov-nl IDs never reach OVapi.

### `parseTpcResponse(data, stopCode?)`
Iterates all TPC keys and their `Passes`, filters to `['BUS', 'TRAM', 'METRO']`, parses each passtime, drops entries with `minutesUntil < -2`, sorts by `minutesUntil`.

### `parsePasstime(passtime, stopCode)`
Converts one raw OVapi passtime to a clean departure object. Key behaviour:
- Uses `ExpectedArrivalTime` if present, falls back to `TargetArrivalTime`
- Parses time via `parseAmsterdamTime` (see below)
- Sets `confidence: 'live'` if `RealtimeArrival` is present, else `'scheduled'`

### `parseAmsterdamTime(timeStr)`
OVapi returns times as `"YYYY-MM-DDTHH:MM:SS"` with no timezone suffix, in Dutch local time (CET/CEST). Lambda containers run in UTC, so naive `new Date(str)` would be 1–2 hours wrong.

This function appends the correct offset:
- Detects DST boundary: last Sunday of March → last Sunday of October
- Appends `+02:00` (CEST) or `+01:00` (CET)
- If the string already contains a timezone indicator (`Z`, `+`, or `-` after position 7), parses as-is

## Departure object shape
```js
{
  stopCode: string,        // TPC code
  line: string,            // Route short name, e.g. "15"
  destination: string,     // Destination name, max 50 chars
  expectedTime: string,    // Original time string from API
  scheduledTime: string,   // TargetArrivalTime
  minutesUntil: number,    // Relative to server time at fetch
  isRealtime: boolean,
  journeyNumber: number,   // Used by frontend to match tracked vehicle via tripId
  transportType: 'BUS'|'TRAM'|'METRO',
  operator: string,
  confidence: 'live'|'scheduled',
}
```

## Known Issues
- **`minutesUntil` is stale** — Computed at fetch time on the server, stored in DynamoDB cache, and delivered to clients up to 14 s later. A departure showing "4'" could be "2'" by the time the user reads it. Client-side recalculation would require sending a reference timestamp.
- **Only BUS/TRAM/METRO** — `parseTpcResponse` filters out RAIL, FERRY, SUBWAY etc. Expanding coverage requires additional transport types and their TPC code formats.
- **HTTP not HTTPS** — The OVapi endpoint is plain HTTP. Traffic between Lambda and OVapi is not encrypted (Lambda egress via VPC-less public internet).
- **No retry logic** — A single failed OVapi request surfaces as an HTTP 500 to the client. There is no retry on transient errors.
- **`parseAmsterdamTime` DST edge case** — The `approx` date used for DST detection is constructed as `new Date(timeStr + 'Z')` which can be off by 1–2 hours near the clock-change boundary, potentially picking the wrong offset. Affects only the hour either side of the DST transition.

## Planned Changes
- **Retry on transient error** — Retry once after 2 s before returning an error response.
- **Send `fetchedAt` as UTC epoch** — Let the client recalculate `minutesUntil` relative to its local clock.
- **HTTPS endpoint** — Switch to HTTPS if OVapi adds TLS support.
- **Expand transport types** — Add `SUBWAY` / `RAIL` if OVapi gains those endpoints.
