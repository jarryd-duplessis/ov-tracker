# Map.jsx — Live Map Component

## Role
Renders a MapLibre GL JS map showing the user's location, nearby stop markers, and live vehicle positions. Handles tracked-departure route drawing, stop highlighting, and pan-to-vehicle behaviour. The map is **never unmounted** (hidden with `display:none` in journey mode) so vehicle tracking stays alive between tab switches.

## Props
| Prop | Type | Description |
|---|---|---|
| `userLocation` | `{lat, lon}\|null` | Drives the one-time flyTo on first fix and the live position dot |
| `nearbyStops` | `Stop[]` | Rendered as 🚏 label markers (incremental, no full rebuild) |
| `departures` | `Departure[]` | Passed through; currently unused inside Map (used by DepartureBoard) |
| `onMapMove` | `({lat, lon, radius}) => void` | Called (debounced 600 ms) on user-initiated `moveend`; triggers stop re-fetch in App |
| `onFollowVehicle` | `({lat, lon}) => void` | Called when a vehicle is tapped and followed; triggers nearby stop fetch |
| `onStopClick` | `(stop) => void` | Called when a stop marker is clicked; handled in App to subscribe to that stop |
| `trackedDeparture` | `Departure\|null` | Highlighted vehicle gets a pulsing ring; map flies to the stop on change |
| `centerOn` | `{lat, lon, t}\|null` | Programmatic flyTo trigger from App (e.g. journey planner selects a boarding stop) |
| `journeyRoute` | `Itinerary\|null` | Motis itinerary — non-walk legs are decoded and drawn as a GeoJSON polyline |
| `theme` | `'dark'\|'light'` | Switches map tile style between OpenFreeMap dark and liberty |
| `onVehicleSelect` | `(vehicle\|null) => void` | Called when a vehicle marker is clicked; shows TripPanel |

## Internal refs (no re-renders)
| Ref | Purpose |
|---|---|
| `mapRef` | MapLibre `Map` instance |
| `stopMarkersMapRef` | `tpc → { marker, el }` — incremental stop marker registry; only add/remove what changed |
| `stopMarkerElsRef` | `tpc → DOM element` — for `applyStopStyle()` updates without recreating markers |
| `nearbyStopsRef` | Mirror of `nearbyStops` prop — readable from async closures without stale capture |
| `userMarkerRef` | Single blue dot marker for GPS location |
| `vehicleMarkersRef` | Unused; vehicle state lives in `stateRef` inside the vehicle polling effect |
| `hasCenteredRef` | `boolean` — ensures flyTo fires only on the first GPS fix |
| `moveTimerRef` | Debounce timer for `onMapMove` |
| `onMapMoveRef` | Stable ref to `onMapMove` — avoids re-initialising the map when App re-renders |
| `onFollowVehicleRef` | Stable ref to `onFollowVehicle` |
| `onStopClickRef` | Stable ref to `onStopClick` |
| `trackedDepartureRef` | Current value readable from vehicle polling closure without stale capture |
| `lastTrackedIdRef` | `string\|null` — set to tracked trip key once the first vehicle pan has fired; prevents re-panning every poll cycle |
| `renderInViewportRef` | Ref to `renderInViewport` fn — called immediately on `trackedDeparture` change so the map pans without waiting for the next vehicle poll |
| `followedVehicleIdRef` | Vehicle ID being camera-locked |

## Lifecycle / useEffects

### 1. `centerOn` prop (`[centerOn]`)
Calls `mapRef.current.flyTo` to the given coordinates. Triggered by App when a journey boarding stop is selected.

### 2. `journeyRoute` (`[journeyRoute]`)
Decodes each non-walk leg's `legGeometry.points` (Google polyline, precision 7 from Motis) using `decodePoly`. Builds a GeoJSON `FeatureCollection` with one `LineString` per leg, coloured by transport mode. Updates or creates the `'journey-route'` GeoJSON source and `'journey-route-line'` layer.

Layer insertion: checks `map.getLayer('road-label')` before using it as the `beforeLayer` argument — OpenFreeMap's dark style may not include this layer, so the check prevents a silent `addLayer` failure.

### 3. `trackedDeparture` (`[trackedDeparture]`)
On change:
- Resets `lastTrackedIdRef` so the map will pan again for the new departure
- Calls `renderInViewportRef.current()` immediately (don't wait for next vehicle poll)
- Restores the previously tracked stop's marker to normal style (`applyStopStyle(..., false)`)
- Highlights the newly tracked stop's marker (`applyStopStyle(..., true)`)
- Calls `flyTo` to the tracked stop at zoom ≥ 15

### 4. Map init (`[]` deps — runs once)
Creates the `Map`, adds `NavigationControl`, wires `ResizeObserver` for mobile blank-tile fix.

Tracks whether each movement is user-initiated via `userInitiated` flag set in `movestart`:
```js
mapRef.current.on('movestart', (e) => { userInitiated = !!e.originalEvent; });
mapRef.current.on('moveend', () => {
  if (!userInitiated) return; // programmatic flyTo — don't re-fetch stops
  // debounced onMapMove call
});
```
This prevents `flyTo` calls (from tracked departure, `centerOn`, or vehicle follow) from triggering stop re-fetches.

### 5. User location (`[userLocation]`)
On first fix: `flyTo` zoom 15. Every fix: updates the blue dot marker position.

### 6. Stop markers (`[nearbyStops]`)
**Incremental updates — no full teardown.** Uses `stopMarkersMapRef` (keyed by TPC):
- Removes markers for TPC codes no longer in `nearbyStops`
- For TPC codes already in the map: calls `applyStopStyle` to refresh label/highlight without recreating the marker
- For new TPC codes: creates a new `Marker` and registers it

This prevents the visible flicker that occurred when all markers were removed and recreated on every stop selection.

### Theme switching (`[theme]`)
Calls `mapRef.current.setStyle()` to switch between dark and liberty tile styles when the theme prop changes.

### 7. Vehicle polling (`[]` deps — runs once)
Creates `renderInViewport` (viewport-filtered vehicle render + tracked-vehicle pan), stores it in `renderInViewportRef`, calls immediately, then fetches every 2 s via `setInterval`.

---

## Helper functions

### `decodePoly(encoded, precision = 5)`
Decodes a Google-encoded polyline string. Precision 5 is standard; Motis uses precision 7 for higher accuracy. Returns `[[lon, lat], ...]` in GeoJSON coordinate order.

### `applyStopStyle(el, name, distanceM, isTracked)`
Updates the innerHTML of a stop marker DOM element. Tracked stops get a blue border, glow shadow, and bold text. Non-tracked stops use a muted grey style.

### `LEG_COLOUR`
Maps Motis transport mode strings to hex colours for the route polyline layer:
```
BUS → #4CAF50, TRAM → #FF9800, SUBWAY/METRO → #2196F3
RAIL → #9C27B0, LONG_DISTANCE/HIGHSPEED → #E91E63, FERRY → #00BCD4
```

### `matchesTracked(vehicle, dep)`
Returns `true` if `vehicle.tripId.includes(String(dep.journeyNumber))`. No line-number fallback — the fallback was removed because it matched all vehicles on the same line number, not just the tracked trip.

---

## Vehicle rendering
- Fetches `GET /api/vehicles` every 2 s
- Filters to vehicles within current map bounds (viewport culling)
- Persistent `stateRef` (id → `{ marker, el, lat, lon, styleKey }`) avoids destroying/recreating markers between polls
- Position changes animate via a shared `requestAnimationFrame` loop (smooth interpolation, one rAF for all moving vehicles)
- **Tracked vehicle**: 32 px circle with `trackPulse` CSS animation ring
- **Followed vehicle**: 32 px circle with gold ring; camera locks to it each rAF tick
- **Untracked vehicle**: 18 px coloured dot

## Route-snapped dead reckoning
The vehicle animation system has two phases:
1. **Interpolation (0--1.5s)**: Ease-in-out interpolation from the previous GPS position to the new one
2. **Dead reckoning (1.5s--16.5s)**: Advances the vehicle along its route path at the computed speed

Route paths are fetched asynchronously via `getRoutePath(vehicle)` which calls `/api/trip`. Paths are cached in `routePathCache` (module-level, 1-hour TTL) and `routePathsRef` (per-effect instance).

Helper functions:
- `findOnPath(lon, lat, coords)` — Projects a point onto a polyline, returns `{ segIdx, t, distAlong }`
- `walkAlongPath(coords, segIdx, t, dist)` — Walks a distance along the polyline, returns `{ lon, lat, bearing }`
- `getRoutePath(vehicle)` — Fetches and caches route path coordinates from `/api/trip`

When no route path is available, falls back to straight-line dead reckoning using bearing.

---

## Tile source
`https://tiles.openfreemap.org/styles/dark` — free, no API key required.

---

## Known Issues
- **No vehicle clustering** — At low zoom, many vehicle markers overlap. No MapLibre clustering is applied.
- **ResizeObserver fires on scroll on some browsers** — Each `resize()` call forces tile re-render. Could be throttled with `requestAnimationFrame`.
- **Vehicle 429 rate limiting** — Frontend calls `/api/vehicles` every 2 s; Lambda serves from two-tier cache (5 s in-memory, 8 s S3), so OVapi is called at most once per 8 s. Under sustained 429s positions may lag.
- **Motis route may not match stop** — The auto-fetched journey uses the tracked departure's destination as the `to` query, which Motis geocodes. The resulting itinerary may use a different stop or route variant.

## Planned Changes
- **Cluster vehicles at zoom < 13** — Replace DOM markers with a GeoJSON symbol layer + clustering.
- **Vehicle trail / breadcrumb** — Keep last N positions per vehicle and draw a faded polyline.
- **Swap DOM markers to GL layers** — Current DOM-marker approach doesn't scale past ~500 vehicles; a symbol layer with a GeoJSON source would handle the full NL feed efficiently.
