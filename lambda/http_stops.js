'use strict';

// GET /stops/nearby?lat=...&lon=...&radius=...
// Returns all nearby stops within the given radius (default 1.5km), deduplicated at 10m.

const { findNearbyStops, searchStopsByName } = require('./lib/stops');

if (!process.env.STOPS_BUCKET) console.warn('[http_stops] STOPS_BUCKET env var is not set');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  const { lat, lon, radius = '1.5', q } = event.queryStringParameters || {};

  // Stop name search: GET /stops/nearby?q=Janskerkhof
  if (q) {
    try {
      const stops = await searchStopsByName(q);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ stops }) };
    } catch (e) {
      console.error('Stop search error:', e);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (!lat || !lon) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lat and lon are required' }) };
  }

  const parsedLat = parseFloat(lat);
  const parsedLon = parseFloat(lon);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon) ||
      parsedLat < -90 || parsedLat > 90 || parsedLon < -180 || parsedLon > 180) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid lat/lon values' }) };
  }

  try {
    const stops = await findNearbyStops(parsedLat, parsedLon, 9999, parseFloat(radius) || 1.5);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ stops }) };
  } catch (e) {
    console.error('Stops error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
