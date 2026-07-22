variable "name" {
  description = "ECS service name"
  type        = string
}

variable "cluster_id" {
  description = "ECS cluster ID"
  type        = string
}

variable "cluster_name" {
  description = "ECS cluster name"
  type        = string
}

variable "log_group_name" {
  description = "CloudWatch log group name for awslogs driver"
  type        = string
}

variable "log_group_arn" {
  description = "CloudWatch log group ARN, used to scope the execution role's logging permissions"
  type        = string
}

variable "image_uri" {
  description = "Docker image URI"
  type        = string
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
  description = "Desired number of tasks"
  type        = number
  default     = 2
}

variable "private_subnet_ids" {
  description = "Private subnet IDs"
  type        = list(string)
}

variable "service_sg_id" {
  description = "Security group ID for tasks"
  type        = string
}

variable "target_group_arn" {
  description = "Optional ALB target group ARN"
  type        = string
  default     = ""
}

variable "container_port" {
  description = "Container port to expose"
  type        = number
  default     = 3001

  validation {
    condition     = var.container_port > 0 && var.container_port <= 65535
    error_message = "container_port must be between 1 and 65535."
  }
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "webhook_queue_arn" {
  description = "ARN of the SQS queue used for webhook dispatches."
  type        = string
  default     = ""
}

variable "webhook_queue_url" {
  description = "URL of the SQS queue used for webhook dispatches."
  type        = string
  default     = ""
}

variable "webhook_dlq_arn" {
  description = "ARN of the SQS dead-letter queue for failed webhook dispatches."
  type        = string
  default     = ""
}

variable "webhook_dlq_url" {
  description = "URL of the SQS dead-letter queue for failed webhook dispatches."
  type        = string
  default     = ""
}

variable "webhook_queue_max_receive_count" {
  description = "Number of failed SQS receives before a webhook message is considered exhausted."
  type        = number
  default     = 5
}

variable "webhook_queue_visibility_timeout_seconds" {
  description = "Visibility timeout used by the SQS webhook worker."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags to apply"
  type        = map(string)
  default     = {}
}