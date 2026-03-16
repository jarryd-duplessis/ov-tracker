# SavedTrips.jsx — Saved Trips Panel

## Role
Shows a list of trips the user has starred, with live countdowns and track/remove actions. Persisted across sessions via localStorage. Shown when mode is `'saved'`.

## Props
| Prop | Type | Description |
|---|---|---|
| `savedTrips` | `Trip[]` | Array from localStorage, managed in App |
| `onUnsave` | `(id: string) => void` | Removes a trip by its ID |
| `onTrack` | `(trip\|null) => void` | Starts/stops map tracking for this trip |
| `trackedId` | `string\|null` | Highlights the row of the currently tracked trip |

## Trip object shape
Trips are saved departure objects with an added `id` and `stopName`:
```js
{
  id: string,          // "{stopCode}-{journeyNumber}"
  stopCode: string,
  journeyNumber: number,
  line: string,
  destination: string,
  expectedTime: string,  // ISO-8601; frozen at time of saving
  transportType: string,
  stopName: string,      // friendly name from nearbyStops at time of save
}
```

## Countdown logic (`formatCountdown`)
- `< -2 min` → "Departed" (dimmed, 45% opacity)
- `0 min` → "NU"
- else → "{n} min"

Countdown ticks every 30 s via a `setInterval` inside a `useEffect`.

## Actions per row
- **📍 Track** — calls `onTrack`; switches to blue "📍 On" when active. Hidden for departed trips.
- **✕** — calls `onUnsave(trip.id)`.

## Storage format
```js
localStorage.key: 'komt-ie-saved-trips'
value: JSON array of Trip objects
```

App loads this on mount via `loadSavedTrips()` and writes on every toggle.

## Known Issues
- **`expectedTime` is frozen at save time** — the countdown is based on the original scheduled/expected time, not updated by new WS data. If the trip gets delayed after saving, the countdown is wrong.
- **Departed trips never auto-remove** — "Departed" rows accumulate until the user manually removes them. The active count badge in App filters them out (> −3 min) but the rows stay visible.
- **No re-subscription for saved stops** — switching to Saved mode doesn't subscribe to those stops' TPC codes, so the vehicle tracking may fail if the WS subscription has moved on to different stops.
- **Duplicate saves possible** — if the same departure appears under two different stop codes (rare but possible for multi-platform stops), it can be saved twice with different IDs.

## Planned Changes
- **Auto-remove departed trips after N minutes** — clean up rows more than 10 min past departure.
- **Live time updates from WS** — when WS pushes new departures, find matching saved trips and update their `expectedTime`.
- **Re-subscribe to saved stop codes when Saved tab is active** — ensures departure data for saved trips stays fresh even when the user isn't near those stops.
- **Group by departure date** — saved trips from different days should be visually separated.
