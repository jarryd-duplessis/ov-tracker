'use strict';

// SQS-triggered poll Lambda — the heartbeat of the shared departure push system.
//
// Flow per invocation:
//   1. Receive one SQS message: { groupKey, stopCodes }
//   2. Query DynamoDB GSI for all connectionIds in this group.
//   3. If no subscribers → stop. The poll group dies naturally.
//   4. Fetch OVapi departures for stopCodes.
//   5. Push result to each subscriber via API Gateway Management API.
//      Stale connections (410 Gone) are deleted from DynamoDB.
//   6. Re-schedule self: send new SQS message with DelaySeconds=15.
//
// SQS trigger is configured with batch size 1 so each invocation handles one group.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const { getDeparturesMulti, parseTpcResponse } = require('./lib/ovapi');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});

const TABLE = process.env.CONNECTIONS_TABLE;
const QUEUE_URL = process.env.POLL_QUEUE_URL;
const WS_ENDPOINT = process.env.WS_MANAGEMENT_ENDPOINT; // e.g. https://id.execute-api.region.amazonaws.com/prod

exports.handler = async (event) => {
  for (const record of event.Records) {
    let groupKey, stopCodes;
    try {
      ({ groupKey, stopCodes } = JSON.parse(record.body));
    } catch (e) {
      console.error('Malformed SQS message:', record.body);
      continue;
    }

    await processGroup(groupKey, stopCodes);
  }
};

async function processGroup(groupKey, stopCodes) {
  // Find all active subscribers for this group
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'groupKey-index',
    KeyConditionExpression: 'groupKey = :gk',
    ExpressionAttributeValues: { ':gk': groupKey },
    ProjectionExpression: 'connectionId',
  }));

  const connections = result.Items || [];
  if (connections.length === 0) {
    console.log(`[poll] group "${groupKey}" has no subscribers — stopping`);
    return; // poll group dies; client re-subscribe will restart it
  }

  // Fetch departures
  let message;
  try {
    const data = await getDeparturesMulti(stopCodes);
    const departures = parseTpcResponse(data);
    message = JSON.stringify({ type: 'departures', departures, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.error(`[poll] OVapi error for "${groupKey}":`, e.message);
    message = JSON.stringify({ type: 'error', message: e.message });
  }

  // Push to all subscribers
  const apigw = new ApiGatewayManagementApiClient({ endpoint: WS_ENDPOINT });
  const msgBytes = Buffer.from(message);

  await Promise.allSettled(connections.map(async ({ connectionId }) => {
    try {
      await apigw.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: msgBytes,
      }));
    } catch (e) {
      if (e.$metadata?.httpStatusCode === 410) {
        // Connection is gone — clean up DynamoDB
        console.log(`[poll] stale connection ${connectionId} — removing`);
        await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { connectionId } })).catch(() => {});
      } else {
        console.warn(`[poll] push failed for ${connectionId}:`, e.message);
      }
    }
  }));

  // Self-rescheduling removed — frontend now polls /api/departures directly via HTTP.
  // Lambda→SQS→Lambda was flagged as a recursive loop by AWS.
}
