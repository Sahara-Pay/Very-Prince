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

# ─── S3 Bucket Policy: enforce SSL-only access to state ──────────────────────

resource "aws_s3_bucket_policy" "terraform_state" {
  count = var.enable_state_bucket_policy ? 1 : 0

  bucket = aws_s3_bucket.terraform_state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.terraform_state.arn,
          "${aws_s3_bucket.terraform_state.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.terraform_state]
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

module "networking" {
  source = "./modules/networking"

  name                 = var.project_name
  vpc_cidr             = var.vpc_cidr
  availability_zones   = var.availability_zones
  private_subnet_cidrs = var.private_subnet_cidrs
  public_subnet_cidrs  = var.public_subnet_cidrs
  enable_nat_gateway   = var.enable_nat_gateway
  container_port       = var.container_port
  health_check_path    = var.health_check_path

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

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

module "webhook_queue" {
  source = "./modules/sqs-webhook-queue"

  name                       = "${var.project_name}-${var.environment}-webhook-dispatch"
  visibility_timeout_seconds = var.webhook_queue_visibility_timeout_seconds
  max_receive_count          = var.webhook_queue_max_receive_count

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
  log_group_arn      = module.cloudwatch_logs.log_group_arn
  image_uri          = var.image_uri
  task_cpu           = var.task_cpu
  task_memory        = var.task_memory
  desired_count      = var.desired_count
  private_subnet_ids = module.networking.private_subnet_ids
  service_sg_id      = module.networking.ecs_tasks_security_group_id
  target_group_arn   = module.networking.target_group_arn
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

module "asset_cdn" {
  source = "./modules/asset-cdn"

  name              = "${var.project_name}-${var.environment}-assets"
  asset_bucket_name = var.asset_bucket_name
  price_class       = var.cloudfront_price_class

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# ──── RDS Snapshot Lifecycle ────────────────────────────────────────────────

module "rds_snapshot_lifecycle" {
  source = "./modules/rds-snapshot-lifecycle"

  name_prefix             = "${var.project_name}-${var.environment}"
  snapshot_retention_days = var.rds_snapshot_retention_days
  preferred_backup_window = var.rds_backup_window
  schedule_expression     = var.rds_snapshot_prune_schedule

  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
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

# ─── S3 Bucket Policy: enforce SSL-only access to state ──────────────────────

resource "aws_s3_bucket_policy" "terraform_state" {
  count = var.enable_state_bucket_policy ? 1 : 0

  bucket = aws_s3_bucket.terraform_state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.terraform_state.arn,
          "${aws_s3_bucket.terraform_state.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.terraform_state]
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

module "networking" {
  source = "./modules/networking"

  name                 = var.project_name
  vpc_cidr             = var.vpc_cidr
  availability_zones   = var.availability_zones
  private_subnet_cidrs = var.private_subnet_cidrs
  public_subnet_cidrs  = var.public_subnet_cidrs
  enable_nat_gateway   = var.enable_nat_gateway
  container_port       = var.container_port
  health_check_path    = var.health_check_path

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

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
  private_subnet_ids = module.networking.private_subnet_ids
  service_sg_id      = module.networking.ecs_tasks_security_group_id
  target_group_arn   = module.networking.target_group_arn
  aws_region         = var.aws_region
  source                                   = "./modules/ecs-service"
  name                                     = var.service_name
  cluster_id                               = module.ecs_cluster.cluster_id
  cluster_name                             = module.ecs_cluster.cluster_name
  log_group_name                           = module.cloudwatch_logs.log_group_name
  image_uri                                = var.image_uri
  task_cpu                                 = var.task_cpu
  task_memory                              = var.task_memory
  desired_count                            = var.desired_count
  private_subnet_ids                       = module.networking.private_subnet_ids
  service_sg_id                            = module.networking.ecs_tasks_security_group_id
  target_group_arn                         = module.networking.target_group_arn
  aws_region                               = var.aws_region
  webhook_queue_arn                        = module.webhook_queue.queue_arn
  webhook_queue_url                        = module.webhook_queue.queue_url
  webhook_dlq_arn                          = module.webhook_queue.dlq_arn
  webhook_dlq_url                          = module.webhook_queue.dlq_url
  webhook_queue_max_receive_count          = var.webhook_queue_max_receive_count
  webhook_queue_visibility_timeout_seconds = var.webhook_queue_visibility_timeout_seconds

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

module "cloudwatch_alarms" {
  source                      = "./modules/cloudwatch-alarms"
  cluster_name                = module.ecs_cluster.cluster_name
  service_name                = module.ecs_service.service_name
  sns_topic_arn               = module.sns_topics.topic_arn
  cpu_threshold_pct           = var.cpu_threshold_pct
  memory_threshold_pct        = var.memory_threshold_pct
  evaluation_periods          = 2
  period_seconds              = 60
  webhook_dlq_queue_name      = module.webhook_queue.dlq_name
  webhook_dlq_depth_threshold = var.webhook_dlq_depth_threshold

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

module "asset_cdn" {
  source = "./modules/asset-cdn"

  name              = "${var.project_name}-${var.environment}-assets"
  asset_bucket_name = var.asset_bucket_name
  price_class       = var.cloudfront_price_class

  tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# ──── RDS Snapshot Lifecycle ────────────────────────────────────────────────

module "rds_snapshot_lifecycle" {
  source = "./modules/rds-snapshot-lifecycle"

  name_prefix             = "${var.project_name}-${var.environment}"
  snapshot_retention_days = var.rds_snapshot_retention_days
  preferred_backup_window = var.rds_backup_window
  schedule_expression     = var.rds_snapshot_prune_schedule

  tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}
