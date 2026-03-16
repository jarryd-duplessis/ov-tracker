# CloudFront distribution — serves the React frontend and proxies HTTP API calls.
#
# Behaviours (in evaluation order):
#   /api/*   →  HTTP API Gateway  (no caching, forward all query strings)
#   /*       →  S3 frontend bucket (long-term caching for hashed assets)
#
# WebSocket connects directly to the API Gateway WebSocket custom domain (ws.ov.jarryd.co.za).
# CloudFront does not proxy WebSocket — API Gateway handles the connection upgrade natively.

locals {
  s3_origin_id   = "s3-frontend"
  http_origin_id = "http-api"
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  price_class         = "PriceClass_100" # EU + North America only (lowest cost)

  # ── Origin: S3 frontend ──────────────────────────────────────────────────
  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  # ── Origin: HTTP API Gateway ─────────────────────────────────────────────
  origin {
    domain_name = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")
    origin_id   = local.http_origin_id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # ── Cache behaviour: /api/* → HTTP API (no caching) ──────────────────────
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.http_origin_id
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = true
      headers      = ["Origin", "Authorization"]
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
    compress    = true
  }

  # ── Default behaviour: /* → S3 frontend ──────────────────────────────────
  default_cache_behavior {
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 86400   # 1 day for static assets
    max_ttl     = 31536000 # 1 year for content-hashed bundles
    compress    = true
  }

  # SPA: return index.html for unknown paths so React Router works
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.main.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
