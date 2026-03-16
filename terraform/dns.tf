# ─── ACM CERTIFICATE (us-east-1 for CloudFront) ───────────────────────────────

resource "aws_acm_certificate" "main" {
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cert_validation_main" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = data.aws_route53_zone.zone.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "main" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation_main : r.fqdn]
}

# ─── ACM CERTIFICATE (eu-west-1 for API Gateway WebSocket) ───────────────────

resource "aws_acm_certificate" "ws" {
  domain_name       = var.ws_domain_name
  validation_method = "DNS"

  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cert_validation_ws" {
  for_each = {
    for dvo in aws_acm_certificate.ws.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = data.aws_route53_zone.zone.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "ws" {
  certificate_arn         = aws_acm_certificate.ws.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation_ws : r.fqdn]
}

# ─── API GATEWAY WEBSOCKET CUSTOM DOMAIN ──────────────────────────────────────

resource "aws_apigatewayv2_domain_name" "ws" {
  domain_name = var.ws_domain_name

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.ws.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  domain_name = aws_apigatewayv2_domain_name.ws.id
  stage       = aws_apigatewayv2_stage.ws.id
}

# ─── ROUTE53 DNS ──────────────────────────────────────────────────────────────

# ov.jarryd.co.za → CloudFront
resource "aws_route53_record" "main" {
  zone_id = data.aws_route53_zone.zone.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "main_aaaa" {
  zone_id = data.aws_route53_zone.zone.zone_id
  name    = var.domain_name
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

# ws.ov.jarryd.co.za → API Gateway WebSocket custom domain
resource "aws_route53_record" "ws" {
  zone_id = data.aws_route53_zone.zone.zone_id
  name    = var.ws_domain_name
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.ws.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.ws.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
