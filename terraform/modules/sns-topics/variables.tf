variable "name" {
  description = "SNS topic name"
  type        = string
}

variable "email_addresses" {
  description = "Email addresses to subscribe"
  type        = list(string)
  default     = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
