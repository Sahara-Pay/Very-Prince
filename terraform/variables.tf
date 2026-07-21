# ─────────────────────────────────────────────────────────────────────────────
# Variables
# ─────────────────────────────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region where state resources are provisioned."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Name of the project. Used for tagging."
  type        = string
  default     = "very-prince"
}

variable "environment" {
  description = "Deployment environment. Used for tagging."
  type        = string
  default     = "shared"
}

variable "state_bucket_name" {
  description = "Globally unique name of the S3 bucket that stores Terraform state."
  type        = string
  default     = "very-prince-terraform-state"
}

variable "dynamodb_lock_table_name" {
  description = "Name of the DynamoDB table used for Terraform state locking."
  type        = string
  default     = "very-prince-terraform-locks"
}

# ──── Monitoring & ECS Variables ────────────────────────────────────────────

variable "alert_email_addresses" {
  description = "Email addresses subscribed to critical-alerts SNS topic"
  type        = list(string)
  default     = []
}

variable "cpu_threshold_pct" {
  description = "CPU utilization alarm threshold (percentage)"
  type        = number
  default     = 80
}

variable "memory_threshold_pct" {
  description = "Memory utilization alarm threshold (percentage)"
  type        = number
  default     = 80
}

variable "log_retention_days" {
  description = "CloudWatch log group retention in days"
  type        = number
  default     = 30
}

variable "service_name" {
  description = "ECS service name (also used for log group prefix)"
  type        = string
  default     = "very-prince-backend"
}

variable "task_cpu" {
  description = "Task CPU units (1024 = 1 vCPU)"
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Task memory in MiB"
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Desired number of ECS tasks"
  type        = number
  default     = 2
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS service placement"
  type        = list(string)
}

variable "service_sg_id" {
  description = "Security group ID for ECS service tasks"
  type        = string
}

variable "image_uri" {
  description = "Docker image URI for the backend service"
  type        = string
}

variable "target_group_arn" {
  description = "Optional ALB target group ARN"
  type        = string
  default     = ""
}

# ─── Next.js Static Asset CDN Variables ────────────────────────────────────

variable "asset_bucket_name" {
  description = "Name of the existing private S3 bucket that contains Next.js static assets."
  type        = string
}

variable "cloudfront_price_class" {
  description = "CloudFront edge-location price class. Use PriceClass_All to minimize global latency."
  type        = string
  default     = "PriceClass_All"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.cloudfront_price_class)
    error_message = "cloudfront_price_class must be PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}

# ──── State Backend Variables ────────────────────────────────────────────────

variable "enable_state_bucket_policy" {
  description = "When true, attaches an S3 bucket policy that denies non-SSL access to the Terraform state bucket. Disable only if running on a private network without TLS endpoints."
  type        = bool
  default     = true
}

variable "state_key" {
  description = "S3 object key under which the Terraform state file is stored. Override this only when provisioning additional workspaces or environments that share the state bucket."
  type        = string
  default     = "infrastructure/terraform.tfstate"
}
