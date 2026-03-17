'use strict';

// GET /departures?stops=CODE1,CODE2,...
// Returns departure data with a shared DynamoDB cache (14s TTL) so all Lambda
// containers hit OVapi at most once per cache key per 14 seconds, regardless of
// how many concurrent users are requesting the same stops.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const { getDeparturesMulti, parseTpcResponse } = require('./lib/ovapi');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CACHE_TABLE = process.env.CACHE_TABLE;
if (!CACHE_TABLE) console.warn('[http_departures] CACHE_TABLE env var is not set');
const CACHE_TTL_MS = 14000; // 14 seconds — matches frontend poll interval

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function cacheKey(stopCodes) {
  return [...stopCodes].sort().join(',');
}

exports.handler = async (event) => {
  const { stops } = event.queryStringParameters || {};
  if (!stops) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'stops parameter required' }) };
  }

  const stopCodes = stops.split(',').map(s => s.trim()).filter(Boolean);
  if (stopCodes.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'at least one stop code required' }) };
  }

  const key = cacheKey(stopCodes);

  // Cache read
  if (CACHE_TABLE) {
    try {
      const result = await ddb.send(new GetCommand({ TableName: CACHE_TABLE, Key: { stopKey: key } }));
      const item = result.Item;
      if (item && (Date.now() - item.fetchedAt) < CACHE_TTL_MS) {
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ departures: item.departures, fetchedAt: new Date(item.fetchedAt).toISOString() }),
        };
      }
    } catch (e) {
      console.warn('[departures] cache read error:', e.message);
    }
  }

  // Cache miss — fetch from OVapi
  try {
    const data = await getDeparturesMulti(stopCodes);
    const departures = parseTpcResponse(data);
    const fetchedAt = Date.now();

    // Write to cache (fire-and-forget — don't block the response)
    if (CACHE_TABLE) {
      ddb.send(new PutCommand({
        TableName: CACHE_TABLE,
        Item: {
          stopKey: key,
          departures,
          fetchedAt,
          ttl: Math.floor(fetchedAt / 1000) + 30, // DynamoDB auto-delete after 30s
        },
      })).catch(e => console.warn('[departures] cache write error:', e.message));
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ departures, fetchedAt: new Date(fetchedAt).toISOString() }),
    };
  } catch (e) {
    console.error('Departures error:', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to fetch departures' }) };
  }
};
