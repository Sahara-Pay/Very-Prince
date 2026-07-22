resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "${var.cluster_name}-${var.service_name}-cpu-high"
  alarm_description   = "CPU utilization >= ${var.cpu_threshold_pct}% for ${var.evaluation_periods} periods of ${var.period_seconds}s each"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = var.evaluation_periods
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = var.period_seconds
  statistic           = "Average"
  threshold           = var.cpu_threshold_pct
  treat_missing_data  = "missing"

  dimensions = {
    ClusterName = var.cluster_name
    ServiceName = var.service_name
  }

  alarm_actions = [var.sns_topic_arn]
  ok_actions    = [var.sns_topic_arn]

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "memory_high" {
  alarm_name          = "${var.cluster_name}-${var.service_name}-memory-high"
  alarm_description   = "Memory utilization >= ${var.memory_threshold_pct}% for ${var.evaluation_periods} periods of ${var.period_seconds}s each"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = var.evaluation_periods
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = var.period_seconds
  statistic           = "Average"
  threshold           = var.memory_threshold_pct
  treat_missing_data  = "missing"

  dimensions = {
    ClusterName = var.cluster_name
    ServiceName = var.service_name
  }

  alarm_actions = [var.sns_topic_arn]
  ok_actions    = [var.sns_topic_arn]

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "webhook_dlq_depth_high" {
  count = var.webhook_dlq_queue_name == "" ? 0 : 1

  alarm_name          = "${var.cluster_name}-${var.service_name}-webhook-dlq-depth-high"
  alarm_description   = "Webhook DLQ visible messages >= ${var.webhook_dlq_depth_threshold}; manual inspection required"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = var.period_seconds
  statistic           = "Maximum"
  threshold           = var.webhook_dlq_depth_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = var.webhook_dlq_queue_name
  }

  alarm_actions = [var.sns_topic_arn]
  ok_actions    = [var.sns_topic_arn]

  tags = var.tags
}
