locals {
  s3_origin_id  = "S3-${var.app_name}-frontend"
  alb_origin_id = "ALB-${var.app_name}-backend"
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  # PriceClass_100 = US, Canada, Europe — best value for a NL-focused app
  price_class = "PriceClass_100"

  # ─── ORIGINS ────────────────────────────────────────────────────────────────

  # S3 origin for the React static files
  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = local.s3_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  # ALB origin for the backend (REST API + WebSocket)
  # CloudFront → ALB over HTTP; CloudFront handles HTTPS termination for the client
  origin {
    domain_name = aws_lb.backend.dns_name
    origin_id   = local.alb_origin_id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # ─── CACHE BEHAVIORS ────────────────────────────────────────────────────────

  # /api/* → ALB (no caching; forward all headers + query strings)
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.alb_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Origin", "Accept"]
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  # /ws → ALB (WebSocket; must forward Connection and Upgrade headers)
  # CloudFront supports WebSocket automatically when Upgrade header is forwarded
  ordered_cache_behavior {
    path_pattern           = "/ws"
    target_origin_id       = local.alb_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = true
      # Forward all headers so the WebSocket Upgrade handshake passes through correctly
      headers      = ["*"]
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  # Default behavior → S3 (cached React SPA)
  default_cache_behavior {
    target_origin_id       = local.s3_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # ─── SPA ROUTING ────────────────────────────────────────────────────────────
  # Return index.html for any path not found in S3 so React Router handles it

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  # ─── TLS ────────────────────────────────────────────────────────────────────

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cert.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}
