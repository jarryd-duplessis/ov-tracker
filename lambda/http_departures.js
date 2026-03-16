'use strict';

// GET /departures?stops=CODE1,CODE2,...
// One-shot departure fetch (for clients that don't want WebSocket).

const { getDeparturesMulti, parseTpcResponse } = require('./lib/ovapi');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  const { stops } = event.queryStringParameters || {};
  if (!stops) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'stops parameter required' }) };
  }

  const stopCodes = stops.split(',').map(s => s.trim()).filter(Boolean);
  if (stopCodes.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'at least one stop code required' }) };
  }

  try {
    const data = await getDeparturesMulti(stopCodes);
    const departures = parseTpcResponse(data);
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ departures, fetchedAt: new Date().toISOString() }),
    };
  } catch (e) {
    console.error('Departures error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
