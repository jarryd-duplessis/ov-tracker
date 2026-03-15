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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Find nearby stops for a given lat/lon
// GET /stops/nearby?lat=52.09&lon=5.11&radius=0.5
app.get('/stops/nearby', async (req, res) => {
  const { lat, lon, radius = 0.5 } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }

  try {
    const stops = await findNearbyStops(
      parseFloat(lat),
      parseFloat(lon),
      10,
      parseFloat(radius)
    );
    res.json({ stops });
  } catch (e) {
    console.error('Error finding nearby stops:', e);
    res.status(500).json({ error: e.message });
  }
});

// Get live departures for a list of stop IDs
// GET /departures?stops=TPC1,TPC2,TPC3
app.get('/departures', async (req, res) => {
  const { stops } = req.query;

  if (!stops) {
    return res.status(400).json({ error: 'stops parameter required' });
  }

  const stopCodes = stops.split(',').map(s => s.trim()).filter(Boolean);
  if (stopCodes.length === 0) {
    return res.status(400).json({ error: 'at least one stop code required' });
  }

  try {
    const data = await getDeparturesMulti(stopCodes);
    const departures = parseTpcResponse(data);
    res.json({ departures, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error('Error fetching departures:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────

// Track active subscriptions per client
// Each client can subscribe to a set of stop codes
const clientSubscriptions = new Map(); // ws -> { stopCodes: [], interval: NodeJS.Timer }

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      // Client sends: { type: 'subscribe', stopCodes: ['TPC1', 'TPC2'] }
      if (msg.type === 'subscribe' && Array.isArray(msg.stopCodes)) {
        // Clear any existing subscription for this client
        const existing = clientSubscriptions.get(ws);
        if (existing?.interval) clearInterval(existing.interval);

        const stopCodes = msg.stopCodes.slice(0, 10); // max 10 stops
        console.log(`Client subscribed to stops: ${stopCodes.join(', ')}`);

        // Send immediately
        await pushDepartures(ws, stopCodes);

        // Then push every 15 seconds
        const interval = setInterval(async () => {
          if (ws.readyState === WebSocket.OPEN) {
            await pushDepartures(ws, stopCodes);
          }
        }, 15000);

        clientSubscriptions.set(ws, { stopCodes, interval });
      }

      // Client sends: { type: 'unsubscribe' }
      if (msg.type === 'unsubscribe') {
        const existing = clientSubscriptions.get(ws);
        if (existing?.interval) clearInterval(existing.interval);
        clientSubscriptions.delete(ws);
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });

  ws.on('close', () => {
    const existing = clientSubscriptions.get(ws);
    if (existing?.interval) clearInterval(existing.interval);
    clientSubscriptions.delete(ws);
    console.log('Client disconnected');
  });
});

async function pushDepartures(ws, stopCodes) {
  try {
    const data = await getDeparturesMulti(stopCodes);
    const departures = parseTpcResponse(data);

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'departures',
        departures,
        fetchedAt: new Date().toISOString()
      }));
    }
  } catch (e) {
    console.error('Error pushing departures:', e);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  }
}

// ─── VEHICLE POSITIONS ────────────────────────────────────────────────────────

app.get('/vehicles', async (req, res) => {
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

app.get('/journey', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  try {
    const [fromGeo, toGeo] = await Promise.all([
      geocodeLocation(from),
      geocodeLocation(to)
    ]);

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

// ─── STARTUP ──────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`\n🚌 Komt ie? backend running on port ${PORT}`);
  console.log(`   REST: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);

  // Pre-warm stops cache on startup
  try {
    console.log('Pre-loading stops cache...');
    await getStops();
    console.log('Stops cache ready ✓');
  } catch (e) {
    console.warn('Could not pre-load stops cache:', e.message);
  }
});
