variable "name" {
  description = "ECS cluster name (must be non-empty, ≤255 chars, and match the pattern)"
  type        = string

  validation {
    condition     = length(var.name) > 0 && length(var.name) <= 255 && can(regex("^[a-zA-Z][a-zA-Z0-9_-]*$", var.name))
    error_message = "name must be a non-empty string between 1 and 255 characters, starting with a letter, and containing only letters, digits, hyphens, and underscores."
  }
}

variable "tags" {
  description = "Tags to apply to cluster resources"
  type        = map(string)
  default     = {}
}
