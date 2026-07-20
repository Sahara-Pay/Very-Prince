# ─────────────────────────────────────────────────────────────────────────────
# very-prince — Terraform remote state infrastructure
# ─────────────────────────────────────────────────────────────────────────────
#
# This root module provisions the AWS resources required to store and lock
# Terraform state safely for the very-prince project.
#
# Resources created:
#   - S3 bucket for Terraform state storage
#   - DynamoDB table for Terraform state locking
#
# Bootstrap workflow:
#   1. Comment out the S3 backend block in backend.tf for the very first run.
#   2. Run `terraform init` and `terraform apply` to create this bucket/table.
#   3. Uncomment the S3 backend block in backend.tf.
#   4. Run `terraform init -migrate-state` to move the local state into S3.
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ─── S3 Bucket for Terraform State ───────────────────────────────────────────

resource "aws_s3_bucket" "terraform_state" {
  bucket = var.state_bucket_name
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ─── DynamoDB Table for Terraform State Locking ──────────────────────────────

resource "aws_dynamodb_table" "terraform_locks" {
  name         = var.dynamodb_lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

# ──── Module Compositions ─────────────────────────────────────────────────────

module "ecs_cluster" {
  source = "./modules/ecs-cluster"
  name   = var.project_name

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

module "cloudwatch_logs" {
  source         = "./modules/cloudwatch-logs"
  name           = var.service_name
  retention_days = var.log_retention_days

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

module "sns_topics" {
  source          = "./modules/sns-topics"
  name            = "${var.project_name}-${var.environment}-critical-alerts"
  email_addresses = var.alert_email_addresses

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

module "ecs_service" {
  source             = "./modules/ecs-service"
  name               = var.service_name
  cluster_id         = module.ecs_cluster.cluster_id
  cluster_name       = module.ecs_cluster.cluster_name
  log_group_name     = module.cloudwatch_logs.log_group_name
  image_uri          = var.image_uri
  task_cpu           = var.task_cpu
  task_memory        = var.task_memory
  desired_count      = var.desired_count
  private_subnet_ids = var.private_subnet_ids
  service_sg_id      = var.service_sg_id
  target_group_arn   = var.target_group_arn
  aws_region         = var.aws_region

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

module "cloudwatch_alarms" {
  source               = "./modules/cloudwatch-alarms"
  cluster_name         = module.ecs_cluster.cluster_name
  service_name         = module.ecs_service.service_name
  sns_topic_arn        = module.sns_topics.topic_arn
  cpu_threshold_pct    = var.cpu_threshold_pct
  memory_threshold_pct = var.memory_threshold_pct
  evaluation_periods   = 2
  period_seconds       = 60

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

module "cloudwatch_dashboard" {
  source         = "./modules/cloudwatch-dashboard"
  dashboard_name = "${var.project_name}-${var.environment}-${var.service_name}"
  cluster_name   = module.ecs_cluster.cluster_name
  service_name   = module.ecs_service.service_name
  log_group_name = module.cloudwatch_logs.log_group_name
  region         = var.aws_region

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}
