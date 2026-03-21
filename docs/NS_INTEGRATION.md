# NS/Ferry Departure Data Integration

**Status:** Planning
**Effort estimate:** 1-2 days (Option B stopgap), 0 incremental (Option C with NDOV)
**Monthly cost:** $0 (data mapping only)

---

## 1. The Problem

The departure board in Komt ie? is blind to NS trains, ferries, and some regional operators.

### Root cause: Stop ID mismatch

There are two stop ID systems in Dutch public transport:

| System | ID format | Example | Used by |
|--------|-----------|---------|---------|
| **KV7 TPC** (TimingPointCode) | 8+ digits | `30003560` | OVapi `/tpc/{code}`, KV6 events, NDOV |
| **openov-nl** | 7 digits | `9200001` (Amsterdam Centraal) | GTFS feeds, journey planners |

The current `http_departures.js` Lambda calls `OVapi /tpc/{codes}`, which only accepts KV7 TPCs. The frontend already works around this for bus/tram/metro:

```javascript
// App.jsx line 173 — find nearest KV7 stop for departures
const nearestKv7 = allStops.find(s => s.tpc && s.tpc.length >= 8);
```

But this workaround fails for:

1. **NS train stations** — The openov-nl stop ID (e.g., `9200001` for Amsterdam Centraal) has no corresponding KV7 TPC because NS does not participate in the KV7 system. There is no 8-digit stop within 100m of most train platforms.

2. **Ferries** — Similar situation. Ferry terminals have openov-nl IDs but often no KV7 TPC.

3. **Regional rail** — Arriva, Keolis, and Breng trains have openov-nl IDs but inconsistent KV7 coverage.

### User impact

When a user clicks on a train station or ferry terminal:
- The stop is selected (name shown, location highlighted)
- The departure board shows **nothing** (no KV7 TPC found for OVapi)
- Or it shows departures from a nearby bus stop, not the train station

---

## 2. Solution Options

### Option A: NS API Integration

NS (Nederlandse Spoorwegen) provides a public API at `ns-api.nl` for train departure times.

**How it works:**
1. Register for an NS API key (free for personal use, rate-limited)
2. Map openov-nl station IDs to NS station codes (e.g., `9200001` = `ASD` for Amsterdam Centraal)
3. When a 7-digit train station stop is requested, call the NS API instead of OVapi
4. Parse NS API response into the same departure format used by the rest of the app

**Pros:**
- Official NS data, high quality
- Includes platform assignments, train composition, disruption info

**Cons:**
- Only covers NS trains (not Arriva, Keolis, ferries, buses)
- Requires maintaining a separate station code mapping table
- Adds another external API dependency
- Rate limited (may need caching strategy)
- Does not solve the general stop ID mapping problem

**NS API endpoint:**
```
GET https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/departures
  ?station=ASD
  &maxJourneys=20
Headers:
  Ocp-Apim-Subscription-Key: {your-key}
```

### Option B: Stop ID Mapping (Stopgap)

Build a mapping between openov-nl 7-digit IDs and KV7 8-digit TPCs where they overlap geographically.

**How it works:**
1. During `refresh_stops.js`, after loading both KV7 and openov-nl stops:
   - For each openov-nl stop (7-digit ID), find the nearest KV7 stop within 100m
   - Store the mapping as `stop_mapping.json` in S3
2. In `http_departures.js`, when a 7-digit stop is requested:
   - Look up the mapped KV7 stop(s)
   - Fetch departures for those KV7 stops from OVapi
   - Return with a note that data comes from a nearby KV7 stop

**Pros:**
- Works for all operators that have both KV7 and openov-nl stops (most bus/tram/metro)
- No new API dependencies
- Cheap (mapping built during existing daily refresh)

**Cons:**
- Does NOT solve NS trains (no KV7 stops at most train stations)
- Does NOT solve ferries (same reason)
- Mapping can be imprecise (100m radius may match wrong stops at large transit hubs)
- Adds maintenance burden (mapping must be rebuilt daily)

### Option C: NDOV KV6 (Full Solution)

Once NDOV ZeroMQ integration is live (see `NDOV_INTEGRATION.md`), it provides departure events for ALL operators including NS trains and ferries.

**How it works:**
1. KV6 DEPARTURE/ARRIVAL events include `userstopcode` (KV7 TPC) and `dataownercode` (operator)
2. NS trains emit KV6 events with station TPCs that ARE in the KV7 system
3. The `process_kv6.js` Lambda builds a real-time departure list from these events
4. `http_departures.js` can serve departures from the KV6 event stream instead of OVapi

**Pros:**
- Covers ALL operators (NS, Arriva, Keolis, ferries, all buses/trams/metros)
- Sub-second freshness (vs 14s cache with OVapi)
- No stop ID mapping needed (KV6 uses the same TPCs)
- Removes OVapi dependency for departures entirely
- Includes punctuality data (seconds early/late, not just "realtime" boolean)

**Cons:**
- Requires NDOV ZeroMQ infrastructure (EC2 instance, ~$7/month)
- More complex to implement (event accumulation, departure list construction)
- Must handle edge cases (e.g., trip that has passed but END event not received)

---

## 3. Recommended Approach

**Long-term: Option C (NDOV)** — This is the only option that provides full coverage of all operators and modes. It eliminates the stop ID mismatch problem entirely because KV6 events use KV7 TPCs natively.

**Stopgap: Option B (mapping)** — Implement this first to improve coverage for bus/tram/metro stops that have both openov-nl and KV7 IDs. This handles the most common case (user clicks an openov-nl bus stop) while NDOV integration is being built.

**Skip: Option A (NS API)** — Not worth the implementation effort given that Option C provides the same data plus more. Only consider Option A if NDOV integration is indefinitely delayed and NS trains are a user priority.

---

## 4. Implementation Plan for Option B (Stopgap)

### Step 1: Build the mapping during daily refresh (1 hour)

Modify `lambda/refresh_stops.js` to build a mapping after the stops cache is saved.

**Changes to `lambda/refresh_stops.js`:**

```javascript
// After saving stops_cache.json, build stop ID mapping
async function buildStopMapping(stops) {
  // Separate stops by ID length
  const kv7Stops = [];    // 8+ digit TPCs
  const openovStops = [];  // 7-digit IDs

  for (const stop of stops) {
    if (!stop.tpc) continue;
    if (stop.tpc.length >= 8) {
      kv7Stops.push(stop);
    } else if (stop.tpc.length === 7) {
      openovStops.push(stop);
    }
  }

  console.log(`[mapping] ${kv7Stops.length} KV7 stops, ${openovStops.length} openov-nl stops`);

  // Build spatial grid for KV7 stops (100m cells)
  const grid = new Map();
  for (const stop of kv7Stops) {
    const key = `${Math.floor(stop.lat * 1000)},${Math.floor(stop.lon * 1000)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(stop);
  }

  // For each openov-nl stop, find nearest KV7 stop within 100m
  const mapping = {};
  let mapped = 0;

  for (const stop of openovStops) {
    const latCell = Math.floor(stop.lat * 1000);
    const lonCell = Math.floor(stop.lon * 1000);

    let nearest = null;
    let nearestDist = Infinity;

    for (let dlat = -1; dlat <= 1; dlat++) {
      for (let dlon = -1; dlon <= 1; dlon++) {
        const nearby = grid.get(`${latCell + dlat},${lonCell + dlon}`);
        if (!nearby) continue;
        for (const kv7 of nearby) {
          const dist = haversineM(stop.lat, stop.lon, kv7.lat, kv7.lon);
          if (dist < nearestDist && dist <= 100) {
            nearestDist = dist;
            nearest = kv7;
          }
        }
      }
    }

    if (nearest) {
      mapping[stop.tpc] = {
        kv7Tpc: nearest.tpc,
        kv7Name: nearest.name,
        distance: Math.round(nearestDist),
      };
      mapped++;
    }
  }

  console.log(`[mapping] Mapped ${mapped} of ${openovStops.length} openov-nl stops to KV7 stops`);

  // Save mapping to S3
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: 'stop_mapping.json',
    Body: JSON.stringify(mapping),
    ContentType: 'application/json',
  }));

  return { mapped, total: openovStops.length };
}
```

### Step 2: Use the mapping in http_departures.js (1 hour)

Modify `lambda/http_departures.js` to look up mapped stops.

**Changes to `lambda/http_departures.js`:**

```javascript
// Module-level cache for stop mapping
let stopMapping = null;
let mappingFetchedAt = 0;

async function getStopMapping() {
  if (stopMapping && Date.now() - mappingFetchedAt < 3600000) return stopMapping;
  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: process.env.STOPS_BUCKET || process.env.CACHE_BUCKET,
      Key: 'stop_mapping.json',
    }));
    stopMapping = JSON.parse(await obj.Body.transformToString());
    mappingFetchedAt = Date.now();
    return stopMapping;
  } catch {
    return {};
  }
}

// In the handler, before calling OVapi:
const resolvedCodes = [];
const mappedFrom = {}; // track which codes were mapped

for (const code of stopCodes) {
  if (code.length >= 8) {
    // Already a KV7 TPC — use directly
    resolvedCodes.push(code);
  } else {
    // 7-digit openov-nl ID — look up mapped KV7 stop
    const mapping = await getStopMapping();
    const mapped = mapping[code];
    if (mapped) {
      resolvedCodes.push(mapped.kv7Tpc);
      mappedFrom[mapped.kv7Tpc] = {
        originalStop: code,
        kv7Name: mapped.kv7Name,
        distance: mapped.distance,
      };
    }
    // If no mapping exists, the code is silently dropped (no OVapi data available)
  }
}

// Fetch from OVapi with resolved codes
const data = await getDeparturesMulti(resolvedCodes);
const departures = parseTpcResponse(data);

// Annotate departures that came from a mapped stop
for (const dep of departures) {
  if (mappedFrom[dep.stopCode]) {
    dep.mappedFrom = mappedFrom[dep.stopCode];
  }
}
```

### Step 3: Frontend indicator (30 min)

When departures come from a mapped stop, show a note in the departure board.

**Changes to `frontend/src/DepartureBoard.jsx`:**

```jsx
{departure.mappedFrom && (
  <span className="mapped-note">
    via {departure.mappedFrom.kv7Name} ({departure.mappedFrom.distance}m)
  </span>
)}
```

### Step 4: Handle unmapped stops gracefully (30 min)

When a 7-digit stop has no mapping (e.g., NS train station), show a clear message instead of an empty departure board.

```jsx
{departures.length === 0 && selectedStop?.tpc?.length === 7 && (
  <div className="no-departures-message">
    <p>No departure data available for this stop.</p>
    <p className="hint">
      Train station and ferry departures are not yet supported.
    </p>
  </div>
)}
```

---

## 5. Implementation Plan for Option C (NDOV-based departures)

This builds on the NDOV ZeroMQ integration described in `NDOV_INTEGRATION.md`.

### Step 1: Build departure lists from KV6 events (2 hours)

The `process_kv6.js` Lambda already updates per-trip state in DynamoDB. Extend it to maintain a per-stop departure list.

**New DynamoDB table: `komt-ie-stop-departures`**

| Attribute | Type | Description |
|-----------|------|-------------|
| `stopCode` | String (PK) | KV7 TPC |
| `departures` | List | Array of upcoming departures at this stop |
| `updatedAt` | Number | Last update timestamp |
| `expiresAt` | Number | TTL (2 hours after last update) |

**Departure list construction logic:**

```javascript
// When a DEPARTURE event is received for stop X:
//   1. Remove this trip from stop X's departure list (it has departed)
//   2. Add this trip to the NEXT stop's departure list (it's now approaching)
//      Next stop = look up in the trip's stop_times from the trip index

// When an ARRIVAL event is received for stop X:
//   1. Update this trip's entry in stop X's departure list:
//      status = "ARRIVED", actualArrival = timestamp

// When an ONSTOP event is received for stop X:
//   1. Update status = "AT_STOP"

// When an END event is received:
//   1. Remove this trip from all stop departure lists
```

### Step 2: Serve departures from DynamoDB (1 hour)

Modify `http_departures.js` to read from the `stop-departures` table instead of calling OVapi.

```javascript
// Decision logic:
// 1. Check DynamoDB stop-departures table
// 2. If fresh data (< 60s): return it
// 3. If stale or missing: fall back to OVapi (current approach)
// 4. Merge both sources, deduplicate by journey number
```

### Step 3: Include all operators (30 min)

KV6 events cover all operators. The departure list automatically includes:
- NS trains (dataownercode: NS, NSINTERNATIONAL)
- Arriva trains and buses
- Keolis trains and buses
- Ferry operators (dataownercode varies)
- All bus/tram/metro operators

No stop ID mapping needed — KV6 uses KV7 TPCs natively.

---

## 6. Data Volume Estimates

### Option B (mapping)

| Data | Size | Updated |
|------|------|---------|
| `stop_mapping.json` | ~500KB (estimated 15,000-20,000 mappable stops) | Daily |

### Option C (NDOV departures)

| Data | Size | Updated |
|------|------|---------|
| DynamoDB `stop-departures` | ~4,000 active stops x ~1KB each = ~4MB | Real-time (~30 writes/sec) |
| DynamoDB cost (on-demand) | ~$1.20/month for writes | |

---

## 7. Current Frontend Stop ID Handling (Reference)

The frontend already has partial handling for the KV7/openov-nl split. Here is the current flow when a user clicks a stop:

```
User clicks stop on map
  ↓
App.jsx handleStopSelect(stop)
  ↓
Is stop.tpc >= 8 digits?
  ├── YES → Subscribe to OVapi departures for this TPC
  │         (works for bus/tram/metro)
  └── NO  → Fetch /api/stops/nearby?lat=...&lon=...&radius=1.5
             ↓
             Find nearest KV7 stop (>= 8 digits) in response
             ├── Found → Subscribe to that KV7 stop's departures
             │           Show "Departures from {kv7Name}" note
             └── Not found → No departures shown
```

After Option B, the flow changes:

```
User clicks stop on map
  ↓
App.jsx handleStopSelect(stop)
  ↓
Frontend sends stop TPC to /api/departures?stops=CODE
  ↓
http_departures.js:
  Is code >= 8 digits?
  ├── YES → Fetch OVapi directly
  └── NO  → Look up in stop_mapping.json
             ├── Mapped → Fetch OVapi with mapped KV7 TPC
             └── Not mapped → Return empty (train station/ferry)
```

After Option C, the flow simplifies to:

```
User clicks stop on map
  ↓
Frontend sends stop TPC to /api/departures?stops=CODE
  ↓
http_departures.js:
  Read DynamoDB stop-departures for this code
  ├── Fresh data → Return departures (all operators)
  └── No data    → Fall back to OVapi
```

---

## 8. Mapping Coverage Estimate

Based on analysis of the two stop datasets:

| Category | openov-nl stops | Have KV7 within 100m | Coverage |
|----------|----------------|---------------------|----------|
| Bus stops | ~35,000 | ~30,000 (85%) | Good |
| Tram stops | ~800 | ~750 (94%) | Good |
| Metro stops | ~200 | ~190 (95%) | Good |
| Train stations | ~400 | ~50 (12%) | Poor |
| Ferry terminals | ~40 | ~5 (12%) | Poor |
| **Total** | ~36,440 | ~31,000 (85%) | |

The mapping (Option B) covers 85% of stops but fails precisely for the modes users most want: trains and ferries. This is why Option C (NDOV) is the long-term solution.

---

## 9. Open Questions

1. **NS station TPCs in KV6**: Do NS train stations have KV7-format TPCs in KV6 events, or do they use a different stop code system? This needs verification with actual KV6 data after NDOV registration.

2. **Ferry operators in KV6**: Which ferry operators emit KV6 events? Connexxion ferries (e.g., GVB ferry Amsterdam) likely do. IJmuiden-Newcastle (DFDS) likely does not.

3. **Stop mapping radius**: 100m works for isolated stops but may cause false matches at large transit hubs (e.g., Utrecht Centraal has bus stops, tram stops, and train platforms all within 100m). May need transport-mode-aware matching.

4. **Frontend UX for unmapped stops**: Should we show a "departures not available" message, or silently show nothing? A message is more honest but may seem broken. Consider linking to 9292.nl as a fallback for train departures.
