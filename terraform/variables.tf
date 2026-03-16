variable "aws_region" {
  description = "AWS region for all resources (except ACM for CloudFront which must be us-east-1)"
  type        = string
  default     = "eu-west-1"
}

variable "domain_name" {
  description = "Full domain name for the app (CloudFront + HTTP API)"
  type        = string
  default     = "ov.jarryd.co.za"
}

variable "ws_domain_name" {
  description = "Subdomain for the WebSocket API"
  type        = string
  default     = "ws.ov.jarryd.co.za"
}

variable "route53_zone_name" {
  description = "Route53 hosted zone name (parent domain)"
  type        = string
  default     = "jarryd.co.za"
}

variable "app_name" {
  description = "Application name — used as prefix for all resource names"
  type        = string
  default     = "komt-ie"
}

variable "lambda_memory" {
  description = "Memory (MB) for all Lambda functions"
  type        = number
  default     = 256
}

variable "lambda_timeout" {
  description = "Timeout (seconds) for request-path Lambda functions"
  type        = number
  default     = 15
}

variable "poll_lambda_timeout" {
  description = "Timeout (seconds) for the poll Lambda (OVapi + push to all clients)"
  type        = number
  default     = 30
}

variable "refresh_stops_timeout" {
  description = "Timeout (seconds) for the stops refresh Lambda (downloads 37MB GTFS zip)"
  type        = number
  default     = 300
}
