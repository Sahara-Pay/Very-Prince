# ─────────────────────────────────────────────────────────────────────────────
# Fargate Task Definition module — Variables
# ─────────────────────────────────────────────────────────────────────────────
#
# Strict, declarative task definition module. Inputs are validated up-front
# so callers cannot create an under-specified or invalid Fargate task.
# ─────────────────────────────────────────────────────────────────────────────

variable "family" {
  description = "Task definition family (e.g. \"very-prince-backend\")."
  type        = string

  validation {
    condition     = length(var.family) > 0 && length(var.family) <= 255
    error_message = "family must be a non-empty string up to 255 characters."
  }
}

variable "cpu" {
  description = "Total CPU units reserved for the task. Must be a Fargate-supported value (e.g. \"256\", \"512\", \"1024\", \"2048\", \"4096\")."
  type        = string
  default     = "512"

  validation {
    condition     = contains(["256", "512", "1024", "2048", "4096", "8192", "16384"], var.cpu)
    error_message = "cpu must be one of: 256, 512, 1024, 2048, 4096, 8192, 16384."
  }
}

variable "memory" {
  description = "Total memory (MiB) reserved for the task. Must be a Fargate-supported value (e.g. \"512\", \"1024\", \"2048\")."
  type        = string
  default     = "1024"

  validation {
    condition     = contains(["512", "1024", "2048", "3072", "4096", "5120", "6144", "7168", "8192"], var.memory)
    error_message = "memory must be a Fargate-supported value in MiB."
  }
}

variable "container_definitions" {
  description = "JSON-encoded container definitions payload (use jsonencode() at the call site)."
  type        = string

  validation {
    condition     = length(var.container_definitions) > 0
    error_message = "container_definitions must not be empty."
  }
}

variable "execution_role_arn" {
  description = "ARN of the IAM role used by ECS to pull images and write logs."
  type        = string
}

variable "task_role_arn" {
  description = "Optional ARN of the IAM role assumed by the running task to call AWS APIs."
  type        = string
  default     = ""
}

variable "requires_compatibilities" {
  description = "Launch types the task is compatible with. Fargate is required by default."
  type        = list(string)
  default     = ["FARGATE"]

  validation {
    condition     = contains(var.requires_compatibilities, "FARGATE")
    error_message = "requires_compatibilities must include \"FARGATE\"."
  }
}

variable "network_mode" {
  description = "Docker network mode. \"awsvpc\" is required for Fargate."
  type        = string
  default     = "awsvpc"

  validation {
    condition     = var.network_mode == "awsvpc"
    error_message = "network_mode must be \"awsvpc\" when using Fargate."
  }
}

variable "operating_system_family" {
  description = "Operating system family for the task runtime platform."
  type        = string
  default     = "LINUX"

  validation {
    condition     = contains(["LINUX", "WINDOWS_SERVER_2019_CORE", "WINDOWS_SERVER_2019_FULL", "WINDOWS_SERVER_2022_CORE", "WINDOWS_SERVER_2022_FULL"], var.operating_system_family)
    error_message = "operating_system_family must be a supported ECS value."
  }
}

variable "tags" {
  description = "Tags applied to the task definition."
  type        = map(string)
  default     = {}
}