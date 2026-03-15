const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let stopsCache = null;
let stopsCacheTime = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// KV7 GTFS feed has the correct OVapi timing point codes for bus/tram/metro.
// The generic /nl/gtfs-nl.zip uses different IDs that OVapi doesn't recognise.
// The KV7 zip is ~37MB vs 216MB and updated daily (filename includes date).
function getGtfsUrl() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `https://gtfs.ovapi.nl/govi/gtfs-kv7-${yyyy}${mm}${dd}.zip`;
}

const GTFS_TMP_ZIP = '/tmp/gtfs-kv7.zip';
const STOPS_CACHE_FILE = path.join(__dirname, 'stops_cache.json');

// Parse a single CSV line respecting RFC 4180 quoting (handles commas in names).
function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

async function downloadStops() {
  const url = getGtfsUrl();
  console.log(`Downloading KV7 GTFS zip (~37 MB) from ${url}...`);
  execSync(`wget -q -O ${GTFS_TMP_ZIP} ${url}`, { stdio: 'inherit' });

  console.log('Extracting stops.txt from zip...');
  // -p pipes the extracted file to stdout; 5 MB covers the KV7 stops.txt (~1.1 MB)
  const text = execSync(`unzip -p ${GTFS_TMP_ZIP} stops.txt`, { maxBuffer: 5 * 1024 * 1024 }).toString();
  fs.unlinkSync(GTFS_TMP_ZIP);

  const lines = text.trim().split('\n');
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

    stops.push({ id: stop.stop_id, name: stop.stop_name, lat, lon, tpc: stop.stop_id });
  }

  console.log(`Loaded ${stops.length} stops`);
  return stops;
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getStops() {
  const now = Date.now();

  if (stopsCache && stopsCacheTime && (now - stopsCacheTime) < CACHE_DURATION) {
    return stopsCache;
  }

  // Try disk cache (includes the pre-seeded cache baked into the Docker image)
  if (fs.existsSync(STOPS_CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(STOPS_CACHE_FILE, 'utf8'));
      if (now - cached.timestamp < CACHE_DURATION) {
        stopsCache = cached.stops;
        stopsCacheTime = cached.timestamp;
        console.log(`Loaded ${stopsCache.length} stops from disk cache`);
        return stopsCache;
      }
    } catch (e) {
      console.warn('Disk cache invalid, re-downloading...');
    }
  }

  try {
    const stops = await downloadStops();
    stopsCache = stops;
    stopsCacheTime = now;
    fs.writeFileSync(STOPS_CACHE_FILE, JSON.stringify({ timestamp: now, stops }));
    return stops;
  } catch (e) {
    // If refresh fails but we have stale data, keep serving it rather than going dark
    if (stopsCache) {
      console.warn('Failed to refresh stops cache, using stale data:', e.message);
      return stopsCache;
    }
    throw e;
  }
}

async function findNearbyStops(lat, lon, maxResults = 5, maxDistanceKm = 0.5) {
  const stops = await getStops();
  return stops
    .map(stop => ({ ...stop, distance: haversineDistance(lat, lon, stop.lat, stop.lon) }))
    .filter(s => s.distance <= maxDistanceKm)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxResults);
}

module.exports = { findNearbyStops, getStops };
