# ─── LAMBDA PACKAGE ───────────────────────────────────────────────────────────

# Install npm deps before zipping
resource "null_resource" "lambda_deps" {
  provisioner "local-exec" {
    command     = "npm ci --omit=dev"
    working_dir = "${path.module}/../lambda"
  }

  triggers = {
    package_lock = filemd5("${path.module}/../lambda/package.json")
  }
}

# Zip the entire lambda/ directory (handlers + lib/ + routes.txt + node_modules/)
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda"
  output_path = "${path.module}/lambda.zip"
  depends_on  = [null_resource.lambda_deps]
}

# ─── COMMON IAM ASSUME-ROLE POLICY ────────────────────────────────────────────

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ─── SHARED INLINE POLICIES ───────────────────────────────────────────────────

data "aws_iam_policy_document" "logs" {
  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:*"]
  }
}

data "aws_iam_policy_document" "dynamodb_rw" {
  statement {
    actions = [
      "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
      "dynamodb:DeleteItem", "dynamodb:Query"
    ]
    resources = [
      aws_dynamodb_table.connections.arn,
      "${aws_dynamodb_table.connections.arn}/index/*"
    ]
  }
}

data "aws_iam_policy_document" "sqs_rw" {
  statement {
    actions   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.poll.arn]
  }
}

data "aws_iam_policy_document" "s3_stops_ro" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.ops.arn}/stops_cache.json"]
  }
}

data "aws_iam_policy_document" "s3_stops_rw" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = [
      "${aws_s3_bucket.ops.arn}/stops_cache.json",
      "${aws_s3_bucket.ops.arn}/trips/*",
    ]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.ops.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["trips/*"]
    }
  }
}

data "aws_iam_policy_document" "s3_trips_ro" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.ops.arn}/trips/*"]
  }
}

data "aws_iam_policy_document" "departures_cache_rw" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.departures_cache.arn]
  }
}

data "aws_iam_policy_document" "s3_vehicles_cache_rw" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = [
      "${aws_s3_bucket.ops.arn}/vehicles_cache.json",
      "${aws_s3_bucket.ops.arn}/tiles/*",
      "${aws_s3_bucket.ops.arn}/events/*",
    ]
  }
}

data "aws_iam_policy_document" "apigw_manage" {
  statement {
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.ws.execution_arn}/*/*/@connections/*"]
  }
}

# ─── WS CONNECT LAMBDA ────────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_connect" {
  name               = "${var.app_name}-lambda-connect"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_connect_logs" {
  role   = aws_iam_role.lambda_connect.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_role_policy" "lambda_connect_ddb" {
  role   = aws_iam_role.lambda_connect.id
  policy = data.aws_iam_policy_document.dynamodb_rw.json
}

resource "aws_lambda_function" "connect" {
  function_name                  = "${var.app_name}-connect"
  role                           = aws_iam_role.lambda_connect.arn
  handler                        = "connect.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = var.lambda_timeout
  memory_size                    = var.lambda_memory
  reserved_concurrent_executions = 50

  environment {
    variables = {
      CONNECTIONS_TABLE = aws_dynamodb_table.connections.name
    }
  }
}

resource "aws_cloudwatch_log_group" "connect" {
  name              = "/aws/lambda/${aws_lambda_function.connect.function_name}"
  retention_in_days = 30
}

# ─── WS DISCONNECT LAMBDA ─────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_disconnect" {
  name               = "${var.app_name}-lambda-disconnect"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_disconnect_logs" {
  role   = aws_iam_role.lambda_disconnect.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_role_policy" "lambda_disconnect_ddb" {
  role   = aws_iam_role.lambda_disconnect.id
  policy = data.aws_iam_policy_document.dynamodb_rw.json
}

resource "aws_lambda_function" "disconnect" {
  function_name                  = "${var.app_name}-disconnect"
  role                           = aws_iam_role.lambda_disconnect.arn
  handler                        = "disconnect.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = var.lambda_timeout
  memory_size                    = var.lambda_memory
  reserved_concurrent_executions = 50

  environment {
    variables = {
      CONNECTIONS_TABLE = aws_dynamodb_table.connections.name
    }
  }
}

resource "aws_cloudwatch_log_group" "disconnect" {
  name              = "/aws/lambda/${aws_lambda_function.disconnect.function_name}"
  retention_in_days = 30
}

# ─── WS MESSAGE LAMBDA ────────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_ws_message" {
  name               = "${var.app_name}-lambda-ws-message"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_ws_message_logs" {
  role   = aws_iam_role.lambda_ws_message.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_role_policy" "lambda_ws_message_ddb" {
  role   = aws_iam_role.lambda_ws_message.id
  policy = data.aws_iam_policy_document.dynamodb_rw.json
}

resource "aws_iam_role_policy" "lambda_ws_message_sqs" {
  role   = aws_iam_role.lambda_ws_message.id
  policy = data.aws_iam_policy_document.sqs_rw.json
}

resource "aws_lambda_function" "ws_message" {
  function_name                  = "${var.app_name}-ws-message"
  role                           = aws_iam_role.lambda_ws_message.arn
  handler                        = "ws_message.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = var.lambda_timeout
  memory_size                    = var.lambda_memory
  reserved_concurrent_executions = 50

  environment {
    variables = {
      CONNECTIONS_TABLE = aws_dynamodb_table.connections.name
      POLL_QUEUE_URL    = aws_sqs_queue.poll.url
    }
  }
}

resource "aws_cloudwatch_log_group" "ws_message" {
  name              = "/aws/lambda/${aws_lambda_function.ws_message.function_name}"
  retention_in_days = 30
}

# ─── POLL LAMBDA ──────────────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_poll" {
  name               = "${var.app_name}-lambda-poll"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_poll_logs" {
  role   = aws_iam_role.lambda_poll.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_role_policy" "lambda_poll_ddb" {
  role   = aws_iam_role.lambda_poll.id
  policy = data.aws_iam_policy_document.dynamodb_rw.json
}

resource "aws_iam_role_policy" "lambda_poll_sqs" {
  role   = aws_iam_role.lambda_poll.id
  policy = data.aws_iam_policy_document.sqs_rw.json
}

resource "aws_iam_role_policy" "lambda_poll_apigw" {
  role   = aws_iam_role.lambda_poll.id
  policy = data.aws_iam_policy_document.apigw_manage.json
}

resource "aws_lambda_function" "poll" {
  function_name                  = "${var.app_name}-poll"
  role                           = aws_iam_role.lambda_poll.arn
  handler                        = "poll.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = var.poll_lambda_timeout
  memory_size                    = var.lambda_memory
  reserved_concurrent_executions = 10

  environment {
    variables = {
      CONNECTIONS_TABLE     = aws_dynamodb_table.connections.name
      POLL_QUEUE_URL        = aws_sqs_queue.poll.url
      WS_MANAGEMENT_ENDPOINT = "https://${aws_apigatewayv2_api.ws.id}.execute-api.${data.aws_region.current.name}.amazonaws.com/${aws_apigatewayv2_stage.ws.name}"
    }
  }
}

resource "aws_cloudwatch_log_group" "poll" {
  name              = "/aws/lambda/${aws_lambda_function.poll.function_name}"
  retention_in_days = 30
}

# SQS → poll Lambda trigger — DISABLED.
# The Lambda→SQS→Lambda self-scheduling pattern caused an AWS recursive loop detection event.
# Departures are now fetched by the frontend via HTTP polling (/api/departures).
resource "aws_lambda_event_source_mapping" "poll_sqs" {
  event_source_arn = aws_sqs_queue.poll.arn
  function_name    = aws_lambda_function.poll.arn
  batch_size       = 1
  enabled          = false
}

# ─── HTTP STOPS LAMBDA ────────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_http_stops" {
  name               = "${var.app_name}-lambda-http-stops"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_http_stops_logs" {
  role   = aws_iam_role.lambda_http_stops.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_role_policy" "lambda_http_stops_s3" {
  role   = aws_iam_role.lambda_http_stops.id
  policy = data.aws_iam_policy_document.s3_stops_ro.json
}

resource "aws_lambda_function" "http_stops" {
  function_name                  = "${var.app_name}-http-stops"
  role                           = aws_iam_role.lambda_http_stops.arn
  handler                        = "http_stops.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = var.lambda_timeout
  memory_size                    = var.lambda_memory
  reserved_concurrent_executions = 50

  environment {
    variables = {
      STOPS_BUCKET = aws_s3_bucket.ops.id
    }
  }
}

resource "aws_cloudwatch_log_group" "http_stops" {
  name              = "/aws/lambda/${aws_lambda_function.http_stops.function_name}"
  retention_in_days = 30
}

# ─── HTTP DEPARTURES LAMBDA ───────────────────────────────────────────────────

resource "aws_iam_role" "lambda_http_departures" {
  name               = "${var.app_name}-lambda-http-departures"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_http_departures_logs" {
  role   = aws_iam_role.lambda_http_departures.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_role_policy" "lambda_http_departures_cache" {
  role   = aws_iam_role.lambda_http_departures.id
  policy = data.aws_iam_policy_document.departures_cache_rw.json
}

resource "aws_lambda_function" "http_departures" {
  function_name                  = "${var.app_name}-http-departures"
  role                           = aws_iam_role.lambda_http_departures.arn
  handler                        = "http_departures.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = var.lambda_timeout
  memory_size                    = var.lambda_memory
  reserved_concurrent_executions = 100

  environment {
    variables = {
      CACHE_TABLE = aws_dynamodb_table.departures_cache.name
    }
  }
}

resource "aws_cloudwatch_log_group" "http_departures" {
  name              = "/aws/lambda/${aws_lambda_function.http_departures.function_name}"
  retention_in_days = 30
}

# ─── HTTP VEHICLES LAMBDA ─────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_http_vehicles" {
  name               = "${var.app_name}-lambda-http-vehicles"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_http_vehicles_logs" {
  role   = aws_iam_role.lambda_http_vehicles.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_role_policy" "lambda_http_vehicles_cache" {
  role   = aws_iam_role.lambda_http_vehicles.id
  policy = data.aws_iam_policy_document.s3_vehicles_cache_rw.json
}

resource "aws_lambda_function" "http_vehicles" {
  function_name                  = "${var.app_name}-http-vehicles"
  role                           = aws_iam_role.lambda_http_vehicles.arn
  handler                        = "http_vehicles.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = var.lambda_timeout
  memory_size                    = var.lambda_memory
  reserved_concurrent_executions = 100

  environment {
    variables = {
      CACHE_BUCKET = aws_s3_bucket.ops.id
    }
  }
}

resource "aws_cloudwatch_log_group" "http_vehicles" {
  name              = "/aws/lambda/${aws_lambda_function.http_vehicles.function_name}"
  retention_in_days = 30
}

# ─── HTTP JOURNEY LAMBDA ──────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_http_journey" {
  name               = "${var.app_name}-lambda-http-journey"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_http_journey_logs" {
  role   = aws_iam_role.lambda_http_journey.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_lambda_function" "http_journey" {
  function_name                  = "${var.app_name}-http-journey"
  role                           = aws_iam_role.lambda_http_journey.arn
  handler                        = "http_journey.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = var.lambda_timeout
  memory_size                    = var.lambda_memory
  reserved_concurrent_executions = 20
}

resource "aws_cloudwatch_log_group" "http_journey" {
  name              = "/aws/lambda/${aws_lambda_function.http_journey.function_name}"
  retention_in_days = 30
}

# ─── HTTP TRIP LAMBDA ────────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_http_trip" {
  name               = "${var.app_name}-lambda-http-trip"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_http_trip_logs" {
  role   = aws_iam_role.lambda_http_trip.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_role_policy" "lambda_http_trip_s3" {
  role   = aws_iam_role.lambda_http_trip.id
  policy = data.aws_iam_policy_document.s3_trips_ro.json
}

resource "aws_lambda_function" "http_trip" {
  function_name                  = "${var.app_name}-http-trip"
  role                           = aws_iam_role.lambda_http_trip.arn
  handler                        = "http_trip.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = var.lambda_timeout
  memory_size                    = var.lambda_memory
  reserved_concurrent_executions = 50

  environment {
    variables = {
      STOPS_BUCKET = aws_s3_bucket.ops.id
    }
  }
}

resource "aws_cloudwatch_log_group" "http_trip" {
  name              = "/aws/lambda/${aws_lambda_function.http_trip.function_name}"
  retention_in_days = 30
}

# ─── REFRESH STOPS LAMBDA ─────────────────────────────────────────────────────

resource "aws_iam_role" "lambda_refresh_stops" {
  name               = "${var.app_name}-lambda-refresh-stops"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_refresh_stops_logs" {
  role   = aws_iam_role.lambda_refresh_stops.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_role_policy" "lambda_refresh_stops_s3" {
  role   = aws_iam_role.lambda_refresh_stops.id
  policy = data.aws_iam_policy_document.s3_stops_rw.json
}

resource "aws_lambda_function" "refresh_stops" {
  function_name                  = "${var.app_name}-refresh-stops"
  role                           = aws_iam_role.lambda_refresh_stops.arn
  handler                        = "refresh_stops.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = var.refresh_stops_timeout
  memory_size                    = 3072 # needs memory for KV7 (37MB) + openov-nl (224MB) zips + streaming stop_times
  reserved_concurrent_executions = 2

  environment {
    variables = {
      STOPS_BUCKET = aws_s3_bucket.ops.id
    }
  }
}

resource "aws_cloudwatch_log_group" "refresh_stops" {
  name              = "/aws/lambda/${aws_lambda_function.refresh_stops.function_name}"
  retention_in_days = 30
}

# EventBridge rule: run refresh_stops daily at 03:00 UTC
resource "aws_cloudwatch_event_rule" "refresh_stops" {
  name                = "${var.app_name}-refresh-stops"
  description         = "Daily KV7 GTFS stops cache refresh"
  schedule_expression = "cron(0 3 * * ? *)"
}

resource "aws_cloudwatch_event_target" "refresh_stops" {
  rule      = aws_cloudwatch_event_rule.refresh_stops.name
  target_id = "refresh-stops"
  arn       = aws_lambda_function.refresh_stops.arn
}

resource "aws_lambda_permission" "refresh_stops_eventbridge" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.refresh_stops.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.refresh_stops.arn
}

# ─── VEHICLE INGESTION PIPELINE ──────────────────────────────────────────────
# Runs every minute via EventBridge. Internally loops at 5s intervals.
# Fetches GTFS-RT, computes bearing/speed/confidence, writes geographic tiles
# to S3, and persists raw events for analytics.

resource "aws_iam_role" "lambda_ingest_vehicles" {
  name               = "${var.app_name}-lambda-ingest-vehicles"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy" "lambda_ingest_vehicles_logs" {
  role   = aws_iam_role.lambda_ingest_vehicles.id
  policy = data.aws_iam_policy_document.logs.json
}

resource "aws_iam_role_policy" "lambda_ingest_vehicles_s3" {
  role   = aws_iam_role.lambda_ingest_vehicles.id
  policy = data.aws_iam_policy_document.s3_vehicles_cache_rw.json
}

resource "aws_lambda_function" "ingest_vehicles" {
  function_name                  = "${var.app_name}-ingest-vehicles"
  role                           = aws_iam_role.lambda_ingest_vehicles.arn
  handler                        = "ingest_vehicles.handler"
  runtime                        = "nodejs20.x"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  timeout                        = 65 # runs for ~55s internally, 10s buffer
  memory_size                    = 256
  reserved_concurrent_executions = 1 # only one instance at a time

  environment {
    variables = {
      CACHE_BUCKET = aws_s3_bucket.ops.id
    }
  }
}

resource "aws_cloudwatch_log_group" "ingest_vehicles" {
  name              = "/aws/lambda/${aws_lambda_function.ingest_vehicles.function_name}"
  retention_in_days = 7
}

# EventBridge: trigger every 1 minute
resource "aws_cloudwatch_event_rule" "ingest_vehicles" {
  name                = "${var.app_name}-ingest-vehicles"
  description         = "Vehicle position ingestion pipeline (runs every minute, loops at 5s)"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "ingest_vehicles" {
  rule      = aws_cloudwatch_event_rule.ingest_vehicles.name
  target_id = "ingest-vehicles"
  arn       = aws_lambda_function.ingest_vehicles.arn
}

resource "aws_lambda_permission" "ingest_vehicles_eventbridge" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest_vehicles.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.ingest_vehicles.arn
}
