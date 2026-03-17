# ─── FRONTEND BUCKET ──────────────────────────────────────────────────────────
# Serves static React build, private — accessed only via CloudFront OAC.

resource "aws_s3_bucket" "frontend" {
  bucket = "${var.app_name}-frontend-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {} # apply to all objects

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# OAC — CloudFront Origin Access Control
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.app_name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowCloudFrontOAC"
      Effect = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action   = "s3:GetObject"
      Resource = "${aws_s3_bucket.frontend.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
        }
      }
    }]
  })
}

# ─── STOPS CACHE BUCKET ───────────────────────────────────────────────────────
# Holds stops_cache.json — written by refresh_stops Lambda, read by http_stops Lambda.

resource "aws_s3_bucket" "ops" {
  bucket = "${var.app_name}-ops-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "ops" {
  bucket                  = aws_s3_bucket.ops.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ops" {
  bucket = aws_s3_bucket.ops.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Seed the stops cache from the local pre-cleaned file so the app works immediately
# after first deploy without waiting for the refresh Lambda to run.
resource "aws_s3_object" "stops_cache_seed" {
  bucket       = aws_s3_bucket.ops.id
  key          = "stops_cache.json"
  source       = "${path.module}/../backend/stops_cache.json"
  content_type = "application/json"
  etag         = filemd5("${path.module}/../backend/stops_cache.json")

  lifecycle {
    # Don't overwrite with the seed file once the refresh Lambda has updated it
    ignore_changes = [etag, source]
  }
}
