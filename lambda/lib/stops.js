'use strict';

// S3-backed stops cache for Lambda.
// In-memory cache works across warm invocations (up to 15-min Lambda lifetime).
// Cold start: fetch from S3. Daily refresh handled by a separate EventBridge Lambda.

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});
const BUCKET = process.env.STOPS_BUCKET;
const KEY = 'stops_cache.json';
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

const NL_BOUNDS = { minLat: 50.5, maxLat: 53.7, minLon: 3.3, maxLon: 7.3 };

// Module-level in-memory cache (warm container reuse)
let stopsCache = null;
let stopsCacheTime = 0;

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function loadFromS3() {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
  const body = await res.Body.transformToString();
  return JSON.parse(body);
}

async function saveToS3(data) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: KEY,
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));
}

// KV7 GTFS feed — try today's file and last 3 days
function getGtfsUrls() {
  const urls = [];
  for (let d = 0; d <= 3; d++) {
    const dt = new Date(Date.now() - d * 86400000);
    const ymd = dt.toISOString().slice(0, 10).replace(/-/g, '');
    urls.push(`https://gtfs.ovapi.nl/govi/gtfs-kv7-${ymd}.zip`);
  }
  return urls;
}

const { parseCsvLine } = require('./csv');

// Build a spatial grid keyed by floor(lat*1000),floor(lon*1000) (~100m cells at NL latitudes)
function buildSpatialGrid(stops) {
  const grid = new Map();
  for (const stop of stops) {
    const key = `${Math.floor(stop.lat * 1000)},${Math.floor(stop.lon * 1000)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(stop);
  }
  return grid;
}

// Returns true if any stop in the grid is within distKm of (lat, lon)
function isNearAny(lat, lon, grid, distKm) {
  const latCell = Math.floor(lat * 1000);
  const lonCell = Math.floor(lon * 1000);
  for (let dlat = -1; dlat <= 1; dlat++) {
    for (let dlon = -1; dlon <= 1; dlon++) {
      const nearby = grid.get(`${latCell + dlat},${lonCell + dlon}`);
      if (!nearby) continue;
      for (const s of nearby) {
        if (haversineDistance(lat, lon, s.lat, s.lon) < distKm) return true;
      }
    }
  }
  return false;
}

// Parse a GTFS stops.txt buffer and return NL stops with location_type=0
function parseStopsTxt(text) {
  const lines = text.trim().split('\n');
  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const stops = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });
    const lat = parseFloat(row.stop_lat);
    const lon = parseFloat(row.stop_lon);
    if (isNaN(lat) || isNaN(lon)) continue;
    if (row.location_type && row.location_type !== '0') continue;
    if (lat < NL_BOUNDS.minLat || lat > NL_BOUNDS.maxLat || lon < NL_BOUNDS.minLon || lon > NL_BOUNDS.maxLon) continue;
    stops.push({ id: row.stop_id, name: row.stop_name, lat, lon, tpc: row.stop_id });
  }
  return stops;
}

// Download and parse GTFS stops — runs in refresh Lambda, not in request path.
// Merges KV7 (OVapi TPC-compatible) + openov-nl (full NL network) stops.
async function downloadStops() {
  // Lambda has no wget/unzip; use fetch + JSZip
  const JSZip = require('jszip');

  // ── 1. KV7 stops (have working OVapi TPC codes) ───────────────────────────
  const urls = getGtfsUrls();
  let kv7Buffer = null;
  for (const url of urls) {
    console.log(`Trying ${url}`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) continue;
        kv7Buffer = Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(timeout);
      }
      break;
    } catch { continue; }
  }
  if (!kv7Buffer) throw new Error('Could not download KV7 GTFS zip for any of the last 4 days');

  const kv7Zip = await JSZip.loadAsync(kv7Buffer);
  const kv7Stops = parseStopsTxt(await kv7Zip.file('stops.txt').async('string'));
  console.log(`KV7 stops: ${kv7Stops.length}`);

  // ── 2. openov-nl stops (full national GTFS — contains stops missing from KV7) ──
  const kv7Grid = buildSpatialGrid(kv7Stops);
  let openOvStops = [];
  try {
    console.log('Fetching openov-nl GTFS...');
    const openOvController = new AbortController();
    const openOvTimeout = setTimeout(() => openOvController.abort(), 10000);
    let res;
    try {
      res = await fetch('https://gtfs.ovapi.nl/openov-nl/gtfs-openov-nl.zip', { signal: openOvController.signal });
    } finally {
      clearTimeout(openOvTimeout);
    }
    if (res.ok) {
      const openOvZip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
      const allOpenOv = parseStopsTxt(await openOvZip.file('stops.txt').async('string'));
      // Only add stops that aren't already represented in KV7 (within 15m)
      for (const s of allOpenOv) {
        if (!isNearAny(s.lat, s.lon, kv7Grid, 0.015)) openOvStops.push(s);
      }
      console.log(`openov-nl added ${openOvStops.length} new stops (${allOpenOv.length} total, ${allOpenOv.length - openOvStops.length} already in KV7)`);
    } else {
      console.warn(`openov-nl fetch failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn('openov-nl download failed (non-fatal):', e.message);
  }

  const stops = [...kv7Stops, ...openOvStops];
  console.log(`Total stops: ${stops.length}`);
  return stops;
}

async function getStops() {
  const now = Date.now();
  if (stopsCache && (now - stopsCacheTime) < CACHE_DURATION) return stopsCache;

  // Load from S3
  try {
    const cached = await loadFromS3();
    stopsCache = cached.stops.filter(
      s => s.lat >= NL_BOUNDS.minLat && s.lat <= NL_BOUNDS.maxLat && s.lon >= NL_BOUNDS.minLon && s.lon <= NL_BOUNDS.maxLon
    );
    stopsCacheTime = cached.timestamp;
    return stopsCache;
  } catch (e) {
    if (stopsCache) {
      console.warn('S3 load failed, using in-memory cache:', e.message);
      return stopsCache;
    }
    throw new Error('Stops cache not available. Has the refresh Lambda run yet?');
  }
}

async function findNearbyStops(lat, lon, maxResults = 30, maxDistanceKm = 1.0) {
  const stops = await getStops();
  const withDistance = stops
    .map(stop => ({ ...stop, distance: haversineDistance(lat, lon, stop.lat, stop.lon) }))
    .filter(s => s.distance <= maxDistanceKm)
    .sort((a, b) => a.distance - b.distance);

  // Collapse stops within 10m (exact same physical pole, different GTFS entries).
  // 10m keeps stops on opposite sides of a road (typically 15–30m apart) distinct.
  const kept = [];
  for (const stop of withDistance) {
    const tooClose = kept.some(k => haversineDistance(stop.lat, stop.lon, k.lat, k.lon) < 0.01);
    if (!tooClose) kept.push(stop);
  }

  return kept.slice(0, maxResults);
}

module.exports = { findNearbyStops, getStops, downloadStops, saveToS3 };
