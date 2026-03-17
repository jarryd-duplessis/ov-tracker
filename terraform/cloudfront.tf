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

resource "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "${var.app_name}-security-headers"

  security_headers_config {
    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
    }

    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tiles.openfreemap.org; connect-src 'self' wss://ws.ov.jarryd.co.za https://tiles.openfreemap.org https://nominatim.openstreetmap.org; worker-src blob:; child-src blob:"
      override                = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
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

    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac" # AllViewerExceptHostHeader

    compress = true
  }

  # ── Default behaviour: /* → S3 frontend ──────────────────────────────────
  default_cache_behavior {
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security_headers.id

    compress = true
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
