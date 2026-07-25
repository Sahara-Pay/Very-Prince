output "distribution_id" {
  description = "CloudFront distribution ID."
  value       = aws_cloudfront_distribution.assets.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN."
  value       = aws_cloudfront_distribution.assets.arn
}

output "distribution_domain_name" {
  description = "CloudFront distribution domain name."
  value       = aws_cloudfront_distribution.assets.domain_name
}
