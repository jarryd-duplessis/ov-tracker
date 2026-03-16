'use strict';

// WebSocket $disconnect handler
// Removes the connectionId from DynamoDB.
// The poll Lambda detects empty groups and stops re-scheduling automatically.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.CONNECTIONS_TABLE;

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { connectionId },
  }));

  console.log(`[disconnect] ${connectionId}`);
  return { statusCode: 200 };
};
