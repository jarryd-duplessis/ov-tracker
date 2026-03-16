# DepartureBoard.jsx — Departure List Sidebar

## Role
Displays real-time and scheduled departures for all subscribed nearby stops. Supports filtering by transport type, trip tracking (tap a row) and trip saving (star button). Shown only when mode is `'nearby'`.

## Props
| Prop | Type | Description |
|---|---|---|
| `departures` | `Departure[]` | Live departure objects from `useOVWebSocket` |
| `nearbyStops` | `Stop[]` | Used only for the header stop-name chips |
| `lastUpdate` | `Date\|null` | Timestamp of last WS push; shown in header |
| `loading` | `boolean` | Shows "Loading…" spinner in header |
| `connected` | `boolean` | If false, shows stale-data reconnect banner |
| `trackedId` | `string\|null` | `"{stopCode}-{journeyNumber}"` of the tracked departure |
| `savedIds` | `Set<string>` | Set of saved trip IDs for O(1) star state lookup |
| `onTrack` | `(dep\|null) => void` | Called when a row is tapped; toggles tracking |
| `onToggleSave` | `(dep) => void` | Called when the star button is tapped |

## Departure object shape
```js
{
  stopCode: string,       // OVapi TPC code
  line: string,           // e.g. "15", "M52"
  destination: string,
  expectedTime: string,   // ISO-8601, Amsterdam local time (parsed correctly by backend)
  scheduledTime: string,
  minutesUntil: number,   // negative = already departed
  journeyNumber: number,
  transportType: 'BUS'|'TRAM'|'METRO',
  confidence: 'live'|'scheduled',
  operator: string,
}
```

## Filter tabs
Tabs are generated dynamically from the distinct `transportType` values in the current departure list. Tabs only appear when there are 2+ types.

## DepartureRow
- Full row is clickable → `onTrack(isTracked ? null : dep)` — tapping a tracked row untracks.
- Star button uses `e.stopPropagation()` to prevent tracking when saving.
- Time display: `≤ 1 min` → "NU" (green); `≤ 5 min` → orange; else white.
- Rows with `minutesUntil < -1` are dimmed (opacity 0.4) — show briefly before being removed by the backend filter.
- Blue left border + faint blue background when `isTracked`.

## ConfidenceBadge
- `live` → green pulsing dot + "LIVE"
- `scheduled` → amber dot + "SCHEDULED"
- Pulsing animation defined via `<style>` tag inline (keyframes `pulse`).

## Known Issues
- **Departures not grouped by stop** — all stops' departures are interleaved and sorted by `minutesUntil`. If two stops have the same line going to the same destination, their rows look identical.
- **No manual refresh** — data updates only on WebSocket push (every 15 s server-side). No pull-to-refresh.
- **Transport type filter resets on new data** — if the WS pushes new departures and the type set changes, the active filter tab may disappear, defaulting back to "ALL" silently.
- **Time drift** — `minutesUntil` is computed at the backend at fetch time and not recalculated client-side. A departure showing "4'" may actually be "2'" by the time the user reads it.

## Planned Changes
- **Group departures by stop name** — collapsible sections per stop, making it clear which physical stop each departure leaves from.
- **Client-side countdown** — recalculate `minutesUntil` every 30 s on the frontend to keep displayed times accurate.
- **Show platform / track** — expose the track/bay number when available in the OVapi response.
- **Swipe-to-save** — swipe a row right to save instead of small star tap (better mobile UX).
