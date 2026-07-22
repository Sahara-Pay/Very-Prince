output "lambda_function_name" {
  description = "Name of the AWS Lambda function that runs the RDS snapshot pruning logic."
  value       = aws_lambda_function.prune.function_name
}

output "lambda_function_arn" {
  description = "ARN of the AWS Lambda function used for RDS snapshot deletion."
  value       = aws_lambda_function.prune.arn
}

output "event_rule_arn" {
  description = "ARN of the EventBridge (CloudWatch Events) rule that triggers the snapshot pruning Lambda on a recurring schedule."
  value       = aws_cloudwatch_event_rule.prune_schedule.arn
}

output "role_arn" {
  description = "ARN of the IAM role assumed by the Lambda function during execution."
  value       = aws_iam_role.lambda.arn
}