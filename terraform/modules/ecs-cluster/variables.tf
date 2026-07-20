variable "name" {
  description = "ECS cluster name"
  type        = string
}

variable "tags" {
  description = "Tags to apply to cluster resources"
  type        = map(string)
  default     = {}
}
