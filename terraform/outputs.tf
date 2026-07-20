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
