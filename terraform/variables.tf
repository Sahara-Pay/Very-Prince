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

variable "webhook_queue_visibility_timeout_seconds" {
  description = "Visibility timeout for webhook SQS worker messages."
  type        = number
  default     = 30
}

variable "webhook_queue_max_receive_count" {
  description = "Number of failed webhook message receives before redrive to the DLQ."
  type        = number
  default     = 5
}

variable "webhook_dlq_depth_threshold" {
  description = "Visible message count in the webhook DLQ that triggers an alarm."
  type        = number
  default     = 1
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

# ─── Networking Variables ────────────────────────────────────────────────

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones to deploy subnets into."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets, one per availability zone."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]

  validation {
    condition     = length(var.private_subnet_cidrs) >= 1
    error_message = "At least one private subnet CIDR must be provided."
  }
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets (ALB + NAT gateways)."
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24"]

  validation {
    condition     = length(var.public_subnet_cidrs) >= 1
    error_message = "At least one public subnet CIDR must be provided."
  }
}

variable "enable_nat_gateway" {
  description = "Deploy NAT gateways for private-subnet outbound traffic. Set false when using VPC endpoints or a transit gateway."
  type        = bool
  default     = true
}

variable "container_port" {
  description = "Application container port (used for ALB target group and ingress SG rules)."
  type        = number
  default     = 3001
}

variable "health_check_path" {
  description = "ALB target group health check endpoint."
  type        = string
  default     = "/health"
}

# ─── ECS Service Variables (some now computed from networking module) ────────

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS service placement (now computed from networking module; kept for backward compatibility)."
  type        = list(string)
  default     = []
}

variable "service_sg_id" {
  description = "Security group ID for ECS service tasks (now computed from networking module; kept for backward compatibility)."
  type        = string
  default     = ""
}

variable "image_uri" {
  description = "Docker image URI for the backend service"
  type        = string
  default     = "public.ecr.aws/nginx/nginx:alpine"
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

# ──── RDS Snapshot Lifecycle Variables ──────────────────────────────────────

variable "rds_snapshot_retention_days" {
  description = "Number of days to retain manual RDS DB snapshots before the prune Lambda deletes them."
  type        = number
  default     = 7
}

variable "rds_backup_window" {
  description = "Preferred daily time range (UTC) in which RDS automated backups are scheduled. Format: HH:MM-HH:MM."
  type        = string
  default     = "03:00-04:00"

  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$", var.rds_backup_window))
    error_message = "rds_backup_window must match the HH:MM-HH:MM format in 24-hour UTC time."
  }
}

variable "rds_snapshot_prune_schedule" {
  description = "EventBridge schedule expression that controls how often the RDS snapshot prune Lambda is invoked. Accepts rate(...) or cron(...) syntax."
  type        = string
  default     = "rate(1 day)"

  validation {
    condition     = can(regex("^(rate\\(|cron\\().+", var.rds_snapshot_prune_schedule))
    error_message = "rds_snapshot_prune_schedule must be a valid EventBridge rate(...) or cron(...) expression."
  }
}
