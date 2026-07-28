output "topic_arn" {
  value = aws_sns_topic.critical_alerts.arn
}

output "topic_name" {
  value = aws_sns_topic.critical_alerts.name
}
