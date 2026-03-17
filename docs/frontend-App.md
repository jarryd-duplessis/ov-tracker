# App.jsx — Root Component

## Role
Application shell. Owns all shared state, wires GPS → stop fetch → departure polling, and renders the top bar + mode-switched sidebar alongside the persistent map.

## State
| State | Type | Description |
|---|---|---|
| `userLocation` | `{lat, lon}\|null` | Live GPS fix; drives map centering and nearby-stop fetch |
| `nearbyStops` | `Stop[]` | Stops returned by the last successful `/api/stops/nearby` call |
| `locationError` | `string\|null` | Human-readable geolocation error shown in the error banner |
| `loadingStops` | `boolean` | True while a stop fetch is in flight |
| `isMobile` | `boolean` | `window.innerWidth < 768`, recalculated on resize |
| `mode` | `'nearby'\|'journey'\|'saved'` | Which sidebar panel is active |
| `trackedDeparture` | `Departure\|null` | The departure currently being followed on the map |
| `journeyRoute` | `Itinerary\|null` | Motis itinerary whose leg geometry is drawn on the map |
| `mapCenter` | `{lat, lon, t}\|null` | Signals Map to fly to a specific coordinate; `t` is a timestamp to force re-trigger on same coords |
| `savedTrips` | `Trip[]` | Persisted to `localStorage` under `komt-ie-saved-trips` |
| `selectedVehicle` | `Vehicle\|null` | Vehicle object when user clicks a vehicle marker on the map; renders TripPanel |
| `theme` | `'dark'\|'light'` | Persisted to localStorage under `komt-ie-theme`; drives Map tile style and CSS tokens |

## Key refs
| Ref | Purpose |
|---|---|
| `watchIdRef` | Geolocation `watchPosition` ID, cleared on unmount |
| `lastStopFetchRef` | `{lat, lon}` of the last stop fetch; prevents re-fetching when GPS jitter < 100 m |
| `userSelectedStopRef` | `boolean` — set `true` when the user explicitly clicked a stop marker; suppresses GPS and map-pan overrides until the user pans manually |
| `nearbyStopsRef` | Mirror of `nearbyStops` state kept in a ref so it's readable from async effects without capturing stale closures |
| `routeEpochRef` | `number` — incremented synchronously in `handleStopClick` and `handleVehicleSelect` to invalidate in-flight route fetches. The `.then` callback checks `routeEpochRef.current !== epoch` to discard stale results |

## Data flow
```
GPS watchPosition
  → setUserLocation (map dot)
  → fetchNearbyStops (if moved > 100 m AND userSelectedStopRef is false)
    → GET /api/stops/nearby
    → setNearbyStops
    → subscribe(stopCodes)   ← triggers WebSocket subscribe (debounced 800 ms)
      → WS subscription stored in DynamoDB (no push)

Frontend polling (via useOVWebSocket)
  → GET /api/departures?stops=TPC1,TPC2 (every ~14 s)
  → setDepartures → departure board re-renders

Map moveend (user pan/zoom only)
  → userSelectedStopRef = false (releases stop-selection lock)
  → fetchNearbyStops (debounced 600 ms, zoom ≥ 13)
    → same path as GPS above
```

## Stop selection (`handleStopClick`)
Called when a stop marker on the map is clicked. Sets `userSelectedStopRef = true` to suppress subsequent GPS and pan overrides. Also:
- Increments `routeEpochRef` to invalidate in-flight route fetches
- Calls `setMapCenter` to fly the map back to the clicked stop (prevents the map staying zoomed out after a previous route fitBounds)
- Clears `selectedVehicle` and `journeyRoute`

- **KV7 stop (TPC ≥ 8 chars)**: immediately calls `setNearbyStops([stop])` and `subscribe([stop.tpc])` for that stop only.
- **openov-nl stop (7-digit ID)**: finds KV7 stops in `nearbyStops` within 300 m and subscribes to those. Falls back to `fetchNearbyStops(stop.lat, stop.lon, 0.3)` if no KV7 stops are visible nearby.

## Vehicle selection (`handleVehicleSelect`)
Called when a vehicle marker on the map is clicked. Increments `routeEpochRef`, sets `selectedVehicle` (which renders `TripPanel` in the sidebar), and clears `journeyRoute` and `trackedDeparture`.

## Theme toggle
`toggleTheme` switches between `'dark'` and `'light'`. Persisted to localStorage and applied to `document.documentElement` via `data-theme` attribute. CSS variables in `index.css` respond to `[data-theme="light"]`.

## Journey selection (`handleSelectJourney`)
Called when the user clicks "Select this journey" in the JourneyPlanner. Finds the first transit (non-walk) leg's boarding stop, calls `fetchNearbyStops` for that location, sets `mapCenter` to trigger a Map flyTo, then switches mode to `'nearby'` so the map becomes visible.

## Journey route auto-fetch
A `useEffect` on `trackedDeparture` automatically fetches the route whenever a departure is tracked:
```
trackedDeparture changes
  → find stop in nearbyStopsRef (by tpc)
  → GET /api/journey?fromLat=&fromLon=&to=<destination>
  → pick itinerary matching dep.line (or first itinerary)
  → setJourneyRoute(it) → Map draws polyline
```
Aborted via `AbortController` if the tracked departure changes before the fetch completes.

## Trip tracking (`handleTrack`)
Sets `trackedDeparture`. Passing `null` untracks and clears `journeyRoute`. Forces mode to `'nearby'` so the map is visible.

## Trip saving (`handleToggleSave` / `handleUnsave`)
Adds/removes from `savedTrips` and writes to localStorage. `savedIds` (useMemo Set) provides O(1) saved-state lookups for child components.

## Tab badge
Active saved trips (expected time > −3 min) are counted and shown as `⭐ Saved (N)`.

## Radius logic
`fetchNearbyStops` is called with several radii depending on context:
- GPS or pan: **1.5 km** (default)
- Stop click fallback: **0.3 km** (tight area around that stop only)
- Journey selection boarding stop: **0.3 km**
- Vehicle follow: **0.4 km**

Empty results do **not** clear `nearbyStops` — only a non-empty result replaces them.

## Known Issues
- **100 m GPS threshold** — `lastStopFetchRef` prevents re-fetching on GPS jitter but also means a significantly wrong initial fix (e.g. indoors) won't correct until the user moves 100 m.
- **`journeyRoute` uses first best-match itinerary** — The route drawn may not exactly match the user's departure if Motis returns a different boarding stop or service pattern.
- **No stop refresh on mode switch** — Returning to 'nearby' after time in Journey/Saved mode doesn't re-fetch stops; they may be stale.
- **`onMapMove` is an inline function** — Recreated on every App render; `onMapMoveRef` in Map.jsx absorbs this without causing map re-initialisation.

## Planned Changes
- **Auto-re-fetch on mode switch back to 'nearby'** — If the user spent time in Journey/Saved mode, stops could be stale.
- **Client-side `minutesUntil` recalculation** — Recompute every 30 s using `expectedTime` (ISO-8601) so displayed countdowns stay accurate without waiting for the next poll.
- **Push notifications** — When a tracked departure is < 2 min away, trigger a Web Push notification (requires service worker).
