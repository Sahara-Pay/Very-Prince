variable "name" {
  description = "Base name for the webhook SQS queue."
  type        = string
}

variable "visibility_timeout_seconds" {
  description = "Visibility timeout for webhook worker messages."
  type        = number
  default     = 30
}

variable "message_retention_seconds" {
  description = "Retention period for messages in the source webhook queue."
  type        = number
  default     = 345600
}

variable "dlq_message_retention_seconds" {
  description = "Retention period for messages in the webhook dead-letter queue."
  type        = number
  default     = 1209600
}

variable "max_receive_count" {
  description = "Number of receives before SQS redrives a failed webhook message to the DLQ."
  type        = number
  default     = 5
}

variable "tags" {
  description = "Tags to apply to SQS resources."
  type        = map(string)
  default     = {}
}
