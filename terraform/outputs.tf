# ─────────────────────────────────────────────────────────────────────────────
# Outputs
# ─────────────────────────────────────────────────────────────────────────────

output "state_bucket_arn" {
  description = "ARN of the S3 bucket used for Terraform state storage."
  value       = aws_s3_bucket.terraform_state.arn
}

output "state_bucket_name" {
  description = "Name of the S3 bucket used for Terraform state storage."
  value       = aws_s3_bucket.terraform_state.id
}

output "dynamodb_lock_table_name" {
  description = "Name of the DynamoDB table used for Terraform state locking."
  value       = aws_dynamodb_table.terraform_locks.name
}

output "dynamodb_lock_table_arn" {
  description = "ARN of the DynamoDB table used for Terraform state locking."
  value       = aws_dynamodb_table.terraform_locks.arn
}

# ──── Monitoring & ECS Outputs ──────────────────────────────────────────────

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = module.ecs_cluster.cluster_name
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = module.ecs_service.service_name
}

output "sns_topic_arn" {
  description = "ARN of the SNS topic for critical alerts"
  value       = module.sns_topics.topic_arn
}

output "cloudwatch_dashboard_url" {
  description = "URL to access the CloudWatch dashboard"
  value       = module.cloudwatch_dashboard.dashboard_url
}

output "cloudwatch_log_group_name" {
  description = "Name of the CloudWatch log group"
  value       = module.cloudwatch_logs.log_group_name
}
