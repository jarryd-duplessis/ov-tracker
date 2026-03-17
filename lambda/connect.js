'use strict';

// WebSocket $connect handler
// Stores the new connectionId in DynamoDB with a 2-hour TTL.
// No group key yet — the client sends a 'subscribe' message after connecting.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.CONNECTIONS_TABLE;
if (!TABLE) console.warn('[connect] CONNECTIONS_TABLE env var is not set');

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const ttl = Math.floor(Date.now() / 1000) + 7200; // 2-hour TTL

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { connectionId, ttl },
    }));
  } catch (e) {
    console.error('[connect] DynamoDB error:', e);
    return { statusCode: 500 };
  }

  console.log(`[connect] ${connectionId}`);
  return { statusCode: 200 };
};
