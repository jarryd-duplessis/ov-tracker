const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const VEHICLE_POSITIONS_URL = 'https://gtfs.ovapi.nl/nl/vehiclePositions.pb';

// GTFS route_type → transport category
function routeTypeToCategory(type) {
  const t = parseInt(type);
  if (t === 0 || t === 900) return 'TRAM';
  if (t === 1) return 'SUBWAY';
  if (t === 2 || (t >= 100 && t <= 199)) return 'RAIL';
  if (t === 4) return 'FERRY';
  return 'BUS'; // 3, 700-799, etc.
}

// RFC 4180-compliant CSV row parser (handles quoted fields and escaped quotes "")
function parseCSVLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes && ch === '"' && line[i + 1] === '"') {
      field += '"';
      i++; // skip second quote of escaped pair
    } else if (ch === '"') {
      inQuotes = !inQuotes;
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

// Load routes.txt into a map: route_id -> { shortName, category, color }
let routesCache = null;
function loadRoutes() {
  if (routesCache) return routesCache;
  const lines = fs.readFileSync(path.join(__dirname, 'routes.txt'), 'utf8').trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  const idx = (col) => headers.indexOf(col);

  const idCol = idx('route_id');
  const nameCol = idx('route_short_name');
  const typeCol = idx('route_type');
  const colorCol = idx('route_color');

  if (idCol === -1) throw new Error('routes.txt missing required column: route_id');

  routesCache = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const id = idCol >= 0 ? cols[idCol] : undefined;
    if (!id) continue;
    routesCache[id] = {
      shortName: nameCol >= 0 ? (cols[nameCol] || '') : '',
      category: typeCol >= 0 ? routeTypeToCategory(cols[typeCol]) : 'BUS',
      color: '#' + (colorCol >= 0 ? (cols[colorCol] || '4CAF50') : '4CAF50'),
    };
  }
  return routesCache;
}

// Server-side vehicle cache — shared across all client requests
let vehicleCache = { vehicles: [], fetchedAt: 0 };
const VEHICLE_CACHE_TTL = 5000; // re-fetch at most every 5s

// Fetch and parse live vehicle positions (with stale-while-revalidate caching)
async function getVehiclePositions() {
  const now = Date.now();
  if (now - vehicleCache.fetchedAt < VEHICLE_CACHE_TTL) {
    return vehicleCache.vehicles; // serve cached data if fresh enough
  }

  const routes = loadRoutes();
  const res = await fetch(VEHICLE_POSITIONS_URL);
  if (!res.ok) {
    if (vehicleCache.vehicles.length > 0) {
      console.warn(`Vehicle feed ${res.status} — serving cached data (age ${Math.round((now - vehicleCache.fetchedAt) / 1000)}s)`);
      return vehicleCache.vehicles;
    }
    throw new Error(`Vehicle feed error: ${res.status}`);
  }
  const buf = await res.buffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);

  const vehicles = [];
  for (const entity of feed.entity) {
    const vp = entity.vehicle;
    if (!vp || !vp.position) continue;
    const { latitude: lat, longitude: lon, bearing, speed } = vp.position;
    if (!lat || !lon) continue;

    const routeId = vp.trip?.routeId;
    const tripId = vp.trip?.tripId || '';
    const route = routes[routeId] || { shortName: '', category: 'BUS', color: '#4CAF50' };

    vehicles.push({
      id: entity.id,
      lat,
      lon,
      bearing: bearing || 0,
      speed: speed || 0,
      routeId,
      tripId,
      line: route.shortName,
      category: route.category,
      color: route.color,
    });
  }

  vehicleCache = { vehicles, fetchedAt: Date.now() };
  return vehicles;
}

module.exports = { getVehiclePositions };
