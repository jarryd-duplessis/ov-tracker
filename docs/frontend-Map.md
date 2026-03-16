# Map.jsx — Live Map Component

## Role
Renders a MapLibre GL JS map showing the user's location, nearby stop markers, and live vehicle positions. Handles tracked-departure highlighting and pan-to-vehicle behaviour. The map is **never unmounted** (hidden with `display:none` in journey mode) so vehicle tracking stays alive between tab switches.

## Props
| Prop | Type | Description |
|---|---|---|
| `userLocation` | `{lat, lon}\|null` | Drives the one-time flyTo and the live position dot |
| `nearbyStops` | `Stop[]` | Rendered as 🚏 label markers |
| `departures` | `Departure[]` | Passed through but currently unused inside Map (used by DepartureBoard) |
| `onMapMove` | `({lat, lon}) => void` | Called (debounced 600 ms) on every `moveend`; triggers stop re-fetch in App |
| `trackedDeparture` | `Departure\|null` | When set, the matching vehicle gets a pulsing ring and the map pans to it |

## Internal refs (not state — avoids re-renders)
| Ref | Purpose |
|---|---|
| `mapRef` | MapLibre `Map` instance |
| `markersRef` | Array of stop `Marker` objects — replaced wholesale on `nearbyStops` change |
| `userMarkerRef` | Single blue dot marker |
| `vehicleMarkersRef` | Array of vehicle `Marker` objects — replaced on every render cycle |
| `hasCenteredRef` | `boolean` — ensures flyTo only fires on the first GPS fix |
| `moveTimerRef` | Debounce timer for `onMapMove` |
| `onMapMoveRef` | Stable ref to the `onMapMove` prop — avoids re-initialising the map when App re-renders |
| `trackedDepartureRef` | Stable ref to `trackedDeparture` — read inside the vehicle polling closure |
| `lastTrackedIdRef` | `string\|null` — set to the tracked trip key once the pan has fired; prevents re-panning every poll cycle |
| `renderInViewportRef` | Ref to `renderInViewport` fn — called immediately when `trackedDeparture` changes so the map pans without waiting for the next 8 s poll |

## Lifecycle / useEffects
1. **Map init** (`[]` deps) — creates the `Map`, adds `NavigationControl`, wires `moveend` debounce, attaches `ResizeObserver` for mobile blank-tile fix.
2. **User location** (`[userLocation]`) — first fix: `flyTo` zoom 15; every fix: move/create the blue dot marker.
3. **Stop markers** (`[nearbyStops]`) — clears old markers, recreates one per stop with a popup.
4. **Vehicle polling** (`[]` deps) — creates `renderInViewport` (viewport-filtered vehicle render + tracked-vehicle pan), stores it in `renderInViewportRef`, calls immediately, then every 5 s via `setInterval`. Also re-renders on `moveend`.

## Vehicle rendering
- Fetches `GET /api/vehicles` every 5 s.
- Filters to only vehicles within the current map bounds (viewport culling).
- **Tracked vehicle**: 32 px circle with `trackPulse` CSS animation ring; bearing arrow instead of dot.
- **Untracked vehicle**: 18 px coloured dot; rotated bearing arrow if `bearing !== 0`.
- Vehicle-to-departure matching (`matchesTracked`): primary check is `tripId.includes(String(journeyNumber))`; fallback is `vehicle.line === dep.line`.

## Tile source
`https://tiles.openfreemap.org/styles/dark` — free, no API key required.

## Known Issues
- **Vehicle matching fallback is imprecise** — `vehicle.line === dep.line` will match any vehicle on that line, not the specific trip. Multiple vehicles on the same line could all show as "tracked". Primary `tripId` match is correct but not all GTFS-RT feeds populate `tripId`.
- **ResizeObserver fires excessively on some mobile browsers** — each `resize()` call forces a tile re-render. Could be throttled.
- **Stop markers are not clickable** — tapping a stop marker shows a popup but doesn't switch to that stop's departures in the sidebar.
- **Vehicle 429 rate limiting** — `GET /api/vehicles` backend falls back to cached positions when GTFS-RT feed returns 429. Server-side cache TTL is 5 s; positions are stale by at most ~5 s under normal conditions. Under sustained 429s positions could lag longer.
- **No clustering** — at low zoom levels, many vehicle markers overlap. No MapLibre clustering is applied.

## Planned Changes
- **Clickable stop markers** — tapping a stop should load its departures in the sidebar and subscribe to it via WS.
- **Vehicle trail / breadcrumb** — keep last N positions per vehicle and draw a faded polyline.
- **Cluster vehicles at zoom < 13** — use MapLibre symbol layer with clustering instead of individual DOM markers.
- **Smooth vehicle interpolation** — interpolate position between poll cycles for smoother movement.
- **Swap DOM markers to GL layers** — current DOM-marker approach doesn't scale past ~500 vehicles; a symbol layer with a GeoJSON source would handle the full NL feed.
