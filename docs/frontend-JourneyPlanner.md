# JourneyPlanner.jsx — Journey Planning Panel

## Role
Free-text journey search across the Netherlands. Geocodes the from/to inputs via Nominatim, then fetches up to 3 itineraries from the Motis journey planner. Shown when mode is `'journey'`. The map is hidden (`display:none`) while this panel is active, but continues polling vehicle positions in the background.

## Props
| Prop | Type | Description |
|---|---|---|
| `onSelectJourney` | `(itinerary) => void` | Called when the user confirms a journey; App switches to map mode and draws the route |

## State
| State | Description |
|---|---|
| `from` / `to` | Raw input strings |
| `loading` | True while the `/api/journey` request is in flight |
| `result` | `{ from, to, itineraries }` from the backend |
| `error` | Error string shown if the fetch fails |
| `selectedKey` | Index of the currently selected itinerary (for button state feedback) |

## API call
`GET /api/journey?from=<encoded>&to=<encoded>`

Backend geocodes both strings via Nominatim (Netherlands-restricted, single result), then forwards to Motis (`europe.motis-project.de`). Returns `{ from, to, itineraries }`.

## Itinerary display (ItineraryCard)
- Summary row: mode icons + route badges + departure/arrival times + duration + transfer count
- First itinerary auto-expanded; rest collapsed
- Click to expand/collapse
- Each transit leg shows: line badge, from → to stop names, times, duration, headsign, track, live indicator, cancellation indicator

### "Select this journey" button
Appears in the expanded body of each `ItineraryCard`. Clicking it:
1. Sets `selectedKey` to the card's index (button changes to "✓ Journey selected — tracking on map")
2. Calls `onSelectJourney(it)` (App.jsx: `handleSelectJourney`) which:
   - Finds the first transit leg's boarding stop coordinates
   - Calls `fetchNearbyStops` for that location (subscribes departure board to that stop)
   - Sets `mapCenter` to fly the map to that stop
   - Switches mode to `'nearby'` so the map becomes visible

The route polyline is drawn by App.jsx's `trackedDeparture` → journey route auto-fetch, not directly by the journey planner.

## LegRow
- Walk legs show simplified "Walk N min" row
- Transit legs show full line badge + stop names + times
- Mode colours: WALK `#555`, BUS `#4CAF50`, TRAM `#FF9800`, SUBWAY/METRO `#2196F3`, RAIL `#9C27B0`, LONG_DISTANCE/HIGHSPEED `#E91E63`, FERRY `#00BCD4`

## External dependencies
| Service | Usage |
|---|---|
| Nominatim (OSM) | Geocoding from/to strings to lat/lon, Netherlands-restricted |
| Motis (`europe.motis-project.de`) | Multi-modal journey planning |

Both are third-party services — no API key, subject to availability.

## Known Issues
- **Motis covers Europe broadly but NL detail varies** — International routes and NS trains generally work; local bus transfers may be incomplete or absent.
- **No departure time picker** — Always plans from "now". No option to plan for a future time.
- **Geocoding is unreliable for street addresses** — Nominatim is better for city/station names. Street addresses may geocode to the wrong place or fail.
- **No autocomplete** — The from/to inputs are plain text with no suggestion dropdown.
- **Motis can be slow or unavailable** — The external service has no SLA; failures produce a generic error.
- **Map hidden during journey mode** — Vehicle tracking continues in the background but isn't visible. After selecting a journey, mode switches to `'nearby'` and the map reappears.
- **No price information** — NS and other operator fares are not included.
- **`selectedKey` is not reset between searches** — After a new search, the previous selection indicator may persist visually on the new results.

## Planned Changes
- **Departure time picker** — Date/time input to plan future journeys.
- **Autocomplete** — Query the local stops index + Nominatim as the user types.
- **NS fare lookup** — Integrate NS API to show ticket prices alongside journey options.
- **Favourite routes** — Save frequent from/to pairs for one-tap re-search.
- **Reset `selectedKey` on new search** — Clear the selection state when a new query is submitted.
