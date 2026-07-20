variable "name" {
  description = "Log group name (without /ecs/ prefix)"
  type        = string
}

variable "retention_days" {
  description = "Log retention in days"
  type        = number
  default     = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
