output "frontend_url" {
  description = "Public URL of the app"
  value       = "https://${var.domain_name}"
}

output "ws_url" {
  description = "WebSocket URL (set as VITE_WS_URL in your frontend build)"
  value       = "wss://${var.ws_domain_name}"
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID — needed for cache invalidation on deploy"
  value       = aws_cloudfront_distribution.main.id
}

output "frontend_bucket" {
  description = "S3 bucket for frontend static files"
  value       = aws_s3_bucket.frontend.id
}

output "ops_bucket" {
  description = "S3 bucket for ops data (stops_cache.json)"
  value       = aws_s3_bucket.ops.id
}

output "ws_api_id" {
  description = "API Gateway WebSocket API ID"
  value       = aws_apigatewayv2_api.ws.id
}

output "http_api_endpoint" {
  description = "API Gateway HTTP API base URL (without custom domain)"
  value       = aws_apigatewayv2_api.http.api_endpoint
}
