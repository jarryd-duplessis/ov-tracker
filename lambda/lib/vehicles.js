'use strict';

const fs = require('fs');
const path = require('path');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const VEHICLE_POSITIONS_URL = 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb';
const CACHE_BUCKET = process.env.CACHE_BUCKET;
const CACHE_KEY = 'vehicles_cache.json';

const s3 = new S3Client({});

function routeTypeToCategory(type) {
  const t = parseInt(type);
  if (t === 0 || t === 900) return 'TRAM';
  if (t === 1) return 'SUBWAY';
  if (t === 2 || (t >= 100 && t <= 199)) return 'RAIL';
  if (t === 4) return 'FERRY';
  return 'BUS';
}

const { parseCsvLine: parseCSVLine } = require('./csv');

let routesCache = null;
function loadRoutes() {
  if (routesCache) return routesCache;
  const lines = fs.readFileSync(path.join(__dirname, '..', 'routes.txt'), 'utf8').trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  const idCol = headers.indexOf('route_id');
  const nameCol = headers.indexOf('route_short_name');
  const typeCol = headers.indexOf('route_type');
  const colorCol = headers.indexOf('route_color');
  if (idCol === -1) throw new Error('routes.txt missing route_id column');
  routesCache = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const id = cols[idCol];
    if (!id) continue;
    routesCache[id] = {
      shortName: nameCol >= 0 ? (cols[nameCol] || '') : '',
      category: typeCol >= 0 ? routeTypeToCategory(cols[typeCol]) : 'BUS',
      color: '#' + (colorCol >= 0 ? (cols[colorCol] || '4CAF50') : '4CAF50'),
    };
  }
  return routesCache;
}

// Previous positions for computing speed/bearing when the feed doesn't provide them
// id → { lat, lon, t }
let prevPositions = {};

// Compute bearing from point A to point B (in degrees, 0 = north, clockwise)
function computeBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// Haversine distance in metres
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Tier 1: per-container in-memory cache (5s) — avoids S3 latency for warm containers
let vehicleCache = { vehicles: [], fetchedAt: 0 };
const MEM_TTL = 5000;

// Tier 2: S3 shared cache (5s) — one OVapi call per 5s across all containers
const S3_TTL = 5000;

// Returns { vehicles, fetchedAt } — fetchedAt is the ms timestamp of the actual fetch,
// so the caller can echo it back to the client for cache-age debugging.
async function getVehiclePositions() {
  const now = Date.now();

  // Tier 1: in-memory
  if (now - vehicleCache.fetchedAt < MEM_TTL) return vehicleCache;

  // Tier 2: S3 shared cache
  if (CACHE_BUCKET) {
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: CACHE_BUCKET, Key: CACHE_KEY }));
      const cached = JSON.parse(await obj.Body.transformToString());
      if (now - cached.fetchedAt < S3_TTL) {
        vehicleCache = { vehicles: cached.vehicles, fetchedAt: cached.fetchedAt };
        return vehicleCache;
      }
    } catch (e) {
      // NoSuchKey on first run, or parse error — fall through to fetch
      if (e.name !== 'NoSuchKey') {
        console.warn('[vehicles] S3 cache read error:', e.message);
      }
    }
  }

  // Tier 3: fetch from OVapi protobuf feed
  const routes = loadRoutes();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(VEHICLE_POSITIONS_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    if (vehicleCache.vehicles.length > 0) return vehicleCache;
    throw new Error(`Vehicle feed error: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);

  const vehicles = [];
  const newPrevPositions = {};
  const now = Date.now();

  for (const entity of feed.entity) {
    const vp = entity.vehicle;
    if (!vp?.position) continue;
    const { latitude: lat, longitude: lon, bearing: feedBearing, speed: feedSpeed } = vp.position;
    if (!lat || !lon) continue;
    const routeId = vp.trip?.routeId;
    const route = routes[routeId] || { shortName: '', category: 'BUS', color: '#4CAF50' };

    let speed = feedSpeed || 0;
    let bearing = feedBearing || 0;

    // Compute speed/bearing from position delta when the feed doesn't provide them
    const prev = prevPositions[entity.id];
    if (speed === 0 && prev) {
      const dt = (now - prev.t) / 1000; // seconds
      if (dt > 0.5 && dt < 120) { // sane time delta
        const dist = haversineM(prev.lat, prev.lon, lat, lon);
        if (dist > 2) { // moved more than 2m — vehicle is moving
          speed = dist / dt;
          if (speed > 50) speed = 50; // cap at 180 km/h sanity check
          bearing = computeBearing(prev.lat, prev.lon, lat, lon);
        }
      }
    }

    newPrevPositions[entity.id] = { lat, lon, t: now };

    vehicles.push({
      id: entity.id, lat, lon, bearing, speed,
      routeId, tripId: vp.trip?.tripId || '',
      line: route.shortName, category: route.category, color: route.color,
    });
  }

  prevPositions = newPrevPositions;
  const fetchedAt = now;
  vehicleCache = { vehicles, fetchedAt };

  // Write to S3 shared cache (fire-and-forget)
  if (CACHE_BUCKET) {
    s3.send(new PutObjectCommand({
      Bucket: CACHE_BUCKET,
      Key: CACHE_KEY,
      Body: JSON.stringify({ vehicles, fetchedAt }),
      ContentType: 'application/json',
    })).catch(e => console.warn('[vehicles] S3 cache write error:', e.message));
  }

  return vehicleCache;
}

module.exports = { getVehiclePositions };
