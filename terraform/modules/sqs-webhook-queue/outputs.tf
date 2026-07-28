output "queue_arn" {
  description = "ARN of the webhook source queue."
  value       = aws_sqs_queue.source.arn
}

output "queue_name" {
  description = "Name of the webhook source queue."
  value       = aws_sqs_queue.source.name
}

output "queue_url" {
  description = "URL of the webhook source queue."
  value       = aws_sqs_queue.source.id
}

output "dlq_arn" {
  description = "ARN of the webhook dead-letter queue."
  value       = aws_sqs_queue.dlq.arn
}

output "dlq_name" {
  description = "Name of the webhook dead-letter queue."
  value       = aws_sqs_queue.dlq.name
}

output "dlq_url" {
  description = "URL of the webhook dead-letter queue."
  value       = aws_sqs_queue.dlq.id
}
