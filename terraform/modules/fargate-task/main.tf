# ─────────────────────────────────────────────────────────────────────────────
# Fargate Task Definition module — Main
# ─────────────────────────────────────────────────────────────────────────────
#
# Creates an `aws_ecs_task_definition` strictly typed for AWS Fargate.
# All upstream resources (cluster, IAM roles, ALB target group) are
# provided by callers; this module owns only the task definition.
# ─────────────────────────────────────────────────────────────────────────────

resource "aws_ecs_task_definition" "main" {
  family                   = var.family
  cpu                      = var.cpu
  memory                   = var.memory
  network_mode             = var.network_mode
  requires_compatibilities = var.requires_compatibilities
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn
  container_definitions    = var.container_definitions

  runtime_platform {
    operating_system_family = var.operating_system_family
  }

  tags = merge(var.tags, {
    Name = var.family
  })
}