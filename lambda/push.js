'use strict';

// DynamoDB Streams trigger — pushes departure updates to WebSocket subscribers.
//
// Flow:
//   1. Receives INSERT/MODIFY events from the departures-cache DynamoDB table.
//   2. Extracts stopKey and departures from the new image.
//   3. Queries the connections table (groupKey-index GSI) for all connections
//      subscribed to that exact stopKey (groupKey = stopKey).
//   4. Pushes departure data to each connection via API Gateway Management API.
//   5. Cleans up stale connections (410 Gone) by deleting from DynamoDB.
//
// This replaces the SQS self-scheduling loop in poll.js.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;
const WS_ENDPOINT = process.env.WS_MANAGEMENT_ENDPOINT;

if (!CONNECTIONS_TABLE) console.warn('[push] CONNECTIONS_TABLE env var is not set');
if (!WS_ENDPOINT) console.warn('[push] WS_MANAGEMENT_ENDPOINT env var is not set');

exports.handler = async (event) => {
  const apigw = new ApiGatewayManagementApiClient({ endpoint: WS_ENDPOINT });

  for (const record of event.Records) {
    // Only act on new or updated items
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue;

    const newImage = record.dynamodb?.NewImage;
    if (!newImage) continue;

    const item = unmarshall(newImage);
    const { stopKey, departures, fetchedAt } = item;

    if (!stopKey || !departures) {
      console.warn('[push] stream record missing stopKey or departures');
      continue;
    }

    // Find all WebSocket connections subscribed to this exact stop group
    // The groupKey in the connections table is the same sorted comma-joined format
    // as the stopKey in the departures cache.
    const result = await ddb.send(new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: 'groupKey-index',
      KeyConditionExpression: 'groupKey = :gk',
      ExpressionAttributeValues: { ':gk': stopKey },
      ProjectionExpression: 'connectionId',
    }));

    const connections = result.Items || [];
    if (connections.length === 0) continue;

    const message = JSON.stringify({
      type: 'departures',
      departures,
      fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : new Date().toISOString(),
    });
    const msgBytes = Buffer.from(message);

    console.log(`[push] stopKey="${stopKey}" → ${connections.length} subscriber(s)`);

    await Promise.allSettled(connections.map(async ({ connectionId }) => {
      try {
        await apigw.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: msgBytes,
        }));
      } catch (e) {
        if (e.$metadata?.httpStatusCode === 410) {
          // Connection is gone -- clean up DynamoDB
          console.log(`[push] stale connection ${connectionId} -- removing`);
          await ddb.send(new DeleteCommand({
            TableName: CONNECTIONS_TABLE,
            Key: { connectionId },
          })).catch(() => {});
        } else {
          console.warn(`[push] push failed for ${connectionId}:`, e.message);
        }
      }
    }));
  }
};
