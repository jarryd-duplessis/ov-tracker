# Server-Side Dead Reckoning

**Status:** Planning
**Effort estimate:** 2-3 days
**Monthly cost:** $0 incremental (reuses existing `ingest_vehicles` Lambda)
**Dependencies:** NDOV ZeroMQ (for stop-level event anchoring); route shapes in trip index (already available)

---

## 1. Why Move Interpolation Server-Side

### Current state

The frontend (`Map.jsx`) performs all vehicle position interpolation client-side. This involves ~400 lines of code across four functions:

| Function | Lines | Purpose |
|----------|-------|---------|
| `findOnPath(lon, lat, coords)` | ~20 | Project a point onto a polyline, return segment index + parameter |
| `walkAlongPath(coords, segIdx, t, dist)` | ~30 | Walk a distance along a polyline from a given position |
| `snapToPath(rawLon, rawLat, path)` | ~15 | Snap an interpolated lat/lon to the nearest point on the route |
| Animation loop (in `useEffect`) | ~150 | Two-phase animation: 4s smoothstep interpolation to GPS, then 20s dead reckoning along route |
| Route path fetching + caching | ~100 | Fetch `/api/trip` for each vehicle's route shape, cache per-vehicle |
| Confidence-based styling | ~50 | Apply visual styles per confidence tier |

Total: ~400 lines of complex geometry and animation code in the frontend.

### Problems with client-side interpolation

1. **Inconsistent positions across clients.** Every browser computes its own interpolation independently. Two users watching the same bus see it at slightly different positions, depending on when their last data fetch completed and local clock differences.

2. **Cannot measure accuracy.** When interpolation runs client-side, there is no way to log interpolated positions and compare them against actual GPS positions. We cannot answer "how accurate is our dead reckoning?" without server-side computation.

3. **Frontend complexity.** The interpolation code is the most complex part of `Map.jsx`. It interacts with the animation frame loop, route path caching, marker management, and confidence tier display. Bugs in this code (overshoot, wrong bearing, snap to wrong route) are hard to reproduce and debug.

4. **Route path fetching per vehicle.** Each vehicle currently triggers a fetch to `/api/trip/{id}` to get the route shape for dead reckoning. At 100+ visible vehicles, this generates 100+ API calls. Server-side interpolation eliminates this entirely because the server already has access to all route shapes.

5. **Dead reckoning overshoots stops.** The current client-side dead reckoning walks along the route shape at the vehicle's last known speed. If the vehicle stops at a bus stop for 30 seconds, the dead reckoning walks right past it. The transport engineering best practice is to hold at 95% of the way to the next stop and reduce confidence.

6. **No anchor events.** Client-side dead reckoning only has GPS positions (refreshed every ~10s). It does not know when the vehicle actually arrived at or departed from a stop. NDOV KV6 provides these stop-level events, which are the natural anchor points for dead reckoning.

### Benefits of server-side interpolation

1. **Consistent positions.** Every user sees the exact same position for every vehicle.
2. **Accuracy measurement.** Server can log both raw GPS and interpolated positions, compute error metrics over time.
3. **Simpler frontend.** ~400 lines of interpolation code removed. Frontend just animates markers from position A to position B.
4. **No per-vehicle API calls.** Route shapes are available server-side; no need for the frontend to fetch them.
5. **Stop-anchored dead reckoning.** With NDOV KV6 events, the server knows exactly when a vehicle arrived at and departed from each stop. Dead reckoning between stops is anchored to real events.
6. **Push-ready.** Server-computed positions are the prerequisite for future WebSocket push (send position updates to clients instead of clients polling).

---

## 2. Architecture

### Per-trip state

The server maintains state for each active trip. This state is updated by two inputs:

1. **GTFS-RT GPS positions** (from OVapi, every ~10s) — raw lat/lon
2. **KV6 stop events** (from NDOV, sub-second) — arrival/departure at specific stops

```
Per-trip state (stored in DynamoDB or in-memory on ingest Lambda):

{
  tripId: "2026-03-21:CXX:U008:72",

  // Last known stop event (from KV6)
  lastKnownStop: {
    code: "30003560",           // KV7 TPC
    name: "Utrecht Centraal",
    departureTime: 1711020600,  // scheduled departure (Unix seconds)
    actualDeparture: 1711020630, // actual departure (from KV6 DEPARTURE event)
    lat: 52.0894, lon: 5.1101,  // stop coordinates
    sequenceIndex: 5,           // index in the trip's stop list
  },

  // Next expected stop (from schedule)
  nextStop: {
    code: "30003570",
    name: "Utrecht Vaartsche Rijn",
    scheduledArrival: 1711020780,  // scheduled arrival (Unix seconds)
    lat: 52.0801, lon: 5.1198,
    sequenceIndex: 6,
  },

  // Route shape segment between last and next stop
  routeSegment: [[5.1101, 52.0894], [5.1115, 52.0870], ..., [5.1198, 52.0801]],

  // Current delay
  currentDelay: 30,  // seconds late (actualDeparture - scheduledDeparture)

  // Last GPS position (from GTFS-RT)
  lastGPSPosition: {
    lat: 52.0855, lon: 5.1150,
    timestamp: 1711020650,
    bearing: 145.2,
    speed: 12.3,  // m/s
  },

  // Server-computed interpolated position (output)
  interpolatedPosition: {
    lat: 52.0840, lon: 5.1165,
    bearing: 148.0,
    confidence: "live",         // 5-tier confidence
    source: "kv6_deadreckon",   // how the position was determined
    fractionToNextStop: 0.35,   // 0-1 progress between stops
  },
}
```

### Interpolation sources (priority order)

The server chooses the best available interpolation method for each vehicle:

| Priority | Source | Condition | Confidence | Method |
|----------|--------|-----------|------------|--------|
| 1 | **KV6 + route shape** | Fresh KV6 event (< 60s) AND route shape available | `live` | Dead-reckon from last stop along route shape |
| 2 | **GPS + route shape** | Fresh GPS (< 15s) AND route shape available | `live` | Snap GPS to route shape, interpolate forward |
| 3 | **GPS only** | Fresh GPS (< 15s), no route shape | `live` | Use GPS directly, interpolate along bearing |
| 4 | **KV6 only** | Fresh KV6 (< 60s), no GPS, no route shape | `recent` | Place at last stop position |
| 5 | **Stale GPS** | GPS 15s-60s old | `recent` | Last known GPS, no interpolation |
| 6 | **Stale KV6** | KV6 1-5 min old | `estimated` | Dead-reckon with decreasing confidence |
| 7 | **Schedule only** | No real-time data | `scheduled` | Schedule-based position along route |
| 8 | **No data** | No data for > 5 min | `unknown` | Exclude from tiles |

### Dead reckoning algorithm

```
function deadReckonFromStop(tripState, now):
  // Time since last stop departure (adjusted for delay)
  elapsed = now - tripState.lastKnownStop.actualDeparture

  // Expected travel time between stops (from schedule, adjusted for delay)
  scheduledTravelTime = tripState.nextStop.scheduledArrival
                      - tripState.lastKnownStop.departureTime
  expectedTravelTime = scheduledTravelTime  // could adjust for delay trends

  // Progress fraction (0 = at last stop, 1 = at next stop)
  fraction = elapsed / expectedTravelTime
  fraction = clamp(fraction, 0, 0.95)  // NEVER go past 95% — hold before next stop

  // Walk along route segment to this fraction
  if tripState.routeSegment:
    position = walkAlongPolyline(tripState.routeSegment, fraction)
    bearing = segmentBearing(tripState.routeSegment, fraction)
  else:
    // Fallback: linear interpolation between stop coordinates
    position = lerp(tripState.lastKnownStop, tripState.nextStop, fraction)
    bearing = bearingBetween(tripState.lastKnownStop, tripState.nextStop)

  // Confidence degrades with time since last real data
  timeSinceData = now - max(
    tripState.lastKnownStop.actualDeparture,
    tripState.lastGPSPosition?.timestamp || 0
  )
  confidence = computeConfidence(timeSinceData)

  return { position, bearing, confidence, fraction }
```

### The 95% rule

Dead reckoning must NEVER place a vehicle past the next stop. If the schedule says the vehicle should arrive at 14:32 and it is now 14:33, the vehicle is held at 95% of the way to the next stop. This is because:

1. The vehicle may be dwelling at the stop (loading passengers)
2. If a KV6 ARRIVAL event arrives, it confirms the vehicle is at the stop
3. If a KV6 DEPARTURE event arrives, dead reckoning starts toward the following stop
4. Overshooting looks wrong to users ("the bus passed my stop but it hasn't arrived")

When held at 95%, the confidence tier drops to `estimated` to signal uncertainty.

### Data flow

```
┌─────────────────────┐     ┌──────────────────────┐
│ NDOV ZeroMQ         │     │ OVapi GTFS-RT        │
│ KV6 stop events     │     │ GPS positions         │
│ (ARRIVAL, DEPARTURE)│     │ (lat/lon every ~10s)  │
└────────┬────────────┘     └────────┬─────────────┘
         │                           │
         │ SQS → process_kv6        │ HTTP fetch
         ▼                           ▼
┌────────────────────────────────────────────────────┐
│ ingest_vehicles.js                                  │
│                                                     │
│ For each vehicle:                                   │
│   1. Read trip_state from DynamoDB                 │
│   2. Read route shape from trip index (S3)         │
│   3. Combine GPS + KV6 + schedule                  │
│   4. Compute interpolated position:                │
│      - Dead-reckon from last stop along shape      │
│      - Snap GPS to route shape                     │
│      - Apply 95% hold rule near stops              │
│   5. Compute confidence tier                       │
│   6. Write to tile:                                │
│      { lat, lon, bearing, speed, confidence,       │
│        fractionToNextStop, source }                │
│                                                     │
│ Log accuracy metrics:                               │
│   - interpolated position vs next GPS position     │
│   - distance error when GPS arrives                │
│   - overshoot count (fraction > 1.0 before clamp) │
└────────────────────┬───────────────────────────────┘
                     │
                     ▼
              ┌──────────────┐
              │ S3 tiles     │
              │ (per tile:   │
              │  vehicles[]  │
              │  with server-│
              │  computed    │
              │  positions)  │
              └──────┬───────┘
                     │
              ┌──────▼───────┐
              │ CloudFront   │
              │ (3s cache)   │
              └──────┬───────┘
                     │
              ┌──────▼───────┐
              │ Frontend     │
              │              │
              │ Just render: │
              │ - Smooth-move│
              │   marker to  │
              │   server pos │
              │ - Apply      │
              │   confidence │
              │   styling    │
              │ - No route   │
              │   path fetch │
              │ - No dead    │
              │   reckoning  │
              └──────────────┘
```

---

## 3. Migration Plan

Server-side dead reckoning is a significant change that affects both backend and frontend. A phased migration avoids breaking the user experience.

### Phase 1: Shadow Mode (1 week)

**Goal:** Server computes interpolated positions but does NOT send them to clients. Compare server vs client accuracy.

**Changes:**
- `ingest_vehicles.js`: Add interpolation logic. For each vehicle, compute `interpolatedPosition` and store in a separate S3 file (`tiles/accuracy_log.json`).
- Compare: When the next GPS position arrives, measure the error between the server's interpolated position and the actual GPS.
- Log metrics to CloudWatch: mean error (meters), P95 error, overshoot count.

**No frontend changes.** The existing client-side dead reckoning continues to work.

**Success criteria:**
- Server interpolation error < 100m (P95) for vehicles with route shapes
- No overshoots past stops (fraction always < 1.0)
- Server handles the computational load within the 10s ingestion cycle

### Phase 2: Dual Mode (1 week)

**Goal:** Server sends interpolated positions in tiles. Frontend uses server positions but keeps its own dead reckoning as fallback.

**Changes:**

Add new fields to each vehicle in the tile response:

```json
{
  "id": "2026-03-21:CXX:U008:72",
  "lat": 52.0840,      // server-interpolated position
  "lon": 5.1165,
  "bearing": 148.0,    // server-computed bearing
  "speed": 12.3,
  "confidence": "live",
  "source": "kv6_deadreckon",
  "fractionToNextStop": 0.35,

  // Raw GPS for comparison (remove in Phase 3)
  "_rawLat": 52.0838,
  "_rawLon": 5.1163
}
```

Frontend changes:
- Use `lat`/`lon` from tile as the target position for animation
- Keep the existing smooth-move animation (4s smoothstep)
- Keep dead reckoning as a fallback when no new tile data arrives within 15s
- Log client-side: when client dead reckoning diverges from next server position by > 50m

**Success criteria:**
- Vehicle movement looks smooth (no visible jumps)
- Server and client positions agree within 50m at each update
- No regression in user experience

### Phase 3: Server Primary (1 week)

**Goal:** Frontend uses server positions exclusively. Client-side dead reckoning reduced to simple 5s smooth-move only.

**Changes:**

Simplify `Map.jsx` animation:

```javascript
// Before: 400 lines of findOnPath, walkAlongPath, snapToPath, dead reckoning
// After: 30 lines of simple smooth-move

const INTERP_MS = 5000; // match tile refresh interval

function updateAnimation(anims, now) {
  for (const [id, a] of Object.entries(anims)) {
    const elapsed = now - a.startTime;
    if (elapsed >= INTERP_MS) {
      // At target position — wait for next server update
      setMarkerPosition(id, a.toLat, a.toLon, a.toBearing);
      continue;
    }
    // Smoothstep interpolation to server-provided position
    const t = smoothstep(elapsed / INTERP_MS);
    const lat = a.fromLat + (a.toLat - a.fromLat) * t;
    const lon = a.fromLon + (a.toLon - a.fromLon) * t;
    const bearing = lerpAngle(a.fromBearing, a.toBearing, t);
    setMarkerPosition(id, lat, lon, bearing);
  }
}
```

Remove from `Map.jsx`:
- `findOnPath()` function
- `walkAlongPath()` function
- `snapToPath()` function
- `routePathsRef` and route path fetching logic
- Dead reckoning phase (Phase 2 of animation)
- Per-vehicle `/api/trip` calls for route shapes

**Lines removed:** ~400
**Lines added:** ~30

**Success criteria:**
- Vehicle movement is smooth
- No per-vehicle `/api/trip` calls from the animation system
- Frontend code is significantly simpler

### Phase 4: Cleanup (1 day)

- Remove `_rawLat`/`_rawLon` from tile response
- Remove dead reckoning fallback code from frontend
- Remove route path caching from `Map.jsx`
- Update CLAUDE.md and documentation

---

## 4. Implementation Details

### 4.1 Route shape loading on the server

The trip index in S3 (`trips/{operator}_{route}.json`) already contains route shapes:

```json
{
  "72": {
    "headsign": "Utrecht Centraal",
    "stops": [
      { "seq": 1, "arr": "05:34:00", "dep": "05:34:00", "name": "Nieuwegein", "lat": 52.03, "lon": 5.08 },
      { "seq": 2, "arr": "05:38:00", "dep": "05:38:00", "name": "IJsselstein", "lat": 52.02, "lon": 5.04 }
    ],
    "shapeRef": "s0"
  },
  "_shapes": {
    "s0": [[5.08, 52.03], [5.07, 52.025], ..., [5.04, 52.02]]
  }
}
```

The `ingest_vehicles.js` Lambda needs to:

1. Look up the route file for each vehicle's operator + route
2. Find the journey by journey number
3. Extract the route shape and stop list
4. Determine which segment of the shape is between the last and next stop
5. Cache this in memory (route shapes change at most daily)

**Memory budget:** Each route file is 10-50KB. With ~3,000 active routes, the cache needs ~50-150MB. The Lambda currently runs at 256MB; this may need to increase to 512MB.

### 4.2 Extracting the segment between stops

Given a route shape and two consecutive stops, we need the subset of shape points between them:

```javascript
function extractSegment(shape, fromStop, toStop) {
  // Find the shape point nearest to fromStop
  const fromIdx = findNearestShapePoint(shape, fromStop.lon, fromStop.lat);
  // Find the shape point nearest to toStop
  const toIdx = findNearestShapePoint(shape, toStop.lon, toStop.lat);

  if (fromIdx >= toIdx) {
    // Stops are in wrong order or same point — return direct line
    return [[fromStop.lon, fromStop.lat], [toStop.lon, toStop.lat]];
  }

  // Include the exact stop positions at the endpoints
  const segment = [
    [fromStop.lon, fromStop.lat],
    ...shape.slice(fromIdx + 1, toIdx),
    [toStop.lon, toStop.lat],
  ];

  return segment;
}
```

### 4.3 Walking along a polyline to a fraction

```javascript
function walkToFraction(segment, fraction) {
  // Compute total length of segment
  let totalLength = 0;
  for (let i = 1; i < segment.length; i++) {
    totalLength += haversineM(segment[i-1][1], segment[i-1][0],
                              segment[i][1], segment[i][0]);
  }

  const targetDist = totalLength * fraction;
  let accumulated = 0;

  for (let i = 1; i < segment.length; i++) {
    const segLen = haversineM(segment[i-1][1], segment[i-1][0],
                              segment[i][1], segment[i][0]);
    if (accumulated + segLen >= targetDist) {
      // Interpolate within this segment
      const t = (targetDist - accumulated) / segLen;
      const lon = segment[i-1][0] + (segment[i][0] - segment[i-1][0]) * t;
      const lat = segment[i-1][1] + (segment[i][1] - segment[i-1][1]) * t;
      const bearing = computeBearing(segment[i-1][1], segment[i-1][0],
                                     segment[i][1], segment[i][0]);
      return { lat, lon, bearing };
    }
    accumulated += segLen;
  }

  // Past the end — return last point
  const last = segment[segment.length - 1];
  return { lat: last[1], lon: last[0], bearing: 0 };
}
```

### 4.4 Combining GPS and KV6 data

When both GPS and KV6 data are available for a vehicle, the server must decide which to trust:

```javascript
function computePosition(tripState, gpsPosition, now) {
  const hasKV6 = tripState && tripState.lastKnownStop &&
                 (now - tripState.lastKnownStop.actualDeparture) < 60000;
  const hasGPS = gpsPosition && (now - gpsPosition.timestamp) < 15000;
  const hasShape = tripState && tripState.routeSegment &&
                   tripState.routeSegment.length >= 2;

  if (hasKV6 && hasShape) {
    // Best case: dead-reckon from last stop along route shape
    const dr = deadReckonFromStop(tripState, now);

    if (hasGPS) {
      // Sanity check: GPS should be within 200m of dead-reckoned position
      const error = haversineM(dr.lat, dr.lon, gpsPosition.lat, gpsPosition.lon);
      if (error > 200) {
        // GPS and dead reckoning disagree — trust GPS, log the discrepancy
        console.warn(`[dr] ${tripState.tripId}: GPS/DR error ${error.toFixed(0)}m`);
        return snapToShape(gpsPosition, tripState.routeSegment, 'gps_snap');
      }
    }

    return { ...dr, source: 'kv6_deadreckon' };
  }

  if (hasGPS && hasShape) {
    // Snap GPS to route shape
    return snapToShape(gpsPosition, tripState.routeSegment, 'gps_snap');
  }

  if (hasGPS) {
    // GPS only, no route shape — use raw GPS
    return {
      lat: gpsPosition.lat, lon: gpsPosition.lon,
      bearing: gpsPosition.bearing, confidence: 'live',
      source: 'gps_raw',
    };
  }

  if (hasKV6) {
    // KV6 only, no shape — place at last stop
    return {
      lat: tripState.lastKnownStop.lat, lon: tripState.lastKnownStop.lon,
      bearing: 0, confidence: 'recent',
      source: 'kv6_at_stop',
    };
  }

  // No data
  return null;
}
```

---

## 5. Accuracy Metrics

Server-side interpolation enables measuring dead reckoning accuracy for the first time.

### Metrics to track

| Metric | Definition | Target |
|--------|-----------|--------|
| **Position error (P50)** | Median distance between interpolated position and next GPS position | < 30m |
| **Position error (P95)** | 95th percentile distance error | < 100m |
| **Overshoot rate** | % of updates where fraction > 1.0 before clamping | < 1% |
| **Stop-anchored accuracy** | Error when KV6 stop events anchor the dead reckoning | < 20m |
| **GPS-only accuracy** | Error when only GPS is available (no KV6) | < 50m |
| **Shape snap error** | Distance from raw GPS to snapped-on-shape position | < 30m |

### Logging format

```json
{
  "tripId": "2026-03-21:CXX:U008:72",
  "timestamp": 1711020660,
  "interpolated": { "lat": 52.0840, "lon": 5.1165 },
  "actualGps": { "lat": 52.0838, "lon": 5.1163 },
  "errorMeters": 18.5,
  "source": "kv6_deadreckon",
  "fractionToNextStop": 0.35,
  "confidence": "live",
  "hadKV6": true,
  "hadShape": true,
  "secondsSinceLastStop": 30,
  "secondsSinceLastGps": 8
}
```

These logs are written to the event persistence pipeline (see IMPLEMENTATION_PLAN.md Step 5) and can be queried with Athena for accuracy analysis.

---

## 6. Edge Cases

### Vehicle at terminus (end of route)

When a vehicle reaches the last stop on its route, dead reckoning has nowhere to go. The vehicle should be held at the last stop until an `END` KV6 event or the vehicle disappears from the GTFS-RT feed.

### Vehicle on detour

If a vehicle deviates from its scheduled route (construction, incident), the route shape becomes invalid. Detection: GPS position > 200m from nearest point on route shape. Response: switch to `gps_raw` source, mark confidence as `estimated`.

### Route shape not available

Some routes (especially new or temporary ones) may not have shapes in the trip index. Fallback: linear interpolation between stop coordinates (less accurate at curves but functional).

### Multiple trips on same route

A vehicle's trip ID changes when it starts a new trip. The KV6 INIT event signals this. The server must reset the per-trip state and start dead reckoning from the new trip's first stop.

### KV6 event arrives out of order

ZeroMQ delivers messages in order per connection, but network issues could cause delays. If a DEPARTURE event arrives after a later ARRIVAL event, the server should use the latest timestamp, not the latest received event.

### Lambda cold start and state recovery

The `ingest_vehicles` Lambda may cold-start and lose in-memory state. Per-trip state is stored in DynamoDB and route shapes in S3, so recovery is immediate. The only lost data is the in-memory route shape cache, which is rebuilt on the next cycle.

---

## 7. Dependencies

| Dependency | Required for | Status |
|-----------|-------------|--------|
| NDOV ZeroMQ | Stop-level events (KV6) to anchor dead reckoning | See `NDOV_INTEGRATION.md` |
| Trip index with shapes | Route shapes for walking along paths | Already available (`trips/*.json`) |
| Route shape segment extraction | Extracting path between consecutive stops | New code needed |
| DynamoDB trip_state table | Per-trip state storage | Created as part of NDOV integration |
| Increased Lambda memory | Route shape cache (~100-150MB) | 256MB -> 512MB |

### Without NDOV (GPS-only dead reckoning)

Server-side dead reckoning can work without NDOV, using only GPS positions. The flow is:

1. Receive GPS position from GTFS-RT
2. Snap to route shape
3. Determine which segment the vehicle is on (between which two stops)
4. Dead-reckon forward at measured speed along the route shape
5. Apply 95% hold rule near the next stop

This is less accurate than KV6-anchored dead reckoning because:
- GPS positions are noisy (can snap to wrong segment at intersections)
- No stop dwell detection (dead reckoning walks through stops)
- Speed measurement is from position deltas (noisy at low speeds)

But it is still better than client-side dead reckoning because positions are consistent across all clients and accuracy can be measured.

---

## 8. Scaffolding: Server-Side Interpolation Module

File: `lambda/lib/interpolation.js`

```javascript
'use strict';

// Server-side dead reckoning and position interpolation.
// Called by ingest_vehicles.js for each vehicle on every cycle.

/**
 * Compute interpolated position for a vehicle.
 *
 * @param {Object} params
 * @param {Object} params.gps - Latest GPS position { lat, lon, bearing, speed, timestamp }
 * @param {Object|null} params.tripState - KV6-derived trip state from DynamoDB
 * @param {Array|null} params.routeShape - Full route shape [[lon,lat], ...]
 * @param {Array|null} params.stops - Ordered stop list [{ lat, lon, code, arr, dep }, ...]
 * @param {number} params.now - Current timestamp (ms)
 * @returns {Object} { lat, lon, bearing, confidence, source, fractionToNextStop }
 */
function interpolatePosition({ gps, tripState, routeShape, stops, now }) {
  // Priority 1: KV6 + route shape
  if (tripState && isKV6Fresh(tripState, now) && routeShape) {
    const segment = extractSegmentBetweenStops(
      routeShape, stops,
      tripState.lastStopIndex, tripState.lastStopIndex + 1
    );
    if (segment && segment.length >= 2) {
      const result = deadReckonFromStop(tripState, segment, now);

      // Sanity check against GPS if available
      if (gps && isGPSFresh(gps, now)) {
        const error = haversineM(result.lat, result.lon, gps.lat, gps.lon);
        if (error > 200) {
          // Large disagreement — fall through to GPS-based methods
          return snapGPSToShape(gps, routeShape, now);
        }
      }
      return result;
    }
  }

  // Priority 2: GPS + route shape
  if (gps && isGPSFresh(gps, now) && routeShape) {
    return snapGPSToShape(gps, routeShape, now);
  }

  // Priority 3: GPS only
  if (gps && isGPSFresh(gps, now)) {
    return {
      lat: gps.lat, lon: gps.lon,
      bearing: gps.bearing || 0,
      confidence: computeConfidenceFromAge(now - gps.timestamp),
      source: 'gps_raw',
      fractionToNextStop: null,
    };
  }

  // Priority 4: KV6 only (place at last stop)
  if (tripState && isKV6Fresh(tripState, now)) {
    return {
      lat: tripState.lastStopLat, lon: tripState.lastStopLon,
      bearing: 0,
      confidence: 'recent',
      source: 'kv6_at_stop',
      fractionToNextStop: 0,
    };
  }

  // Priority 5: Stale GPS
  if (gps && (now - gps.timestamp) < 300000) {
    return {
      lat: gps.lat, lon: gps.lon,
      bearing: gps.bearing || 0,
      confidence: computeConfidenceFromAge(now - gps.timestamp),
      source: 'gps_stale',
      fractionToNextStop: null,
    };
  }

  // No usable data
  return null;
}

function isKV6Fresh(tripState, now) {
  return tripState.updatedAt && (now - tripState.updatedAt) < 60000;
}

function isGPSFresh(gps, now) {
  return gps.timestamp && (now - gps.timestamp) < 15000;
}

function computeConfidenceFromAge(ageMs) {
  if (ageMs < 15000) return 'live';
  if (ageMs < 60000) return 'recent';
  if (ageMs < 300000) return 'estimated';
  return 'scheduled';
}

/**
 * Dead-reckon from the last stop along a route segment.
 * Uses elapsed time since last stop departure and scheduled travel time
 * to compute fraction of progress between stops.
 * Clamps at 95% to avoid overshooting.
 */
function deadReckonFromStop(tripState, segment, now) {
  const elapsed = now - (tripState.actualDeparture || tripState.scheduledDeparture);
  const scheduledTravel = tripState.nextStopScheduledArrival - tripState.lastStopScheduledDeparture;

  if (scheduledTravel <= 0) {
    // Can't compute fraction — place at last stop
    return {
      lat: segment[0][1], lon: segment[0][0],
      bearing: 0, confidence: 'recent',
      source: 'kv6_at_stop', fractionToNextStop: 0,
    };
  }

  // Fraction of journey between stops (0 = at last stop, 1 = at next stop)
  let fraction = (elapsed / 1000) / scheduledTravel;
  const wasOvershoot = fraction > 1.0;
  fraction = Math.max(0, Math.min(fraction, 0.95)); // 95% cap

  const pos = walkToFraction(segment, fraction);

  return {
    lat: pos.lat, lon: pos.lon,
    bearing: pos.bearing,
    confidence: wasOvershoot ? 'estimated' : 'live',
    source: 'kv6_deadreckon',
    fractionToNextStop: fraction,
  };
}

/**
 * Snap a GPS position to the nearest point on a route shape.
 */
function snapGPSToShape(gps, shape, now) {
  let bestDist = Infinity, bestIdx = 0, bestT = 0;

  for (let i = 0; i < shape.length - 1; i++) {
    const ax = shape[i][0], ay = shape[i][1];
    const bx = shape[i+1][0], by = shape[i+1][1];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((gps.lon - ax) * dx + (gps.lat - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const dist = (gps.lon - px) ** 2 + (gps.lat - py) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
      bestT = t;
    }
  }

  const ax = shape[bestIdx][0], ay = shape[bestIdx][1];
  const bx = shape[bestIdx+1][0], by = shape[bestIdx+1][1];
  const lon = ax + bestT * (bx - ax);
  const lat = ay + bestT * (by - ay);
  const bearing = computeBearing(ay, ax, by, bx);

  return {
    lat, lon, bearing,
    confidence: computeConfidenceFromAge(now - gps.timestamp),
    source: 'gps_snap',
    fractionToNextStop: null,
  };
}

/**
 * Extract the segment of a route shape between two consecutive stops.
 */
function extractSegmentBetweenStops(shape, stops, fromIdx, toIdx) {
  if (!stops || fromIdx < 0 || toIdx >= stops.length) return null;
  const from = stops[fromIdx];
  const to = stops[toIdx];

  // Find nearest shape points to each stop
  const fromShapeIdx = findNearestShapePoint(shape, from.lon, from.lat);
  const toShapeIdx = findNearestShapePoint(shape, to.lon, to.lat);

  if (fromShapeIdx >= toShapeIdx) {
    return [[from.lon, from.lat], [to.lon, to.lat]];
  }

  return [
    [from.lon, from.lat],
    ...shape.slice(fromShapeIdx + 1, toShapeIdx),
    [to.lon, to.lat],
  ];
}

function findNearestShapePoint(shape, lon, lat) {
  let bestDist = Infinity, bestIdx = 0;
  for (let i = 0; i < shape.length; i++) {
    const dist = (shape[i][0] - lon) ** 2 + (shape[i][1] - lat) ** 2;
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return bestIdx;
}

/**
 * Walk along a polyline to a given fraction (0-1) of its total length.
 * Returns { lat, lon, bearing }.
 */
function walkToFraction(segment, fraction) {
  let totalLength = 0;
  const segLengths = [];
  for (let i = 1; i < segment.length; i++) {
    const len = haversineM(segment[i-1][1], segment[i-1][0],
                           segment[i][1], segment[i][0]);
    segLengths.push(len);
    totalLength += len;
  }

  const targetDist = totalLength * fraction;
  let accumulated = 0;

  for (let i = 0; i < segLengths.length; i++) {
    if (accumulated + segLengths[i] >= targetDist) {
      const t = segLengths[i] > 0 ? (targetDist - accumulated) / segLengths[i] : 0;
      const lon = segment[i][0] + (segment[i+1][0] - segment[i][0]) * t;
      const lat = segment[i][1] + (segment[i+1][1] - segment[i][1]) * t;
      const bearing = computeBearing(segment[i][1], segment[i][0],
                                     segment[i+1][1], segment[i+1][0]);
      return { lat, lon, bearing };
    }
    accumulated += segLengths[i];
  }

  const last = segment[segment.length - 1];
  return { lat: last[1], lon: last[0], bearing: 0 };
}

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

module.exports = {
  interpolatePosition,
  deadReckonFromStop,
  snapGPSToShape,
  extractSegmentBetweenStops,
  walkToFraction,
};
```

---

## 9. Frontend After Migration

After Phase 3, the vehicle animation code in `Map.jsx` simplifies to:

```javascript
// ── Vehicle animation (simplified: server provides interpolated positions) ──

const SMOOTH_MS = 5000; // match tile refresh interval

useEffect(() => {
  // Simple smooth-move: animate marker from current position to server position
  const anims = {};

  function animate() {
    const now = Date.now();
    for (const [id, a] of Object.entries(anims)) {
      const elapsed = now - a.startTime;
      if (elapsed >= SMOOTH_MS) {
        // At target — hold position until next server update
        a.marker.setLngLat([a.toLon, a.toLat]);
        if (a.marker._element) a.marker._element.style.transform += ` rotate(${a.toBearing}deg)`;
        continue;
      }
      // Smoothstep interpolation
      const raw = elapsed / SMOOTH_MS;
      const t = raw * raw * (3 - 2 * raw);
      const lat = a.fromLat + (a.toLat - a.fromLat) * t;
      const lon = a.fromLon + (a.toLon - a.fromLon) * t;
      a.marker.setLngLat([lon, lat]);
    }
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);

  // On new vehicle data: update animation targets
  // (called when tile data refreshes)
  function onVehicleUpdate(vehicle) {
    const existing = anims[vehicle.id];
    const currentPos = existing?.marker?.getLngLat();
    anims[vehicle.id] = {
      marker: existing?.marker || createMarker(vehicle),
      fromLat: currentPos?.lat || vehicle.lat,
      fromLon: currentPos?.lng || vehicle.lon,
      toLat: vehicle.lat,    // server-interpolated position
      toLon: vehicle.lon,
      toBearing: vehicle.bearing,
      startTime: Date.now(),
    };
    // Apply confidence styling
    applyConfidenceStyle(anims[vehicle.id].marker, vehicle.confidence);
  }

  return () => { /* cleanup markers */ };
}, []);
```

This replaces ~400 lines with ~50 lines. No `findOnPath`, no `walkAlongPath`, no `snapToPath`, no route path fetching, no dead reckoning phase.

---

## 10. Open Questions

1. **Lambda memory:** Route shape caching adds ~100-150MB to memory requirements. The current Lambda runs at 256MB. Increasing to 512MB costs ~$0.35/month more. Alternatively, only cache shapes for vehicles currently visible in any user's viewport (requires knowing which tiles are being requested).

2. **DynamoDB read cost:** Reading trip_state for ~4,000 vehicles every 10s = ~34M reads/month. At 0.25 RCU (eventual consistency, items < 4KB), on-demand cost is ~$1/month. Acceptable.

3. **GPS vs KV6 priority:** When both disagree by 50-200m, which to trust? GPS is spatially precise but noisy. KV6 is temporally precise (exact stop events) but requires dead reckoning between stops. Current plan: trust KV6 + shape if error < 200m, fall back to GPS otherwise.

4. **Shape matching for vehicles not on a trip:** Some GTFS-RT vehicles have no trip ID or an unrecognized trip ID. These vehicles can only use GPS-based interpolation. Currently ~29% of vehicles fall in this category.

5. **Interpolation cycle time:** Adding route shape loading and dead reckoning computation to the ingestion cycle. Currently each cycle takes ~2s. Target: < 5s including interpolation for ~4,000 vehicles.
