data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  # var.image_uri is "<registry-host>/<repo-name>[:tag]"; strip the host and
  # tag to recover the bare repository name so the ECR pull permissions below
  # can be scoped to that single repository instead of "*".
  ecr_repository_and_tag = join("/", slice(split("/", var.image_uri), 1, length(split("/", var.image_uri))))
  ecr_repository_name    = split(":", local.ecr_repository_and_tag)[0]
  ecr_repository_arn     = "arn:aws:ecr:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:repository/${local.ecr_repository_name}"
}

data "aws_iam_policy_document" "execution_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "task_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "execution_policy" {
  statement {
    sid = "CloudWatchLogsWrite"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["${var.log_group_arn}:*"]
  }
  statement {
    # ecr:GetAuthorizationToken is an account-level action and does not
    # support resource-level permissions; AWS requires resources = ["*"].
    sid       = "ECRAuthToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "ECRImagePull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage"
    ]
    resources = [local.ecr_repository_arn]
  }
}

data "aws_iam_policy_document" "task_policy" {
  dynamic "statement" {
    for_each = var.webhook_queue_arn == "" ? [] : [var.webhook_queue_arn]

    content {
      sid = "WebhookQueueWorker"
      actions = [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
        "sqs:SendMessage",
      ]
      resources = [statement.value]
    }
  }

  dynamic "statement" {
    for_each = var.webhook_dlq_arn == "" ? [] : [var.webhook_dlq_arn]

    content {
      sid = "WebhookDlqWrite"
      actions = [
        "sqs:GetQueueAttributes",
        "sqs:SendMessage",
      ]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution-role"
  assume_role_policy = data.aws_iam_policy_document.execution_assume_role.json

  inline_policy {
    name   = "execution-policy"
    policy = data.aws_iam_policy_document.execution_policy.json
  }
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task-role"
  assume_role_policy = data.aws_iam_policy_document.task_assume_role.json

  inline_policy {
    name   = "task-policy"
    policy = data.aws_iam_policy_document.task_policy.json
  }
}
