'use strict';

// WebSocket $default handler — connection bookkeeping only.
// Departures are now fetched by the frontend via HTTP polling (/api/departures).
// Subscribe messages are accepted and stored in DynamoDB (for future use) but
// no longer trigger the SQS poll loop.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.CONNECTIONS_TABLE;
if (!TABLE) console.warn('[ws_message] CONNECTIONS_TABLE env var is not set');

function groupKey(stopCodes) {
  return [...stopCodes].sort().join(',');
}

async function handleSubscribe(connectionId, stopCodes) {
  const key = groupKey(stopCodes.slice(0, 20));
  const ttl = Math.floor(Date.now() / 1000) + 7200;

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { connectionId },
    UpdateExpression: 'SET groupKey = :gk, stopCodes = :sc, #ttl = :ttl',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':gk': key, ':sc': stopCodes.slice(0, 20), ':ttl': ttl },
  }));

  console.log(`[subscribe] ${connectionId} → group "${key}"`);
}

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400 }; }

  try {
    if (body.type === 'subscribe' && Array.isArray(body.stopCodes) && body.stopCodes.length > 0) {
      await handleSubscribe(connectionId, body.stopCodes);
    }
  } catch (e) {
    console.error('[ws_message] error:', e);
  }

  return { statusCode: 200 };
};
