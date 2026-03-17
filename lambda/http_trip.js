'use strict';

// GET /trip?vehicleId=2026-03-17:ARR:22099:1118
// Returns the full list of stops for this vehicle's trip.

const { getTripStops } = require('./lib/trips');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  const { vehicleId, line } = event.queryStringParameters || {};
  if (!vehicleId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'vehicleId is required' }) };
  }

  // Vehicle ID format: "2026-03-17:OPERATOR:ROUTE:JOURNEYNUM"
  const parts = vehicleId.split(':');
  if (parts.length < 4) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid vehicleId format' }) };
  }

  const [, operator, route, journeyNum] = parts;

  try {
    const trip = await getTripStops(operator, route, journeyNum, line);
    if (!trip) {
      // Return 200 with error body — CloudFront's custom_error_response intercepts 404s
      // and serves index.html (SPA fallback), so we must avoid non-2xx status codes.
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: 'Trip not found' }) };
    }
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        operator, route, journeyNum,
        headsign: trip.headsign,
        stops: trip.stops,
      }),
    };
  } catch (e) {
    console.error('Trip lookup error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Trip lookup failed' }) };
  }
};
