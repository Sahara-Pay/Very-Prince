# CloudFront distribution for versioned Next.js static bundles.
# The S3 bucket is managed outside this module; this module grants CloudFront
# read access only to the immutable _next/static prefix.

data "aws_s3_bucket" "assets" {
  bucket = var.asset_bucket_name
}

resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = "${var.name}-oac"
  description                       = "CloudFront access to immutable Next.js static assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "immutable_assets" {
  name        = "${var.name}-immutable"
  comment     = "One-year cache policy for content-hashed Next.js static assets"
  default_ttl = 31536000
  max_ttl     = 31536000
  min_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# Default requests are deliberately not cached. Only the cache behavior below
# is allowed to cache content, keeping the immutable policy scoped to hashed
# Next.js bundles.
resource "aws_cloudfront_cache_policy" "non_immutable" {
  name        = "${var.name}-non-immutable"
  comment     = "No-cache fallback for requests outside _next/static"
  default_ttl = 0
  max_ttl     = 0
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_distribution" "assets" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name} immutable Next.js assets"
  price_class     = var.price_class

  origin {
    domain_name              = data.aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id                = "s3-${var.asset_bucket_name}"
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-${var.asset_bucket_name}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.non_immutable.id
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern           = "_next/static/*"
    target_origin_id       = "s3-${var.asset_bucket_name}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = aws_cloudfront_cache_policy.immutable_assets.id
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  tags = var.tags
}

data "aws_iam_policy_document" "asset_bucket" {
  statement {
    sid    = "AllowCloudFrontReadImmutableNextAssets"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${data.aws_s3_bucket.assets.arn}/_next/static/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.assets.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "asset_bucket" {
  bucket = data.aws_s3_bucket.assets.id
  policy = data.aws_iam_policy_document.asset_bucket.json
}
