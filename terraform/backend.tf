# ─────────────────────────────────────────────────────────────────────────────
# Terraform remote backend configuration
# ─────────────────────────────────────────────────────────────────────────────
#
# This backend stores state in S3 and uses DynamoDB to enforce locks.
# Locks prevent concurrent Terraform runs from mutating infrastructure state
# at the same time, which can cause corruption or conflicting changes.
#
# IMPORTANT: The bucket and DynamoDB table referenced below are created by
# this same module (see main.tf). During the very first bootstrap run, the
# backend block must be commented out so Terraform can create these resources
# using a local state file. After the resources exist, uncomment this block and
# run `terraform init -migrate-state` to move state into S3.
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  backend "s3" {
    bucket         = "very-prince-terraform-state"
    key            = "infrastructure/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "very-prince-terraform-locks"
  }
}
