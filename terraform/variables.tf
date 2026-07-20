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
