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

// Load routes.txt into a map: route_id -> { shortName, category, color }
let routesCache = null;
function loadRoutes() {
  if (routesCache) return routesCache;
  const lines = fs.readFileSync(path.join(__dirname, 'routes.txt'), 'utf8').trim().split('\n');
  const headers = lines[0].split(',');
  const idx = (col) => headers.indexOf(col);

  routesCache = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const id = cols[idx('route_id')];
    routesCache[id] = {
      shortName: cols[idx('route_short_name')] || '',
      category: routeTypeToCategory(cols[idx('route_type')]),
      color: '#' + (cols[idx('route_color')] || '4CAF50'),
    };
  }
  return routesCache;
}

// Fetch and parse live vehicle positions
async function getVehiclePositions() {
  const routes = loadRoutes();
  const res = await fetch(VEHICLE_POSITIONS_URL);
  if (!res.ok) throw new Error(`Vehicle feed error: ${res.status}`);
  const buf = await res.buffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);

  const vehicles = [];
  for (const entity of feed.entity) {
    const vp = entity.vehicle;
    if (!vp || !vp.position) continue;
    const { latitude: lat, longitude: lon, bearing, speed } = vp.position;
    if (!lat || !lon) continue;

    const routeId = vp.trip?.routeId;
    const route = routes[routeId] || { shortName: '', category: 'BUS', color: '#4CAF50' };

    vehicles.push({
      id: entity.id,
      lat,
      lon,
      bearing: bearing || 0,
      speed: speed || 0,
      routeId,
      line: route.shortName,
      category: route.category,
      color: route.color,
    });
  }

  return vehicles;
}

module.exports = { getVehiclePositions };
