# Connections table — tracks every active WebSocket client.
#
# Schema:
#   PK:  connectionId  (String)  — API Gateway connection ID
#   GSI: groupKey-index on groupKey (String) — used by poll Lambda
#        to find all connectionIds watching the same stops
#
# Attributes per item:
#   connectionId  String   PK
#   groupKey      String   sorted stop codes joined by comma
#   stopCodes     List     up to 20 stop codes
#   ttl           Number   Unix timestamp; DynamoDB TTL auto-deletes stale rows

resource "aws_dynamodb_table" "connections" {
  name         = "${var.app_name}-connections"
  billing_mode = "PAY_PER_REQUEST" # no capacity planning needed; serverless
  hash_key     = "connectionId"

  attribute {
    name = "connectionId"
    type = "S"
  }

  attribute {
    name = "groupKey"
    type = "S"
  }

  global_secondary_index {
    name            = "groupKey-index"
    hash_key        = "groupKey"
    projection_type = "INCLUDE"
    non_key_attributes = ["connectionId"]
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = false # cost saving — this is ephemeral connection state
  }
}

# Departures cache — shared across all Lambda containers.
#
# Schema:
#   PK:  stopKey  (String)  — sorted KV7 stop codes joined by comma
#   fetchedAt  Number   Unix ms timestamp of last OVapi fetch
#   departures List     cached departure objects
#   ttl        Number   Unix seconds; DynamoDB TTL auto-deletes items after ~30s
#
# Streams enabled (NEW_IMAGE) so a future push Lambda can subscribe to writes
# and fan out to WebSocket clients without any polling.

resource "aws_dynamodb_table" "departures_cache" {
  name         = "${var.app_name}-departures-cache"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "stopKey"

  attribute {
    name = "stopKey"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"

  point_in_time_recovery {
    enabled = false
  }
}
