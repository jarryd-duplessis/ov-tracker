# ovapi.js — OVapi Client

## Role
Fetches and parses live departure data from the OVapi v0 API. Handles timezone correction (OVapi returns Dutch local time without timezone suffix) and filters to relevant transport types.

## External API
`http://v0.ovapi.nl/tpc/{comma-separated-codes}`

- Protocol: HTTP (not HTTPS)
- Response: JSON with nested structure `{ [tpc]: { Passes: { [journeyKey]: passtime } } }`
- License: GOVI — data must not be stored or cached for more than 30 minutes
- Rate limits: unofficial; typically allows ~1 req/s per IP

## Functions

### `getDeparturesMulti(timingPointCodes: string[])`
Single request for multiple TPC codes (comma-joined). Returns raw OVapi JSON.

### `parseTpcResponse(data, stopCode?)`
Iterates all TPC keys and their `Passes`, filters to `['BUS', 'TRAM', 'METRO']`, parses each passtime, drops entries with `minutesUntil < -2`, sorts by `minutesUntil`.

### `parsePasstime(passtime, stopCode)`
Converts one raw OVapi passtime to a clean departure object. Key behaviour:
- Uses `ExpectedArrivalTime` if present, falls back to `TargetArrivalTime`
- Parses time via `parseAmsterdamTime` (see below)
- Sets `confidence: 'live'` if `RealtimeArrival` is present, else `'scheduled'`

### `parseAmsterdamTime(timeStr)`
OVapi returns times as `"YYYY-MM-DDTHH:MM:SS"` with no timezone suffix, in Dutch local time (CET/CEST). The ECS container runs UTC, so naive `new Date(str)` would be 1–2 hours wrong.

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
  journeyNumber: number,
  transportType: 'BUS'|'TRAM'|'METRO',
  operator: string,
  confidence: 'live'|'scheduled',
}
```

## Known Issues
- **`minutesUntil` is stale by the time the client reads it** — computed at fetch time on the server, broadcast to clients, and never updated. A departure showing "4'" could be "2'" by the time the user acts on it. Client-side recalculation would require also sending a reference timestamp.
- **Only BUS/TRAM/METRO** — `parseTpcResponse` explicitly filters out RAIL, FERRY, SUBWAY etc. Expanding coverage requires adding those types and handling their TPC code format.
- **HTTP not HTTPS** — the OVapi endpoint is plain HTTP. Traffic between ECS and OVapi is not encrypted (acceptable within AWS, but not ideal).
- **No retry logic** — a single failed OVapi request surfaces as an error broadcast to all group subscribers. There is no retry on transient errors.
- **`parseAmsterdamTime` uses UTC approximation** — the `approx` date is constructed as `new Date(timeStr + 'Z')` which could be off by 1–2 hours near the DST boundary, potentially picking the wrong offset. Edge case (only affects the hour either side of the clock change).

## Planned Changes
- **Expand transport types** — add `SUBWAY` / `RAIL` and source TPC codes for those operators.
- **Retry on transient error** — retry once after 2 s before broadcasting an error.
- **Send `fetchedAt` as UTC epoch** — let the client recalculate `minutesUntil` relative to local clock instead of server clock.
- **HTTPS endpoint** — if OVapi adds HTTPS support, switch to it.
