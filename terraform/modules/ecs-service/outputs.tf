output "service_name" {
  value = aws_ecs_service.backend.name
}

output "service_arn" {
  value = aws_ecs_service.backend.id
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.backend.arn
}
