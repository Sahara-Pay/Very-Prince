#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap-terraform-backend.sh
#
# Bootstraps the S3 + DynamoDB Terraform backend for the very-prince project
# on Linux/macOS/WSL. This script:
#
#   1. Verifies that the Terraform CLI is installed and AWS credentials work.
#   2. Verifies that the state bucket and DynamoDB lock table already exist.
#   3. Runs `terraform init -migrate-state` from the terraform/ directory.
#   4. Plans and applies with explicit `-lock=true` so DynamoDB enforces locks.
#
# If the bucket or table is missing, the script aborts with instructions to
# perform the first-time bootstrap by commenting out the backend block in
# terraform/backend.tf, running `terraform init -backend=false`, then
# `terraform apply` to provision the backend resources.
#
# Usage:
#   scripts/bootstrap-terraform-backend.sh                  # use defaults
#   STATE_BUCKET_NAME=my-bucket scripts/bootstrap-terraform-backend.sh
#
# Required environment:
#   AWS_REGION            (default: us-east-1)
#   STATE_BUCKET_NAME     (default: very-prince-terraform-state)
#   DYNAMODB_LOCK_TABLE   (default: very-prince-terraform-locks)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

usage() {
  sed -n '2,28p' "$0"
  exit "${1:-0}"
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage 0
fi

AWS_REGION="${AWS_REGION:-us-east-1}"
STATE_BUCKET_NAME="${STATE_BUCKET_NAME:-very-prince-terraform-state}"
DYNAMODB_LOCK_TABLE="${DYNAMODB_LOCK_TABLE:-very-prince-terraform-locks}"

# ─── Pre-flight checks ───────────────────────────────────────────────────────

if ! command -v terraform >/dev/null 2>&1; then
  echo "ERROR: terraform is not on PATH. Install Terraform >= 1.5 and retry." >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI is not on PATH. Install the AWS CLI and configure credentials." >&2
  exit 1
fi

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "ERROR: AWS credentials are not configured. Run 'aws configure' or set AWS_* env vars." >&2
  exit 1
fi

echo "→ Checking for S3 state bucket: ${STATE_BUCKET_NAME}"
if ! aws s3api head-bucket --bucket "${STATE_BUCKET_NAME}" --region "${AWS_REGION}" 2>/dev/null; then
  cat >&2 <<EOF
ERROR: S3 bucket '${STATE_BUCKET_NAME}' does not exist (or you lack s3:HeadBucket).

To bootstrap the backend for the first time:
  1. Comment out the backend "s3" { ... } block in terraform/backend.tf.
  2. From the terraform/ directory, run:
       terraform init -backend=false -input=false
       terraform apply -auto-approve -input=false
  3. Uncomment the backend block in terraform/backend.tf.
  4. Re-run this script.
EOF
  exit 1
fi

echo "→ Checking for DynamoDB lock table: ${DYNAMODB_LOCK_TABLE}"
if ! aws dynamodb describe-table --table-name "${DYNAMODB_LOCK_TABLE}" --region "${AWS_REGION}" >/dev/null 2>&1; then
  cat >&2 <<EOF
ERROR: DynamoDB table '${DYNAMODB_LOCK_TABLE}' does not exist (or you lack dynamodb:DescribeTable).

Provision it via Terraform during the first-time bootstrap described above.
EOF
  exit 1
fi

# ─── Migrate state into the S3 backend ───────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TERRAFORM_DIR="${REPO_ROOT}/terraform"

echo "→ Running: terraform init -migrate-state (from ${TERRAFORM_DIR})"
(
  cd "${TERRAFORM_DIR}"
  terraform init \
    -migrate-state \
    -input=false \
    -force-copy
)

echo "→ Running: terraform plan with DynamoDB locking enabled"
(
  cd "${TERRAFORM_DIR}"
  terraform plan \
    -lock=true \
    -lock-timeout=300s \
    -input=false \
    -out=tfplan
)

echo "→ Running: terraform apply with DynamoDB locking enabled"
(
  cd "${TERRAFORM_DIR}"
  terraform apply \
    -lock=true \
    -lock-timeout=300s \
    -input=false \
    -auto-approve \
    tfplan
)

echo "✓ Bootstrap complete. State is now stored in s3://${STATE_BUCKET_NAME}/${TERRAFORM_KEY:-infrastructure/terraform.tfstate}"
echo "✓ DynamoDB lock table '${DYNAMODB_LOCK_TABLE}' will serialize concurrent runs."
