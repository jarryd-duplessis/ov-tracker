# ─── WEBSOCKET API ────────────────────────────────────────────────────────────
# Clients connect to wss://ws.ov.jarryd.co.za (custom domain, see dns.tf).
# Route selection expression routes on the message body's "type" field.

resource "aws_apigatewayv2_api" "ws" {
  name                       = "${var.app_name}-ws"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.type"
}

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = "prod"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 500
    throttling_rate_limit  = 1000
  }
}

# $connect
resource "aws_apigatewayv2_integration" "ws_connect" {
  api_id                    = aws_apigatewayv2_api.ws.id
  integration_type          = "AWS_PROXY"
  integration_uri           = aws_lambda_function.connect.invoke_arn
  payload_format_version    = "1.0" # WebSocket only supports 1.0
}

resource "aws_apigatewayv2_route" "ws_connect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_connect.id}"
}

resource "aws_lambda_permission" "ws_connect" {
  statement_id  = "AllowAPIGWConnect"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.connect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

# $disconnect
resource "aws_apigatewayv2_integration" "ws_disconnect" {
  api_id                 = aws_apigatewayv2_api.ws.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.disconnect.invoke_arn
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "ws_disconnect" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.ws_disconnect.id}"
}

resource "aws_lambda_permission" "ws_disconnect" {
  statement_id  = "AllowAPIGWDisconnect"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.disconnect.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

# $default — handles subscribe, unsubscribe, and any unmatched messages
resource "aws_apigatewayv2_integration" "ws_message" {
  api_id                 = aws_apigatewayv2_api.ws.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.ws_message.invoke_arn
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "ws_default" {
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.ws_message.id}"
}

resource "aws_lambda_permission" "ws_message" {
  statement_id  = "AllowAPIGWMessage"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_message.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

# ─── HTTP API ─────────────────────────────────────────────────────────────────
# REST endpoints — proxied by CloudFront at ov.jarryd.co.za/api/*

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.app_name}-http"
  protocol_type = "HTTP"

  cors_configuration {
    allow_headers = ["Content-Type", "Authorization"]
    allow_methods = ["GET", "OPTIONS"]
    allow_origins = ["https://${var.domain_name}"]
  }
}

resource "aws_apigatewayv2_stage" "http" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
}

# Helper to create HTTP integrations + routes + permissions
locals {
  http_routes = {
    stops      = { function = aws_lambda_function.http_stops,      path = "GET /stops/nearby"  }
    departures = { function = aws_lambda_function.http_departures, path = "GET /departures"     }
    vehicles   = { function = aws_lambda_function.http_vehicles,   path = "GET /vehicles"       }
    journey    = { function = aws_lambda_function.http_journey,    path = "GET /journey"        }
  }
}

resource "aws_apigatewayv2_integration" "http_stops" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.http_stops.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "http_stops" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /stops/nearby"
  target    = "integrations/${aws_apigatewayv2_integration.http_stops.id}"
}

resource "aws_lambda_permission" "http_stops" {
  statement_id  = "AllowHTTPAPIStops"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_stops.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_apigatewayv2_integration" "http_departures" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.http_departures.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "http_departures" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /departures"
  target    = "integrations/${aws_apigatewayv2_integration.http_departures.id}"
}

resource "aws_lambda_permission" "http_departures" {
  statement_id  = "AllowHTTPAPIDepartures"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_departures.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_apigatewayv2_integration" "http_vehicles" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.http_vehicles.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "http_vehicles" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /vehicles"
  target    = "integrations/${aws_apigatewayv2_integration.http_vehicles.id}"
}

resource "aws_lambda_permission" "http_vehicles" {
  statement_id  = "AllowHTTPAPIVehicles"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_vehicles.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_apigatewayv2_integration" "http_journey" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.http_journey.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "http_journey" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "GET /journey"
  target    = "integrations/${aws_apigatewayv2_integration.http_journey.id}"
}

resource "aws_lambda_permission" "http_journey" {
  statement_id  = "AllowHTTPAPIJourney"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.http_journey.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
