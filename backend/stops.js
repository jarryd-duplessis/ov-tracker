const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// We cache the stops in memory after first load
let stopsCache = null;
let stopsCacheTime = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// GTFS stops.txt from OVapi - contains all Dutch OV stops with coordinates
const GTFS_STOPS_URL = 'http://gtfs.ovapi.nl/new/stops.txt';
const STOPS_CACHE_FILE = path.join(__dirname, 'stops_cache.json');

// Download and parse GTFS stops.txt
async function downloadStops() {
  console.log('Downloading GTFS stops data...');
  const res = await fetch(GTFS_STOPS_URL);
  if (!res.ok) throw new Error(`Failed to download stops: ${res.status}`);
  const text = await res.text();

  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

  const stops = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
    const stop = {};
    headers.forEach((h, idx) => { stop[h] = values[idx]; });

    // Only include stops with valid coordinates
    const lat = parseFloat(stop.stop_lat);
    const lon = parseFloat(stop.stop_lon);
    if (isNaN(lat) || isNaN(lon)) continue;

    // Filter to only bus/tram stops (location_type 0 = stop/platform)
    if (stop.location_type && stop.location_type !== '0') continue;

    stops.push({
      id: stop.stop_id,
      name: stop.stop_name,
      lat,
      lon,
      // Extract timing point code from stop_id (format: NL:OPERATOR:TPC_CODE:...)
      tpc: stop.stop_id
    });
  }

  console.log(`Loaded ${stops.length} stops`);
  return stops;
}

// Haversine distance in km
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

// Get or refresh stops from cache
async function getStops() {
  const now = Date.now();

  // Return memory cache if fresh
  if (stopsCache && stopsCacheTime && (now - stopsCacheTime) < CACHE_DURATION) {
    return stopsCache;
  }

  // Try disk cache
  if (fs.existsSync(STOPS_CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(STOPS_CACHE_FILE, 'utf8'));
      if (now - cached.timestamp < CACHE_DURATION) {
        stopsCache = cached.stops;
        stopsCacheTime = cached.timestamp;
        console.log('Loaded stops from disk cache');
        return stopsCache;
      }
    } catch (e) {
      console.warn('Disk cache invalid, re-downloading...');
    }
  }

  // Download fresh
  const stops = await downloadStops();
  stopsCache = stops;
  stopsCacheTime = now;

  // Save to disk
  fs.writeFileSync(STOPS_CACHE_FILE, JSON.stringify({
    timestamp: now,
    stops
  }));

  return stops;
}

// Find nearest N stops to a lat/lon within maxDistanceKm
async function findNearbyStops(lat, lon, maxResults = 5, maxDistanceKm = 0.5) {
  const stops = await getStops();

  const withDistance = stops
    .map(stop => ({
      ...stop,
      distance: haversineDistance(lat, lon, stop.lat, stop.lon)
    }))
    .filter(s => s.distance <= maxDistanceKm)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxResults);

  return withDistance;
}

module.exports = { findNearbyStops, getStops };
