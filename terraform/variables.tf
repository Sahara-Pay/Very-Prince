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
