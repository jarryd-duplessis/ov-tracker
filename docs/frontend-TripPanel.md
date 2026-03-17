# TripPanel.jsx — Vehicle Route Panel

## Role
Slide-in sidebar panel showing a vehicle's complete route stops with a visual timeline. Rendered when a vehicle marker is clicked on the map (`selectedVehicle` is non-null). Fetches trip data from `/api/trip`.

## Props
| Prop | Type | Description |
|---|---|---|
| `vehicle` | `Vehicle` | The clicked vehicle object with `id`, `line`, `category` |
| `onClose` | `() => void` | Called when the close button is clicked; App sets `selectedVehicle = null` |

## State
| State | Description |
|---|---|
| `trip` | Trip data from `/api/trip` — `{ headsign, stops }` |
| `loading` | True while fetch is in flight |
| `error` | Error message string if fetch fails |

## API call
`GET /api/trip?vehicleId={id}&line={line}`

Returns `{ headsign, stops }` where each stop has `{ name, arr, dep, lat, lon }`.

## Visual design
- **Header**: Line badge (colored by transport mode) + headsign + close button
- **Timeline**: Vertical line with dots at each stop. First and last stops have larger dots with outer glow (`box-shadow: 0 0 0 3px ${color}22`). Intermediate stops have smaller outlined dots.
- **Times**: Displayed in HH:MM format using `tabular-nums` for alignment
- **Footer**: Stop count + first departure → last arrival time range
- **Loading**: CSS spinner colored to match the transport mode
- **Error**: Styled card with red background

## Transport mode styling
Uses `MODE_COLOR` and `MODE_ICON` maps:
- BUS: green (#4CAF50) 🚌
- TRAM: orange (#FF9800) 🚊
- SUBWAY/METRO: blue (#2196F3) 🚇
- RAIL: purple (#9C27B0) 🚆
- FERRY: cyan (#00BCD4) ⛴️

## Known Issues
- **No live updates** — Trip data is fetched once; stop times are not updated in real-time
- **Vehicle may have moved** — The trip shows the full route, not the vehicle's current position within it
