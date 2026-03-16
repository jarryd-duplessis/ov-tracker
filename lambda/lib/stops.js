'use strict';

// S3-backed stops cache for Lambda.
// In-memory cache works across warm invocations (up to 15-min Lambda lifetime).
// Cold start: fetch from S3. Daily refresh handled by a separate EventBridge Lambda.

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});
const BUCKET = process.env.STOPS_BUCKET;
const KEY = 'stops_cache.json';
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

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

// Parse RFC 4180 CSV
function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) { fields.push(field); field = ''; }
    else { field += ch; }
  }
  fields.push(field);
  return fields;
}

// Download and parse GTFS stops — runs in refresh Lambda, not in request path
async function downloadStops() {
  // Lambda has no wget/unzip; use fetch + JSZip
  const JSZip = require('jszip');
  const urls = getGtfsUrls();
  let zipBuffer = null;

  for (const url of urls) {
    console.log(`Trying ${url}`);
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      zipBuffer = Buffer.from(await res.arrayBuffer());
      break;
    } catch { continue; }
  }
  if (!zipBuffer) throw new Error('Could not download KV7 GTFS zip for any of the last 4 days');

  const zip = await JSZip.loadAsync(zipBuffer);
  const stopsTxt = await zip.file('stops.txt').async('string');
  const lines = stopsTxt.trim().split('\n');
  const headers = parseCsvLine(lines[0]).map(h => h.trim());

  const stops = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCsvLine(lines[i]);
    const stop = {};
    headers.forEach((h, idx) => { stop[h] = (values[idx] || '').trim(); });
    const lat = parseFloat(stop.stop_lat);
    const lon = parseFloat(stop.stop_lon);
    if (isNaN(lat) || isNaN(lon)) continue;
    if (stop.location_type && stop.location_type !== '0') continue;
    if (lat < 50.5 || lat > 53.7 || lon < 3.3 || lon > 7.3) continue;
    stops.push({ id: stop.stop_id, name: stop.stop_name, lat, lon, tpc: stop.stop_id });
  }

  console.log(`Loaded ${stops.length} stops`);
  return stops;
}

async function getStops() {
  const now = Date.now();
  if (stopsCache && (now - stopsCacheTime) < CACHE_DURATION) return stopsCache;

  // Load from S3
  try {
    const cached = await loadFromS3();
    stopsCache = cached.stops.filter(
      s => s.lat >= 50.5 && s.lat <= 53.7 && s.lon >= 3.3 && s.lon <= 7.3
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

  // Collapse stops within 20m (same physical pole, different GTFS entries)
  const kept = [];
  for (const stop of withDistance) {
    const tooClose = kept.some(k => haversineDistance(stop.lat, stop.lon, k.lat, k.lon) < 0.02);
    if (!tooClose) kept.push(stop);
  }

  return kept.slice(0, maxResults);
}

module.exports = { findNearbyStops, getStops, downloadStops, saveToS3 };
