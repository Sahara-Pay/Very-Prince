output "service_name" {
  description = "Name of the ECS service."
  value       = aws_ecs_service.backend.name
}

output "service_arn" {
  description = "ARN of the ECS service."
  value       = aws_ecs_service.backend.id
}

output "task_definition_arn" {
  description = "Full ARN of the task definition including revision (e.g. arn:aws:ecs:...:task-definition/very-prince-backend:7)."
  value       = module.task_definition.task_definition_arn
}

output "task_definition_family" {
  description = "Family name without revision (e.g. very-prince-backend)."
  value       = module.task_definition.task_definition_family
}

output "task_definition_revision" {
  description = "Numeric revision of the task definition."
  value       = module.task_definition.task_definition_revision
}

# ─── IAM Role Outputs ────────────────────────────────────────────────────────

output "execution_role_arn" {
  description = "ARN of the Fargate task execution role (image pull, CloudWatch Logs)."
  value       = aws_iam_role.execution.arn
}

output "execution_role_name" {
  description = "Name of the Fargate task execution role."
  value       = aws_iam_role.execution.name
}

output "task_role_arn" {
  description = "ARN of the application task role (attach application policies as needed)."
  value       = aws_iam_role.task.arn
}

output "task_role_name" {
  description = "Name of the application task role."
  value       = aws_iam_role.task.name
}