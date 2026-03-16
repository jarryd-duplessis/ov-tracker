const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let stopsCache = null;
let stopsCacheTime = null;
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// KV7 GTFS feed has the correct OVapi timing point codes for bus/tram/metro.
// The generic /nl/gtfs-nl.zip uses different IDs that OVapi doesn't recognise.
// The KV7 zip is ~37MB vs 216MB and updated daily (filename includes date).
// Try today and the last 3 days in case today's file isn't published yet.
function getGtfsUrl() {
  const urls = [];
  for (let daysAgo = 0; daysAgo <= 3; daysAgo++) {
    const d = new Date(Date.now() - daysAgo * 86400000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    urls.push(`https://gtfs.ovapi.nl/govi/gtfs-kv7-${yyyy}${mm}${dd}.zip`);
  }
  return urls;
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
  const urls = getGtfsUrl();
  let downloaded = false;
  for (const url of urls) {
    console.log(`Trying KV7 GTFS zip from ${url}...`);
    try {
      execSync(`wget -q -O ${GTFS_TMP_ZIP} ${url}`, { stdio: 'inherit' });
      downloaded = true;
      break;
    } catch (e) {
      console.warn(`  → not found, trying previous day`);
    }
  }
  if (!downloaded) throw new Error('Could not download KV7 GTFS zip for any of the last 4 days');

  console.log('Extracting stops.txt from zip...');
  const text = execSync(`unzip -p ${GTFS_TMP_ZIP} stops.txt`, { maxBuffer: 20 * 1024 * 1024 }).toString();
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
    // Skip stops with placeholder/bogus coordinates outside the Netherlands
    if (lat < 50.5 || lat > 53.7 || lon < 3.3 || lon > 7.3) continue;

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

  // Try disk cache (includes the pre-seeded cache baked into the Docker image).
  // Always load it into stopsCache so it's available as a fallback even when stale.
  let diskCacheFresh = false;
  if (fs.existsSync(STOPS_CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(STOPS_CACHE_FILE, 'utf8'));
      // Filter out stops with bogus/placeholder coordinates outside the Netherlands
      stopsCache = cached.stops.filter(s => s.lat >= 50.5 && s.lat <= 53.7 && s.lon >= 3.3 && s.lon <= 7.3);
      stopsCacheTime = cached.timestamp;
      if (now - cached.timestamp < CACHE_DURATION) {
        diskCacheFresh = true;
        console.log(`Loaded ${stopsCache.length} stops from disk cache`);
        return stopsCache;
      }
      console.log(`Disk cache stale (${stopsCache.length} stops) — refreshing...`);
    } catch (e) {
      console.warn('Disk cache invalid, re-downloading...');
    }
  }

  try {
    const stops = await downloadStops();
    // Safety guard: never replace a larger cache with a significantly smaller one.
    // A small download likely means a partial/regional KV7 file, not a regression in data.
    if (stopsCache && stops.length < stopsCache.length * 0.8) {
      console.warn(`Downloaded ${stops.length} stops but cache has ${stopsCache.length} — keeping existing cache (new data looks partial)`);
      stopsCacheTime = now;
      return stopsCache;
    }
    stopsCache = stops;
    stopsCacheTime = now;
    fs.writeFileSync(STOPS_CACHE_FILE, JSON.stringify({ timestamp: now, stops }));
    return stops;
  } catch (e) {
    // Download failed — serve whatever we have rather than going dark
    if (stopsCache) {
      console.warn(`Failed to refresh stops cache, using existing ${stopsCache.length} stops:`, e.message);
      stopsCacheTime = now; // back off — don't retry on every request
      return stopsCache;
    }
    throw e;
  }
}

async function findNearbyStops(lat, lon, maxResults = 30, maxDistanceKm = 1.0) {
  const stops = await getStops();
  const withDistance = stops
    .map(stop => ({ ...stop, distance: haversineDistance(lat, lon, stop.lat, stop.lon) }))
    .filter(s => s.distance <= maxDistanceKm)
    .sort((a, b) => a.distance - b.distance);

  // Deduplicate: collapse stops that are within 20m of each other (same physical pole,
  // different GTFS entries). Compare each candidate against ALL already-kept stops,
  // not just the first one with the same name, to handle clusters of quays.
  const kept = [];
  for (const stop of withDistance) {
    const tooClose = kept.some(k => haversineDistance(stop.lat, stop.lon, k.lat, k.lon) < 0.02);
    if (!tooClose) kept.push(stop);
  }

  return kept.slice(0, maxResults);
}

module.exports = { findNearbyStops, getStops };
