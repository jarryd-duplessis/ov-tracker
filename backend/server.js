const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { getDeparturesMulti, parseTpcResponse } = require('./ovapi');
const { findNearbyStops, getStops } = require('./stops');
const { getVehiclePositions } = require('./vehicles');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ─── REST ENDPOINTS ──────────────────────────────────────────────────────────
// Mounted under /api so CloudFront can route /api/* → ALB without path rewriting.
// The WebSocket path /ws is handled separately by the WS server below.

const api = express.Router();
app.use('/api', api);

// Bare /health for ALB health checks (ALB hits the container directly, no /api prefix)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    pollGroups: pollGroups.size,
    connectedClients: wss.clients.size,
  });
});

api.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    pollGroups: pollGroups.size,
    connectedClients: wss.clients.size,
  });
});

api.get('/stops/nearby', async (req, res) => {
  const { lat, lon, radius = 0.5 } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon are required' });

  try {
    const stops = await findNearbyStops(parseFloat(lat), parseFloat(lon), 10, parseFloat(radius));
    res.json({ stops });
  } catch (e) {
    console.error('Error finding nearby stops:', e);
    res.status(500).json({ error: e.message });
  }
});

api.get('/departures', async (req, res) => {
  const { stops } = req.query;
  if (!stops) return res.status(400).json({ error: 'stops parameter required' });

  const stopCodes = stops.split(',').map(s => s.trim()).filter(Boolean);
  if (stopCodes.length === 0) return res.status(400).json({ error: 'at least one stop code required' });

  try {
    const data = await getDeparturesMulti(stopCodes);
    const departures = parseTpcResponse(data);
    res.json({ departures, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error('Error fetching departures:', e);
    res.status(500).json({ error: e.message });
  }
});

api.get('/vehicles', async (req, res) => {
  try {
    const vehicles = await getVehiclePositions();
    res.json({ vehicles, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error('Vehicle positions error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── JOURNEY PLANNER ──────────────────────────────────────────────────────────

async function geocodeLocation(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&countrycodes=nl&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'KomtIe/1.0 (live-ov-tracker)' } });
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const data = await res.json();
  if (!data.length) throw new Error(`Location not found: "${query}"`);
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    name: data[0].display_name.split(',').slice(0, 2).join(',').trim()
  };
}

api.get('/journey', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  try {
    const [fromGeo, toGeo] = await Promise.all([geocodeLocation(from), geocodeLocation(to)]);
    const motisUrl = `https://europe.motis-project.de/api/v1/plan?fromPlace=${fromGeo.lat},${fromGeo.lon}&toPlace=${toGeo.lat},${toGeo.lon}&numItineraries=3`;
    const motisRes = await fetch(motisUrl, { headers: { 'User-Agent': 'KomtIe/1.0' } });
    if (!motisRes.ok) throw new Error(`Journey planner unavailable: ${motisRes.status}`);
    const motisData = await motisRes.json();
    res.json({ from: fromGeo, to: toGeo, itineraries: motisData.itineraries || [] });
  } catch (e) {
    console.error('Journey planning error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── SHARED POLL REGISTRY ─────────────────────────────────────────────────────
//
// Clients watching the same stops share a single OVapi poll.
// 1000 users at Amsterdam Centraal = 1 OVapi call/15s, not 1000.
//
// pollGroups:  Map<key, { stopCodes, interval, subscribers: Set<ws> }>
// clientToKey: Map<ws, key>  — used to find a client's group on disconnect/re-sub

const pollGroups = new Map();
const clientToKey = new Map();

// Canonical key: sorted stop codes so order doesn't create duplicate groups
function groupKey(stopCodes) {
  return [...stopCodes].sort().join(',');
}

function subscribe(ws, stopCodes) {
  const key = groupKey(stopCodes);

  if (pollGroups.has(key)) {
    pollGroups.get(key).subscribers.add(ws);
    console.log(`[ws] joined existing group "${key}" (${pollGroups.get(key).subscribers.size} subscribers)`);
  } else {
    const subscribers = new Set([ws]);

    // Fetch immediately, then every 15s
    fetchAndBroadcast(key, stopCodes, subscribers);
    const interval = setInterval(() => fetchAndBroadcast(key, stopCodes, subscribers), 15000);

    pollGroups.set(key, { stopCodes, interval, subscribers });
    console.log(`[ws] created poll group "${key}"`);
  }

  clientToKey.set(ws, key);
}

function unsubscribe(ws) {
  const key = clientToKey.get(ws);
  if (!key) return;

  const group = pollGroups.get(key);
  if (group) {
    group.subscribers.delete(ws);
    if (group.subscribers.size === 0) {
      clearInterval(group.interval);
      pollGroups.delete(key);
      console.log(`[ws] poll group "${key}" removed (no subscribers)`);
    }
  }

  clientToKey.delete(ws);
}

async function fetchAndBroadcast(key, stopCodes, subscribers) {
  if (subscribers.size === 0) return;

  try {
    const data = await getDeparturesMulti(stopCodes);
    const departures = parseTpcResponse(data);
    const message = JSON.stringify({ type: 'departures', departures, fetchedAt: new Date().toISOString() });

    for (const ws of subscribers) {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    }
  } catch (e) {
    console.error(`[ws] fetch error for group "${key}":`, e.message);
    const message = JSON.stringify({ type: 'error', message: e.message });
    for (const ws of subscribers) {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    }
  }
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('[ws] client connected');

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'subscribe' && Array.isArray(msg.stopCodes)) {
        unsubscribe(ws); // leave previous group if re-subscribing
        subscribe(ws, msg.stopCodes.slice(0, 10));
      }

      if (msg.type === 'unsubscribe') {
        unsubscribe(ws);
      }
    } catch (e) {
      console.error('[ws] message error:', e);
    }
  });

  ws.on('close', () => {
    unsubscribe(ws);
    console.log('[ws] client disconnected');
  });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`\n🚌 Komt ie? backend running on port ${PORT}`);
  console.log(`   REST: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);

  try {
    console.log('Pre-loading stops cache...');
    await getStops();
    console.log('Stops cache ready ✓');
  } catch (e) {
    console.warn('Could not pre-load stops cache:', e.message);
  }
});
