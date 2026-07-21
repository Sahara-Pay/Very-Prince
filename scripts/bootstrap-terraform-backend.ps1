# ─────────────────────────────────────────────────────────────────────────────
# bootstrap-terraform-backend.ps1
#
# Bootstraps the S3 + DynamoDB Terraform backend for the very-prince project
# on native Windows (no WSL required). Mirrors scripts/bootstrap-terraform-backend.sh.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap-terraform-backend.ps1
#
# Parameters:
#   -Region              AWS region (default: us-east-1)
#   -StateBucketName     S3 bucket for state (default: very-prince-terraform-state)
#   -DynamoDbLockTable   DynamoDB lock table (default: very-prince-terraform-locks)
# ─────────────────────────────────────────────────────────────────────────────

#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$Region = 'us-east-1',
    [string]$StateBucketName = 'very-prince-terraform-state',
    [string]$DynamoDbLockTable = 'very-prince-terraform-locks',
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

function Show-Usage {
    Get-Content -Path $PSCommandPath | Select-Object -First 22 | ForEach-Object { Write-Output $_ }
    exit 0
}

if ($Help) { Show-Usage }

# ─── Pre-flight checks ───────────────────────────────────────────────────────

if (-not (Get-Command terraform.exe -ErrorAction SilentlyContinue)) {
    Write-Error "ERROR: terraform.exe is not on PATH. Install Terraform >= 1.5 and retry."
    exit 1
}

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    Write-Error "ERROR: aws CLI is not on PATH. Install the AWS CLI and configure credentials."
    exit 1
}

try {
    aws sts get-caller-identity | Out-Null
} catch {
    Write-Error "ERROR: AWS credentials are not configured. Run 'aws configure' or set AWS_* env vars."
    exit 1
}

Write-Host "→ Checking for S3 state bucket: $StateBucketName"
try {
    aws s3api head-bucket --bucket $StateBucketName --region $Region | Out-Null
} catch {
    Write-Error @"
ERROR: S3 bucket '$StateBucketName' does not exist (or you lack s3:HeadBucket).

To bootstrap the backend for the first time:
  1. Comment out the backend "s3" { ... } block in terraform/backend.tf.
  2. From the terraform/ directory, run:
       terraform.exe init -backend=false -input=false
       terraform.exe apply -auto-approve -input=false
  3. Uncomment the backend block in terraform/backend.tf.
  4. Re-run this script.
"@
    exit 1
}

Write-Host "→ Checking for DynamoDB lock table: $DynamoDbLockTable"
try {
    aws dynamodb describe-table --table-name $DynamoDbLockTable --region $Region | Out-Null
} catch {
    Write-Error @"
ERROR: DynamoDB table '$DynamoDbLockTable' does not exist (or you lack dynamodb:DescribeTable).

Provision it via Terraform during the first-time bootstrap described above.
"@
    exit 1
}

# ─── Migrate state into the S3 backend ───────────────────────────────────────

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir '..')
$TerraformDir = Join-Path $RepoRoot 'terraform'

Push-Location -Path $TerraformDir
try {
    Write-Host "→ Running: terraform.exe init -migrate-state"
    terraform.exe init -migrate-state -input=false -force-copy

    Write-Host "→ Running: terraform.exe plan with DynamoDB locking enabled"
    terraform.exe plan -lock=true -lock-timeout=300s -input=false -out=tfplan

    Write-Host "→ Running: terraform.exe apply with DynamoDB locking enabled"
    terraform.exe apply -lock=true -lock-timeout=300s -input=false -auto-approve tfplan
} finally {
    Pop-Location
}

Write-Host "✓ Bootstrap complete. State is now stored in s3://$StateBucketName/infrastructure/terraform.tfstate"
Write-Host "✓ DynamoDB lock table '$DynamoDbLockTable' will serialize concurrent runs."
