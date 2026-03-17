'use strict';

// GET /vehicles
// Returns all live vehicle positions from the GTFS-RT protobuf feed.
// Lambda in-memory cache: 5s TTL (stale-while-revalidate per warm container).

const { getVehiclePositions } = require('./lib/vehicles');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  try {
    const { vehicles, fetchedAt } = await getVehiclePositions();
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ vehicles, fetchedAt: new Date(fetchedAt).toISOString() }),
    };
  } catch (e) {
    console.error('Vehicles error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
