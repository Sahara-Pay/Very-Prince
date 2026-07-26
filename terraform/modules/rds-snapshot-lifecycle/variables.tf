variable "name_prefix" {
  description = "Prefix applied to all resource names created by this module."
  type        = string
}

variable "snapshot_retention_days" {
  description = "Number of days to retain manual RDS DB snapshots (and DB cluster snapshots) before they are eligible for deletion."
  type        = number
  default     = 7
}

variable "preferred_backup_window" {
  description = "Preferred daily time range (UTC) in which RDS automated backups are scheduled. Format: `HH:MM-HH:MM`."
  type        = string
  default     = "03:00-04:00"
}

variable "schedule_expression" {
  description = "EventBridge (CloudWatch Events) schedule expression that controls how often the pruning Lambda function is invoked. Uses `rate(...)` or `cron(...)` syntax."
  type        = string
  default     = "rate(1 day)"
}

variable "tags" {
  description = "Additional resource tags. These are merged with the module's default tags."
  type        = map(string)
  default     = {}
}