# ─────────────────────────────────────────────────────────────────────────────
# Networking module — Variables
# ─────────────────────────────────────────────────────────────────────────────
#
# This module creates the VPC, subnets, internet/NAT gateways, ALB, and
# security groups required for a Fargate ECS service.
#
# All resources are tagged with the project and environment name.
# ─────────────────────────────────────────────────────────────────────────────

variable "name" {
  description = "Resource name prefix (also used for VPC Name tag)."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones to deploy subnets into."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets, one per availability zone."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]

  validation {
    condition     = length(var.private_subnet_cidrs) >= 1
    error_message = "At least one private subnet CIDR must be provided."
  }
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets (ALB + NAT gateways)."
  type        = list(string)
  default     = ["10.0.101.0/24", "10.0.102.0/24"]

  validation {
    condition     = length(var.public_subnet_cidrs) >= 1
    error_message = "At least one public subnet CIDR must be provided."
  }
}

variable "enable_nat_gateway" {
  description = "Deploy NAT gateways for private-subnet outbound traffic. Set false when using VPC endpoints or a transit gateway."
  type        = bool
  default     = true
}

variable "container_port" {
  description = "Application container port (used for ALB target group and ingress SG rules)."
  type        = number
  default     = 3001
}

variable "health_check_path" {
  description = "ALB target group health check endpoint."
  type        = string
  default     = "/health"
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}