output "cpu_alarm_arn" {
  value = aws_cloudwatch_metric_alarm.cpu_high.arn
}

output "memory_alarm_arn" {
  value = aws_cloudwatch_metric_alarm.memory_high.arn
}

output "webhook_dlq_depth_alarm_arn" {
  value = try(aws_cloudwatch_metric_alarm.webhook_dlq_depth_high[0].arn, null)
}
