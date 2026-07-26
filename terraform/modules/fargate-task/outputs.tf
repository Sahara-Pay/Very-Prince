# ─────────────────────────────────────────────────────────────────────────────
# Fargate Task Definition module — Outputs
# ─────────────────────────────────────────────────────────────────────────────

output "task_definition_arn" {
  description = "Full ARN of the task definition including revision (e.g. arn:aws:ecs:...:task-definition/very-prince-backend:7)."
  value       = aws_ecs_task_definition.main.arn
}

output "task_definition_family" {
  description = "Family name without revision (e.g. very-prince-backend)."
  value       = aws_ecs_task_definition.main.family
}

output "task_definition_revision" {
  description = "Numeric revision of the task definition."
  value       = aws_ecs_task_definition.main.revision
}

output "container_definitions" {
  description = "Container definitions JSON, useful for downstream consumers."
  value       = aws_ecs_task_definition.main.container_definitions
}