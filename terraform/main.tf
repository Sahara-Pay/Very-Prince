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
      version = "~> 5.0"
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
