variable "name" {
  description = "Name prefix used for CloudFront resources."
  type        = string
}

variable "asset_bucket_name" {
  description = "Name of the existing private S3 bucket containing Next.js assets."
  type        = string
}

variable "price_class" {
  description = "CloudFront edge-location price class."
  type        = string
}

variable "tags" {
  description = "Tags applied to supported AWS resources."
  type        = map(string)
  default     = {}
}
