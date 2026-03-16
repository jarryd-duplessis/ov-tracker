# JourneyPlanner.jsx — Journey Planning Panel

## Role
Free-text journey search across the Netherlands. Geocodes the from/to inputs via Nominatim, then fetches up to 3 itineraries from the Motis journey planner. Shown when mode is `'journey'`. The map is hidden (`display:none`) while this panel is active.

## State
| State | Description |
|---|---|
| `from` / `to` | Raw input strings |
| `loading` | True while the `/api/journey` request is in flight |
| `result` | `{ from, to, itineraries }` from the backend |
| `error` | Error string shown if the fetch fails |

## API call
`GET /api/journey?from=<encoded>&to=<encoded>`

Backend geocodes both strings via Nominatim (Netherlands-restricted), then forwards to Motis (`europe.motis-project.de`).

## Itinerary display (ItineraryCard)
- Summary row: mode icons + route badges + times + duration + transfer count
- First itinerary auto-expanded; rest collapsed
- Click to expand/collapse
- Each transit leg shows: line badge, from → to stop names, times, duration, headsign, track, live indicator, cancellation indicator

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
- **Motis covers Europe broadly but NL detail varies** — international routes and NS trains generally work; local bus transfers may be incomplete or absent.
- **No departure time picker** — always plans from "now". No option to plan for a future time.
- **Geocoding is unreliable for street addresses** — Nominatim is better for city/station names. "Hoofddorpplein 5, Amsterdam" may geocode to the wrong place or fail.
- **No autocomplete** — the from/to inputs are plain text with no suggestion dropdown.
- **Motis can be slow or unavailable** — the external service has no SLA; failures produce a generic error.
- **Map hidden during journey mode** — vehicle tracking stops being visible (though it continues running in the background). The map doesn't show the planned route.
- **No price information** — NS and other operator fares are not included.

## Planned Changes
- **Departure time picker** — date/time input to plan future journeys.
- **Autocomplete** — query the local stops index + Nominatim as the user types.
- **Show route on map** — decode the leg geometries and render the journey as a polyline on the map, keeping map visible alongside planner results.
- **NS fare lookup** — integrate NS API to show ticket prices alongside journey options.
- **Favourite routes** — save frequent from/to pairs for one-tap re-search.
