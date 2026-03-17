'use strict';

const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { parseCsvLine } = require('./csv');

const s3 = new S3Client({});
const BUCKET = process.env.STOPS_BUCKET || process.env.CACHE_BUCKET;

// Per-container in-memory cache for trip route lookups
const routeCache = {};    // routeKey → { data, fetchedAt }
const ROUTE_CACHE_TTL = 3600000; // 1 hour

// ── Build trip index (called from refresh_stops Lambda) ─────────────────

function getGtfsUrls() {
  const urls = [];
  for (let d = 0; d <= 3; d++) {
    const dt = new Date(Date.now() - d * 86400000);
    const ymd = dt.toISOString().slice(0, 10).replace(/-/g, '');
    urls.push(`https://gtfs.ovapi.nl/govi/gtfs-kv7-${ymd}.zip`);
  }
  return urls;
}

async function buildTripIndex() {
  const JSZip = require('jszip');

  // Download KV7 GTFS
  const urls = getGtfsUrls();
  let zipBuffer = null;
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) continue;
        zipBuffer = Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(timeout);
      }
      break;
    } catch { continue; }
  }
  if (!zipBuffer) throw new Error('Could not download KV7 GTFS');

  const zip = await JSZip.loadAsync(zipBuffer);

  // Parse stops.txt → { stopId: { name, lat, lon } }
  const stopsText = await zip.file('stops.txt').async('string');
  const stops = {};
  const stopsLines = stopsText.trim().split('\n');
  const stopsHeaders = parseCsvLine(stopsLines[0]).map(h => h.trim());
  const sId = stopsHeaders.indexOf('stop_id');
  const sName = stopsHeaders.indexOf('stop_name');
  const sLat = stopsHeaders.indexOf('stop_lat');
  const sLon = stopsHeaders.indexOf('stop_lon');
  for (let i = 1; i < stopsLines.length; i++) {
    if (!stopsLines[i].trim()) continue;
    const cols = parseCsvLine(stopsLines[i]);
    const lat = parseFloat(cols[sLat]);
    const lon = parseFloat(cols[sLon]);
    if (isNaN(lat) || isNaN(lon)) continue;
    stops[cols[sId]] = { name: (cols[sName] || '').trim(), lat, lon };
  }
  console.log(`[trips] Parsed ${Object.keys(stops).length} stops`);

  // Parse routes.txt → { routeId: shortName }
  const routesText = await zip.file('routes.txt').async('string');
  const kv7Routes = {};
  const routesLines = routesText.trim().split('\n');
  const routesHeaders = parseCsvLine(routesLines[0]).map(h => h.trim());
  const rId = routesHeaders.indexOf('route_id');
  const rShort = routesHeaders.indexOf('route_short_name');
  for (let i = 1; i < routesLines.length; i++) {
    if (!routesLines[i].trim()) continue;
    const cols = parseCsvLine(routesLines[i]);
    kv7Routes[cols[rId]] = (cols[rShort] || '').trim();
  }
  console.log(`[trips] Parsed ${Object.keys(kv7Routes).length} routes`);

  // Parse trips.txt → { tripId: { headsign, routeId } }
  const tripsText = await zip.file('trips.txt').async('string');
  const trips = {};
  const tripsLines = tripsText.trim().split('\n');
  const tripsHeaders = parseCsvLine(tripsLines[0]).map(h => h.trim());
  const tId = tripsHeaders.indexOf('trip_id');
  const tHead = tripsHeaders.indexOf('trip_headsign');
  const tRoute = tripsHeaders.indexOf('route_id');
  for (let i = 1; i < tripsLines.length; i++) {
    if (!tripsLines[i].trim()) continue;
    const cols = parseCsvLine(tripsLines[i]);
    trips[cols[tId]] = { headsign: (cols[tHead] || '').trim(), routeId: cols[tRoute] || '' };
  }
  console.log(`[trips] Parsed ${Object.keys(trips).length} trips`);

  // Parse stop_times.txt → group by tripId
  const stText = await zip.file('stop_times.txt').async('string');
  const stLines = stText.trim().split('\n');
  const stHeaders = parseCsvLine(stLines[0]).map(h => h.trim());
  const stTrip = stHeaders.indexOf('trip_id');
  const stArr = stHeaders.indexOf('arrival_time');
  const stDep = stHeaders.indexOf('departure_time');
  const stStop = stHeaders.indexOf('stop_id');
  const stSeq = stHeaders.indexOf('stop_sequence');

  // Build route-level index: routeKey → { journeyNum → { headsign, stops[] } }
  const routes = {};
  for (let i = 1; i < stLines.length; i++) {
    if (!stLines[i].trim()) continue;
    const cols = parseCsvLine(stLines[i]);
    const tripId = cols[stTrip];
    const tripMeta = trips[tripId];
    if (!tripMeta) continue;

    const stopId = cols[stStop];
    const stop = stops[stopId];
    if (!stop) continue;

    // tripId format: OPERATOR|ROUTE|SERVICE|JOURNEYNUM|DIRECTION
    const parts = tripId.split('|');
    if (parts.length < 5) continue;
    const routeKey = `${parts[0]}|${parts[1]}`;
    const journeyNum = parts[3];

    if (!routes[routeKey]) routes[routeKey] = {};
    if (!routes[routeKey][journeyNum]) {
      routes[routeKey][journeyNum] = { headsign: tripMeta.headsign, stops: [] };
    }
    routes[routeKey][journeyNum].stops.push({
      seq: parseInt(cols[stSeq]),
      arr: cols[stArr],
      dep: cols[stDep],
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
    });
  }

  // Build line index: operator:lineNumber → [routeKey, ...] for fallback lookups
  // This maps the route_short_name (line number displayed to passengers) to the
  // internal KV7 route code, since GTFS-RT entity IDs use different route codes.
  const lineIndex = {};
  for (const [routeKey] of Object.entries(routes)) {
    const [operator, routeCode] = routeKey.split('|');
    // Find the route_short_name for any trip on this route
    for (const tripId of Object.keys(trips)) {
      if (!tripId.startsWith(`${operator}|${routeCode}|`)) continue;
      const shortName = kv7Routes[trips[tripId].routeId];
      if (shortName) {
        const lineKey = `${operator}:${shortName}`;
        if (!lineIndex[lineKey]) lineIndex[lineKey] = [];
        if (!lineIndex[lineKey].includes(routeCode)) {
          lineIndex[lineKey].push(routeCode);
        }
        break; // one match per route is enough
      }
    }
  }

  // Sort stops and upload per-route files to S3
  let uploaded = 0;
  const uploadPromises = [];
  for (const [routeKey, journeys] of Object.entries(routes)) {
    for (const jn of Object.keys(journeys)) {
      journeys[jn].stops.sort((a, b) => a.seq - b.seq);
    }
    const key = `trips/${routeKey.replace('|', '_')}.json`;
    uploadPromises.push(
      s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: JSON.stringify(journeys),
        ContentType: 'application/json',
      })).then(() => { uploaded++; })
    );
    // Batch uploads to avoid overwhelming S3
    if (uploadPromises.length >= 50) {
      await Promise.all(uploadPromises.splice(0));
    }
  }
  await Promise.all(uploadPromises);

  // Upload line index
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: 'trips/line_index.json',
    Body: JSON.stringify(lineIndex),
    ContentType: 'application/json',
  }));
  console.log(`[trips] Uploaded ${uploaded} route trip files + line index (${Object.keys(lineIndex).length} entries) to S3`);
}

// ── Build openov-nl trip index (supplements KV7 for remaining ~29% of vehicles) ──

async function buildOpenOvTripIndex() {
  const JSZip = require('jszip');
  const { createInterface } = require('readline');

  const OPENOV_URL = 'https://gtfs.ovapi.nl/openov-nl/gtfs-openov-nl.zip';

  // 1. List existing KV7 trip files so we skip routes already covered
  const existingRoutes = new Set();
  let continuationToken;
  do {
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: 'trips/',
      ContinuationToken: continuationToken,
    }));
    for (const obj of (listRes.Contents || [])) {
      // trips/OPERATOR_ROUTE.json → OPERATOR_ROUTE
      const m = obj.Key.match(/^trips\/(.+)\.json$/);
      if (m && m[1] !== 'line_index') existingRoutes.add(m[1]);
    }
    continuationToken = listRes.IsTruncated ? listRes.NextContinuationToken : undefined;
  } while (continuationToken);
  console.log(`[openov] Found ${existingRoutes.size} existing KV7 trip files`);

  // 2. Download openov-nl GTFS zip
  console.log('[openov] Downloading openov-nl GTFS...');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let zipBuffer;
  try {
    const res = await fetch(OPENOV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    zipBuffer = Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
  console.log(`[openov] Downloaded ${(zipBuffer.length / 1048576).toFixed(1)} MB`);

  const zip = await JSZip.loadAsync(zipBuffer);

  // 3. Parse stops.txt → { stopId: { name, lat, lon } }
  const stopsText = await zip.file('stops.txt').async('string');
  const stops = {};
  const stopsLines = stopsText.trim().split('\n');
  const stopsHeaders = parseCsvLine(stopsLines[0]).map(h => h.trim());
  const sId = stopsHeaders.indexOf('stop_id');
  const sName = stopsHeaders.indexOf('stop_name');
  const sLat = stopsHeaders.indexOf('stop_lat');
  const sLon = stopsHeaders.indexOf('stop_lon');
  for (let i = 1; i < stopsLines.length; i++) {
    if (!stopsLines[i].trim()) continue;
    const cols = parseCsvLine(stopsLines[i]);
    const lat = parseFloat(cols[sLat]);
    const lon = parseFloat(cols[sLon]);
    if (isNaN(lat) || isNaN(lon)) continue;
    stops[cols[sId]] = { name: (cols[sName] || '').trim(), lat, lon };
  }
  console.log(`[openov] Parsed ${Object.keys(stops).length} stops`);

  // 4. Parse trips.txt → build route groupings from realtime_trip_id
  // realtime_trip_id format: "OPERATOR:ROUTE:JOURNEYNUM"
  const tripsText = await zip.file('trips.txt').async('string');
  const tripsLines = tripsText.trim().split('\n');
  const tripsHeaders = parseCsvLine(tripsLines[0]).map(h => h.trim());
  const tId = tripsHeaders.indexOf('trip_id');
  const tRtId = tripsHeaders.indexOf('realtime_trip_id');
  const tHead = tripsHeaders.indexOf('trip_headsign');

  // tripId → { routeKey, journeyNum, headsign }
  // routeKey → first tripId seen (representative trip)
  const tripMeta = {};
  const representativeTrip = {}; // routeKey → tripId (first one wins)
  for (let i = 1; i < tripsLines.length; i++) {
    if (!tripsLines[i].trim()) continue;
    const cols = parseCsvLine(tripsLines[i]);
    const tripId = cols[tId];
    const rtId = (cols[tRtId] || '').trim();
    if (!rtId) continue;

    const parts = rtId.split(':');
    if (parts.length < 3) continue;
    const operator = parts[0];
    const route = parts[1];
    const journeyNum = parts.slice(2).join(':'); // in case journeyNum has colons
    const routeKey = `${operator}_${route}`;
    const headsign = (cols[tHead] || '').trim();

    tripMeta[tripId] = { routeKey, journeyNum, headsign };

    if (!representativeTrip[routeKey]) {
      representativeTrip[routeKey] = tripId;
    }
  }
  console.log(`[openov] Parsed ${Object.keys(tripMeta).length} trips, ${Object.keys(representativeTrip).length} routes`);

  // Determine which routes to skip (already covered by KV7)
  const routesToBuild = new Set();
  for (const routeKey of Object.keys(representativeTrip)) {
    if (!existingRoutes.has(routeKey)) {
      routesToBuild.add(routeKey);
    }
  }
  console.log(`[openov] ${routesToBuild.size} new routes to build (${Object.keys(representativeTrip).length - routesToBuild.size} already covered by KV7)`);

  if (routesToBuild.size === 0) {
    console.log('[openov] No new routes to build, done');
    return;
  }

  // Build set of representative trip IDs we need stop_times for
  const neededTripIds = new Set();
  for (const routeKey of routesToBuild) {
    neededTripIds.add(representativeTrip[routeKey]);
  }

  // Free tripsText memory
  // (tripsLines and tripsText are no longer needed)

  // 5. Stream-parse stop_times.txt — only keep entries for representative trips
  // routes: routeKey → { journeyNum → { headsign, stops[] } }
  const routes = {};

  const stFile = zip.file('stop_times.txt');
  const stStream = stFile.nodeStream('nodebuffer');
  const rl = createInterface({ input: stStream, crlfDelay: Infinity });

  let headersParsed = false;
  let stTrip, stArr, stDep, stStop, stSeq;

  for await (const line of rl) {
    if (!line.trim()) continue;

    if (!headersParsed) {
      const headers = parseCsvLine(line).map(h => h.trim());
      stTrip = headers.indexOf('trip_id');
      stArr = headers.indexOf('arrival_time');
      stDep = headers.indexOf('departure_time');
      stStop = headers.indexOf('stop_id');
      stSeq = headers.indexOf('stop_sequence');
      headersParsed = true;
      continue;
    }

    const cols = parseCsvLine(line);
    const tripId = cols[stTrip];

    // Only process representative trips for routes we need
    if (!neededTripIds.has(tripId)) continue;

    const meta = tripMeta[tripId];
    if (!meta) continue;

    const stopId = cols[stStop];
    const stop = stops[stopId];
    if (!stop) continue;

    const { routeKey, journeyNum, headsign } = meta;

    if (!routes[routeKey]) routes[routeKey] = {};
    if (!routes[routeKey][journeyNum]) {
      routes[routeKey][journeyNum] = { headsign, stops: [] };
    }
    routes[routeKey][journeyNum].stops.push({
      seq: parseInt(cols[stSeq]),
      arr: cols[stArr],
      dep: cols[stDep],
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
    });
  }

  // 6. Sort stops and upload per-route files to S3
  let uploaded = 0;
  const uploadPromises = [];
  for (const [routeKey, journeys] of Object.entries(routes)) {
    for (const jn of Object.keys(journeys)) {
      journeys[jn].stops.sort((a, b) => a.seq - b.seq);
    }
    const key = `trips/${routeKey}.json`;
    uploadPromises.push(
      s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: JSON.stringify(journeys),
        ContentType: 'application/json',
      })).then(() => { uploaded++; })
    );
    if (uploadPromises.length >= 50) {
      await Promise.all(uploadPromises.splice(0));
    }
  }
  await Promise.all(uploadPromises);
  console.log(`[openov] Uploaded ${uploaded} route trip files to S3`);
}

// ── Lookup a single trip (called from http_trip Lambda) ─────────────────

// Line index cache (maps operator:lineNumber → [routeCode, ...])
let lineIndexCache = null;
let lineIndexFetchedAt = 0;

async function getLineIndex() {
  if (lineIndexCache && Date.now() - lineIndexFetchedAt < ROUTE_CACHE_TTL) {
    return lineIndexCache;
  }
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'trips/line_index.json' }));
    lineIndexCache = JSON.parse(await obj.Body.transformToString());
    lineIndexFetchedAt = Date.now();
    return lineIndexCache;
  } catch {
    return {};
  }
}

async function fetchRouteData(operator, routeCode) {
  const routeKey = `${operator}|${routeCode}`;
  const s3Key = `trips/${operator}_${routeCode}.json`;
  const cached = routeCache[routeKey];
  if (cached && Date.now() - cached.fetchedAt < ROUTE_CACHE_TTL) {
    return cached.data;
  }
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
    const data = JSON.parse(await obj.Body.transformToString());
    routeCache[routeKey] = { data, fetchedAt: Date.now() };
    return data;
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.name === 'AccessDenied') return null;
    throw e;
  }
}

function findJourney(data, journeyNum) {
  if (!data) return null;
  // Exact match
  if (data[journeyNum]) return data[journeyNum];
  // Fuzzy match: find the closest journey number
  const target = parseInt(journeyNum);
  if (isNaN(target)) return null;
  let bestKey = null, bestDist = Infinity;
  for (const key of Object.keys(data)) {
    const dist = Math.abs(parseInt(key) - target);
    if (dist < bestDist) { bestDist = dist; bestKey = key; }
  }
  // Accept fuzzy match if within 5 of the target
  if (bestKey && bestDist <= 5) return data[bestKey];
  // Otherwise return any trip on this route (same stops, different times)
  if (bestKey) return data[bestKey];
  return null;
}

async function getTripStops(operator, route, journeyNum, line) {
  // Try direct lookup by route code from the GTFS-RT entity ID
  const data = await fetchRouteData(operator, route);
  const direct = findJourney(data, journeyNum);
  if (direct) return direct;

  // Fallback: use the line index to find the correct KV7 route code
  if (line) {
    const index = await getLineIndex();
    const routeCodes = index[`${operator}:${line}`] || [];
    for (const code of routeCodes) {
      if (code === route) continue; // already tried
      const altData = await fetchRouteData(operator, code);
      const result = findJourney(altData, journeyNum);
      if (result) return result;
    }
  }

  return null;
}

module.exports = { buildTripIndex, buildOpenOvTripIndex, getTripStops };
