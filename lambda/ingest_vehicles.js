'use strict';

// Ingestion Lambda — runs on 1-minute EventBridge schedule.
// Loops internally at ~5s intervals to maintain near-real-time vehicle tiles.
//
// Pipeline: GTFS-RT protobuf → compute bearing/speed/confidence → write tiles to S3
//           → append raw events to S3 buffer (flushed every 5 min)

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const s3 = new S3Client({});
const BUCKET = process.env.CACHE_BUCKET;
const VEHICLE_POSITIONS_URL = 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb';

// Tile grid: 0.1° lat × 0.15° lon ≈ 11km × 10km per tile
// Netherlands: lat 50.5-53.7, lon 3.3-7.3
const TILE_LAT_SIZE = 0.1;
const TILE_LON_SIZE = 0.15;

const { parseCsvLine } = require('./lib/csv');
const fs = require('fs');
const path = require('path');

// ── Route metadata (for line names, categories, colours) ──────────────────

let routesCache = null;
function loadRoutes() {
  if (routesCache) return routesCache;
  const lines = fs.readFileSync(path.join(__dirname, 'routes.txt'), 'utf8').trim().split('\n');
  const headers = parseCsvLine(lines[0]);
  const idCol = headers.indexOf('route_id');
  const nameCol = headers.indexOf('route_short_name');
  const typeCol = headers.indexOf('route_type');
  const colorCol = headers.indexOf('route_color');
  routesCache = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const id = cols[idCol];
    if (!id) continue;
    const t = parseInt(cols[typeCol] || '3');
    const category = (t === 0 || t === 900) ? 'TRAM' : t === 1 ? 'SUBWAY' : (t === 2 || (t >= 100 && t <= 199)) ? 'RAIL' : t === 4 ? 'FERRY' : 'BUS';
    routesCache[id] = {
      shortName: nameCol >= 0 ? (cols[nameCol] || '') : '',
      category,
      color: '#' + (colorCol >= 0 ? (cols[colorCol] || '4CAF50') : '4CAF50'),
    };
  }
  return routesCache;
}

// ── Previous positions for bearing/speed computation ──────────────────────

let prevPositions = {}; // id → { lat, lon, t }
let prevPositionsLoaded = false;

async function loadPrevPositions() {
  if (prevPositionsLoaded) return;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'tiles/prev_positions.json' }));
    prevPositions = JSON.parse(await obj.Body.transformToString());
    prevPositionsLoaded = true;
  } catch {
    prevPositionsLoaded = true; // first run, no previous data
  }
}

async function savePrevPositions(newPositions) {
  prevPositions = newPositions;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: 'tiles/prev_positions.json',
    Body: JSON.stringify(newPositions),
    ContentType: 'application/json',
  })).catch(e => console.warn('[ingest] Failed to save prev positions:', e.message));
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

// ── Confidence tiers ──────────────────────────────────────────────────────

function computeConfidence(feedTimestamp, now) {
  const ageMs = now - feedTimestamp;
  if (ageMs < 15000) return 'live';        // < 15s
  if (ageMs < 60000) return 'recent';      // 15s - 1 min
  if (ageMs < 300000) return 'estimated';  // 1 - 5 min
  return 'scheduled';                       // > 5 min (shouldn't happen with fresh feed)
}

// ── Tile bucketing ────────────────────────────────────────────────────────

function tileKey(lat, lon) {
  const latBucket = Math.floor(lat / TILE_LAT_SIZE);
  const lonBucket = Math.floor(lon / TILE_LON_SIZE);
  return `${latBucket}_${lonBucket}`;
}

// ── Event buffer for persistence ──────────────────────────────────────────

let eventBuffer = [];
let lastFlushTime = Date.now();
const FLUSH_INTERVAL = 300000; // 5 minutes

async function flushEvents() {
  if (eventBuffer.length === 0) return;
  const now = new Date();
  const key = `events/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')}/${String(now.getUTCHours()).padStart(2, '0')}-${String(now.getUTCMinutes()).padStart(2, '0')}.json`;
  const body = eventBuffer.map(e => JSON.stringify(e)).join('\n');
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key,
      Body: body,
      ContentType: 'application/x-ndjson',
    }));
    console.log(`[ingest] Flushed ${eventBuffer.length} events to ${key}`);
  } catch (e) {
    console.warn('[ingest] Event flush failed:', e.message);
  }
  eventBuffer = [];
  lastFlushTime = Date.now();
}

// ── Core: fetch, compute, tile, persist ───────────────────────────────────

async function processCycle() {
  await loadPrevPositions();
  const routes = loadRoutes();
  const now = Date.now();

  // Fetch GTFS-RT protobuf
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(VEHICLE_POSITIONS_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Feed error: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
  const feedTimestamp = feed.header?.timestamp ? Number(feed.header.timestamp) * 1000 : now;

  // Process vehicles
  const tiles = {}; // tileKey → [vehicle, ...]
  const newPrevPositions = {};
  const rawEvents = [];

  for (const entity of feed.entity) {
    const vp = entity.vehicle;
    if (!vp?.position) continue;
    const { latitude: lat, longitude: lon, bearing: feedBearing, speed: feedSpeed } = vp.position;
    if (!lat || !lon) continue;

    const routeId = vp.trip?.routeId;
    const route = routes[routeId] || { shortName: '', category: 'BUS', color: '#4CAF50' };

    let speed = feedSpeed || 0;
    let bearing = feedBearing || 0;

    // Compute speed/bearing from position delta
    const prev = prevPositions[entity.id];
    if (speed === 0 && prev) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0.5 && dt < 120) {
        const dist = haversineM(prev.lat, prev.lon, lat, lon);
        if (dist > 2) {
          speed = Math.min(dist / dt, 50);
          bearing = computeBearing(prev.lat, prev.lon, lat, lon);
        }
      }
    }

    newPrevPositions[entity.id] = { lat, lon, t: now };
    // Carry forward bearing/speed for vehicles that didn't move
    // so the frontend can still dead-reckon them
    if (speed > 0 && prev) {
      newPrevPositions[entity.id].bearing = bearing;
      newPrevPositions[entity.id].speed = speed;
    } else if (prev?.bearing) {
      // Vehicle stopped but had previous bearing — keep it for display
      bearing = prev.bearing;
    }

    const confidence = computeConfidence(feedTimestamp, now);

    // Skip stale vehicles (> 5 min old, confidence = scheduled)
    // They'd show ghost positions
    if (confidence === 'scheduled') continue;

    const vehicle = {
      id: entity.id, lat, lon, bearing, speed,
      routeId, tripId: vp.trip?.tripId || '',
      line: route.shortName, category: route.category, color: route.color,
      confidence,
    };

    // Bucket into tile
    const tk = tileKey(lat, lon);
    if (!tiles[tk]) tiles[tk] = [];
    tiles[tk].push(vehicle);

    // Buffer raw event for persistence
    rawEvents.push({
      t: now, id: entity.id, lat, lon, bearing, speed,
      line: route.shortName, cat: route.category, conf: confidence,
    });
  }

  // Save prev positions for next cycle/invocation
  await savePrevPositions(newPrevPositions);

  // Write tiles to S3 (parallel, max 20 concurrent)
  const tileKeys = Object.keys(tiles);
  const tilePromises = [];
  for (const tk of tileKeys) {
    const data = JSON.stringify({ vehicles: tiles[tk], fetchedAt: new Date(now).toISOString() });
    tilePromises.push(
      s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: `tiles/${tk}.json`,
        Body: data, ContentType: 'application/json',
      }))
    );
    if (tilePromises.length >= 20) {
      await Promise.all(tilePromises.splice(0));
    }
  }
  await Promise.all(tilePromises);

  // Write tile manifest (which tiles are active, for the frontend to discover)
  const manifest = {};
  for (const tk of tileKeys) {
    manifest[tk] = tiles[tk].length;
  }
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: 'tiles/manifest.json',
    Body: JSON.stringify({ tiles: manifest, fetchedAt: new Date(now).toISOString() }),
    ContentType: 'application/json',
  }));

  // Append to event buffer
  eventBuffer.push(...rawEvents);

  // Flush events to S3 every 5 minutes
  if (now - lastFlushTime >= FLUSH_INTERVAL) {
    await flushEvents();
  }

  return { vehicleCount: feed.entity.length, tileCount: tileKeys.length };
}

// ── Lambda handler: loop at 5s intervals for ~55s ─────────────────────────

exports.handler = async () => {
  const startTime = Date.now();
  const MAX_RUNTIME = 55000; // 55s (leave 5s buffer before 60s timeout)
  let cycles = 0;

  while (Date.now() - startTime < MAX_RUNTIME) {
    try {
      const result = await processCycle();
      cycles++;
      if (cycles === 1) {
        console.log(`[ingest] First cycle: ${result.vehicleCount} vehicles → ${result.tileCount} tiles`);
      }
    } catch (e) {
      console.error('[ingest] Cycle error:', e.message);
    }

    // Wait 10s before next cycle (avoids OVapi rate limiting at 5s)
    const elapsed = Date.now() - startTime;
    if (elapsed + 12000 < MAX_RUNTIME) {
      await new Promise(r => setTimeout(r, 10000));
    } else {
      break;
    }
  }

  // Final event flush
  await flushEvents();

  console.log(`[ingest] Completed ${cycles} cycles in ${Math.round((Date.now() - startTime) / 1000)}s`);
  return { cycles };
};
