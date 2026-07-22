# ──────────────────────────────────────────────────────────────────────────────
# Terraform & provider version pinning
# ──────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 4.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

# ──────────────────────────────────────────────────────────────────────────────
# IAM Role for Lambda execution
# ──────────────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name_prefix}-snapshot-prune-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-snapshot-prune-role"
  })
}

# ──────────────────────────────────────────────────────────────────────────────
# IAM policy for RDS snapshot pruning + CloudWatch Logs
# ──────────────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "lambda_policy" {
  statement {
    sid = "RDSDescribeSnapshots"
    actions = [
      "rds:DescribeDBSnapshots",
      "rds:DescribeDBClusterSnapshots"
    ]
    resources = ["*"]
  }

  statement {
    sid = "RDSDeleteSnapshots"
    actions = [
      "rds:DeleteDBSnapshot",
      "rds:DeleteDBClusterSnapshot"
    ]
    resources = ["*"]
  }

  statement {
    sid = "CloudWatchLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${var.name_prefix}-snapshot-prune-policy"
  role   = aws_iam_role.lambda.name
  policy = data.aws_iam_policy_document.lambda_policy.json
}

# Attach AWS-managed Lambda basic execution role for convenience (complements
# the custom inline policy above).
resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ──────────────────────────────────────────────────────────────────────────────
# Lambda deployment package (Python source → zip archive)
# ──────────────────────────────────────────────────────────────────────────────

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/."
  output_path = "${path.module}/prune_snapshots.zip"
  excludes    = ["prune_snapshots.zip", "*.tf", "*.tfvars", ".terraform"]
}

# ──────────────────────────────────────────────────────────────────────────────
# Lambda function — Python 3.11
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "prune" {
  function_name    = "${var.name_prefix}-prune-snapshots"
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  handler          = "prune_snapshots.lambda_handler"
  runtime          = "python3.11"
  timeout          = 60
  memory_size      = 128

  role = aws_iam_role.lambda.arn

  environment {
    variables = {
      RETENTION_DAYS = tostring(var.snapshot_retention_days)
    }
  }

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-prune-snapshots"
  })
}

# ──────────────────────────────────────────────────────────────────────────────
# EventBridge rule — schedule for snapshot pruning
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_event_rule" "prune_schedule" {
  name                = "${var.name_prefix}-prune-schedule"
  schedule_expression = var.schedule_expression

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-prune-schedule"
  })
}

resource "aws_cloudwatch_event_target" "prune" {
  rule = aws_cloudwatch_event_rule.prune_schedule.name
  arn  = aws_lambda_function.prune.arn
}

# ──────────────────────────────────────────────────────────────────────────────
# Lambda permission — allow EventBridge to invoke the function
# ──────────────────────────────────────────────────────────────────────────────

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.prune.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.prune_schedule.arn
}