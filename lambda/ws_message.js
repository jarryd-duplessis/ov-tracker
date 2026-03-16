'use strict';

// WebSocket $default handler — processes all client-sent messages.
//
// Supported message types:
//   { type: 'subscribe', stopCodes: ['HTM:DH_bx_Stop00D026', ...] }
//   { type: 'unsubscribe' }
//
// On subscribe:
//   1. Compute canonical groupKey (sorted stop codes).
//   2. Upsert DynamoDB: connectionId → { groupKey, stopCodes, ttl }.
//   3. Query GSI to count subscribers for this group.
//   4. If this is the first subscriber → send immediate SQS message (DelaySeconds=0)
//      so the poll Lambda runs right away for instant departures.
//   5. The poll Lambda re-schedules itself every 15s and stops when the group empties.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

const TABLE = process.env.CONNECTIONS_TABLE;
const QUEUE_URL = process.env.POLL_QUEUE_URL;

function groupKey(stopCodes) {
  return [...stopCodes].sort().join(',');
}

async function handleSubscribe(connectionId, stopCodes) {
  const key = groupKey(stopCodes.slice(0, 20));
  const ttl = Math.floor(Date.now() / 1000) + 7200;

  // Update this connection's subscription
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { connectionId },
    UpdateExpression: 'SET groupKey = :gk, stopCodes = :sc, #ttl = :ttl',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':gk': key, ':sc': stopCodes.slice(0, 20), ':ttl': ttl },
  }));

  // Count subscribers for this group (GSI query)
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'groupKey-index',
    KeyConditionExpression: 'groupKey = :gk',
    ExpressionAttributeValues: { ':gk': key },
    Select: 'COUNT',
  }));

  // If this is the only subscriber, kick off a fresh poll immediately.
  // If others are already subscribed, their poll loop is already running.
  if (result.Count === 1) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ groupKey: key, stopCodes: stopCodes.slice(0, 20) }),
      DelaySeconds: 0,
    }));
    console.log(`[subscribe] new poll group "${key}" started`);
  } else {
    console.log(`[subscribe] joined group "${key}" (${result.Count} subscribers)`);
  }
}

async function handleUnsubscribe(connectionId) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { connectionId },
    UpdateExpression: 'REMOVE groupKey, stopCodes',
  }));
  console.log(`[unsubscribe] ${connectionId}`);
}

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400 }; }

  try {
    if (body.type === 'subscribe' && Array.isArray(body.stopCodes) && body.stopCodes.length > 0) {
      await handleSubscribe(connectionId, body.stopCodes);
    } else if (body.type === 'unsubscribe') {
      await handleUnsubscribe(connectionId);
    }
  } catch (e) {
    console.error('[ws_message] error:', e);
  }

  return { statusCode: 200 };
};
