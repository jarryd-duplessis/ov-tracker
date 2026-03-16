'use strict';

// GET /stops/nearby?lat=...&lon=...&radius=...
// Returns up to 30 nearby stops within the given radius (default 1.5km).

const { findNearbyStops } = require('./lib/stops');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  const { lat, lon, radius = '1.5' } = event.queryStringParameters || {};
  if (!lat || !lon) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lat and lon are required' }) };
  }

  try {
    const stops = await findNearbyStops(parseFloat(lat), parseFloat(lon), 30, parseFloat(radius) || 1.5);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ stops }) };
  } catch (e) {
    console.error('Stops error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
