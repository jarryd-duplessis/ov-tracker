# App.jsx — Root Component

## Role
Application shell. Owns all shared state, wires GPS → stop fetch → WebSocket subscription, and renders the top bar + mode-switched sidebar alongside the persistent map.

## State
| State | Type | Description |
|---|---|---|
| `userLocation` | `{lat, lon}\|null` | Live GPS fix; drives map centering and nearby-stop radius |
| `nearbyStops` | `Stop[]` | Stops returned by the last successful `/api/stops/nearby` call |
| `locationError` | `string\|null` | Human-readable geolocation error shown in the error banner |
| `loadingStops` | `boolean` | True while a stop fetch is in flight; shows "Loading…" in sidebar |
| `isMobile` | `boolean` | `window.innerWidth < 768`, recalculated on resize |
| `mode` | `'nearby'\|'journey'\|'saved'` | Which sidebar panel is active |
| `trackedDeparture` | `Departure\|null` | The departure currently being followed on the map |
| `savedTrips` | `Trip[]` | Persisted to `localStorage` under `komt-ie-saved-trips` |

## Key refs
- `watchIdRef` — geolocation `watchPosition` ID, cleared on unmount
- `lastStopFetchRef` — `{lat, lon}` of the last stop fetch; prevents re-fetching when GPS jitter < 100 m

## Data flow
```
GPS watchPosition
  → setUserLocation (map dot)
  → fetchNearbyStops (if moved > 100 m)
    → GET /api/stops/nearby
    → setNearbyStops
    → subscribe(stopCodes)     ← triggers WS subscription (debounced 800 ms)
      → WS push: departures
        → setDepartures (via useOVWebSocket)

Map moveend (pan/zoom)
  → fetchNearbyStops (different lat/lon/zoom)
    → same path as above
```

## Radius logic
`fetchNearbyStops(lat, lon)`: always uses **1.5 km**.

A zoom-dependent radius (1.0 km at zoom ≥ 14) was tried but caused a race condition: the GPS-triggered fetch (1.5 km) and the `flyTo`-completion `moveend` fetch (1.0 km) ran in parallel; whichever finished last won, and the 1.0 km result could silently drop stops found in the 1.0–1.5 km ring.

Empty results do **not** clear `nearbyStops`; only a non-empty result replaces them.

## Trip tracking
`handleTrack(dep)` — sets `trackedDeparture`, forces mode to `'nearby'` so the map is visible. Passing `null` untracks.

## Trip saving
`handleToggleSave(dep)` — adds/removes from `savedTrips` and writes to localStorage. `savedIds` (useMemo Set) lets child components do O(1) saved-state lookups.

## Tab badge
Active saved trips (expected time > −3 min) are counted and shown as `⭐ Saved (N)`.

## Known Issues
- **100 m GPS threshold** — `lastStopFetchRef` prevents re-fetching on GPS jitter but also means a significantly wrong initial fix (e.g. indoors) won't correct until the user moves 100 m.
- **`isMobile` is synchronous** — initialised from `window.innerWidth` at mount; SSR would break. Fine for this app.
- **Stale stops after large pan** — `fetchNearbyStops` never clears `nearbyStops` on empty result to avoid the radius-race bug. Downside: stops from the previous area remain visible if the user pans far away and the new area returns nothing.
- **`onMapMove` is an inline function** — recreated on every App render, so `onMapMoveRef` is updated on every render. Low cost in practice but worth noting.
- **No stop refresh on mode switch** — returning to 'nearby' after time in Journey/Saved mode doesn't re-fetch stops; they may be stale.

## Planned Changes
- **Auto-re-fetch on mode switch back to 'nearby'** — if the user spent time in Journey/Saved mode, stops could be stale.
- **Clear stale stops when map pans > 2 km from loaded centre** — prevents showing stops for the wrong area after a large pan.
- **Push notifications** — when a tracked departure is < 2 min away, trigger a Web Push notification (requires service worker).
