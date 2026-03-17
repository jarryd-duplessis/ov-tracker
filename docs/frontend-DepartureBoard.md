# DepartureBoard.jsx — Departure List Sidebar

## Role
Displays real-time and scheduled departures for the subscribed stops. Supports filtering by transport type, trip tracking (tap a row), trip saving (star button), and shows tracking status with an expanded panel. Shown only when mode is `'nearby'`.

Uses CSS design tokens (`var(--radius-sm)`, `var(--shadow-sm)`, `var(--green-bg)`, etc.) for consistent theming across dark/light modes.

## Props
| Prop | Type | Description |
|---|---|---|
| `departures` | `Departure[]` | Live departure objects from `useOVWebSocket` (HTTP-polled) |
| `nearbyStops` | `Stop[]` | Used only for the header stop-name chips |
| `lastUpdate` | `Date\|null` | Timestamp of last departure update; shown in header |
| `loading` | `boolean` | Shows "Loading…" in header during stop fetches |
| `connected` | `boolean` | If false, shows stale-data reconnect banner |
| `trackedId` | `string\|null` | `"{stopCode}-{journeyNumber}"` of the tracked departure |
| `savedIds` | `Set<string>` | Set of saved trip IDs for O(1) star state lookup |
| `onTrack` | `(dep\|null) => void` | Called when a row is tapped; toggles tracking |
| `onToggleSave` | `(dep) => void` | Called when the star button is tapped |
| `selectedStop` | `string\|null` | TPC code of the user-selected stop; used for header display |
| `onStopClick` | `(stop) => void` | Called when a stop pill is clicked in the header |

## Departure object shape
```js
{
  stopCode: string,       // OVapi TPC code
  line: string,           // e.g. "15", "M52"
  destination: string,
  expectedTime: string,   // ISO-8601, Amsterdam local time (correctly offset by backend)
  scheduledTime: string,
  minutesUntil: number,   // negative = already departed
  journeyNumber: number,
  transportType: 'BUS'|'TRAM'|'METRO',
  confidence: 'live'|'scheduled',
  operator: string,
}
```

## Filter tabs
Generated dynamically from the distinct `transportType` values in the current departure list. Tabs only appear when there are 2+ types.

**Auto-reset**: A `useEffect` on `types` resets the active filter to `'ALL'` whenever the selected transport type is no longer present in the current departure list. This prevents a stale filter leaving an empty list when the user switches to a stop with different transport modes.

## DepartureRow
- The main row is clickable → `onTrack(isTracked ? null : dep)` — tapping a tracked row untracks.
- Star button uses `e.stopPropagation()` to prevent tracking when saving.
- Time display: `≤ 1 min` → "NU" (green); `≤ 5 min` → orange; else white.
- Rows with `minutesUntil < -1` are dimmed (opacity 0.4).
- Blue left border + faint blue background when `isTracked`.

**Expanded tracking panel** (shown below the row when `isTracked`):
- Pulsing blue dot + "Route shown on map" label
- "Stop tracking" button that calls `onTrack(null)`

This makes it clear that clicking a departure draws the route on the map, and provides an explicit dismiss action without requiring a re-click on the row.

## ConfidenceBadge
- `live` → green pulsing dot + "LIVE"
- `scheduled` → amber dot + "SCHEDULED"
- Pulsing animation defined via inline `<style>` tag (keyframes `pulse`).

## Known Issues
- **Departures not grouped by stop** — All subscribed stops' departures are interleaved and sorted by `minutesUntil`. If two stops have the same line going to the same destination, their rows look identical.
- **No manual refresh** — Data updates only when a new poll result arrives (~14 s). No pull-to-refresh.
- **Time drift** — `minutesUntil` is computed at the backend at fetch time and not recalculated client-side. A departure showing "4'" may actually be "2'" by the time the user reads it.

## Planned Changes
- **Group departures by stop name** — Collapsible sections per stop, making it clear which physical stop each departure leaves from.
- **Client-side countdown** — Recalculate `minutesUntil` every 30 s on the frontend to keep displayed times accurate.
- **Show platform / track** — Expose the track/bay number when available in the OVapi response.
- **Swipe-to-save** — Swipe a row right to save instead of small star tap (better mobile UX).
