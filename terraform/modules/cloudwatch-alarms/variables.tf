variable "cluster_name" {
  type = string
}

variable "service_name" {
  type = string
}

variable "sns_topic_arn" {
  type = string
}

variable "cpu_threshold_pct" {
  type    = number
  default = 80
}

variable "memory_threshold_pct" {
  type    = number
  default = 80
}

variable "evaluation_periods" {
  type    = number
  default = 2
}

variable "period_seconds" {
  type    = number
  default = 60
}

variable "webhook_dlq_queue_name" {
  type    = string
  default = ""
}

variable "webhook_dlq_depth_threshold" {
  type    = number
  default = 1
}

variable "tags" {
  type    = map(string)
  default = {}
}
