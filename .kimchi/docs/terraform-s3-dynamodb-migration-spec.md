# Terraform State Migration to S3 + DynamoDB Locking — Implementation Spec

## Objective
Finalize the migration of Terraform state management from local/implicit storage to an Amazon S3 backend with DynamoDB state locking, ensuring concurrent pipeline runs are serialized and state corruption is prevented. Update CI/CD and architecture documentation to reflect the backend and locking behavior.

## Current State
- `terraform/backend.tf` already declares an S3 backend referencing `very-prince-terraform-state` and `very-prince-terraform-locks`.
- `terraform/main.tf` already creates the S3 bucket (versioning, KMS SSE, public-access block) and DynamoDB table (`LockID` hash key, PAY_PER_REQUEST, point-in-time recovery, SSE).
- `terraform/main.tf` already requires Terraform `>= 1.5.0` and AWS provider `~> 4.0`.
- `Jenkinsfile` already uses declarative pipeline syntax and supports both Unix (`sh`) and native Windows (`bat`) agents without WSL.
- `docs/ARCHITECTURE.md` does not document the S3/DynamoDB state backend or the bootstrap/migration workflow.
- `scripts/terraform-setup.ps1` already supports native Windows Terraform installation.

## Gaps to Close
1. The backend block references resources created by the same module, so a bootstrap workflow is required; this must be documented and made repeatable.
2. Jenkins does not explicitly verify backend connectivity or assert that DynamoDB locking is active during execution.
3. Architecture documentation omits the state-management layer.

## Implementation Chunks

### Chunk 1: Terraform backend hardening and bootstrap helper (simple)
**Goal:** Make the S3 backend configuration production-ready and provide a repeatable bootstrap path for first-time setup.

**Files:**
- `terraform/backend.tf` — update backend block with additional stability/retry settings.
- `terraform/main.tf` — add outputs and optional bootstrap toggle; add `aws_s3_bucket_policy` to deny non-SSL and enforce least-privilege state access.
- `terraform/variables.tf` — add backend-related variables (`state_bucket_name`, `dynamodb_lock_table_name` already exist; add `enable_state_bucket_policy`, `state_lock_read_capacity`, `state_lock_write_capacity` optional overrides for compatibility).
- `scripts/bootstrap-terraform-backend.sh` — new bash script for Unix/WSL/Mac bootstrap.
- `scripts/bootstrap-terraform-backend.ps1` — new PowerShell script for native Windows bootstrap.

**Interfaces & behavior:**
1. `terraform/backend.tf`:
   - Keep `bucket`, `key`, `region`, `encrypt`, `dynamodb_table`.
   - Add `use_lockfile = false` (Terraform >= 1.5 honors this to avoid stale `.terraform.lock.hcl` confusion; set explicitly for documentation).
   - Add backend-optional block for workspace key prefix if needed in the future; do not enable workspaces unless requested.
2. `terraform/main.tf`:
   - Add `output "state_backend_type" { value = "s3" }`.
   - Add `output "state_locking_enabled" { value = true }`.
   - Add resource `aws_s3_bucket_policy.terraform_state` denying non-SSL transport (`aws:SecureTransport != true`).
3. `terraform/variables.tf`:
   - Add `variable "enable_state_bucket_policy"` boolean default `true`.
   - Add `variable "state_key"` string default `"infrastructure/terraform.tfstate"`.
4. `scripts/bootstrap-terraform-backend.sh`:
   - Runs from repo root.
   - Detects `terraform` CLI.
   - Temporarily comments/uncomments backend block or uses `terraform init -backend=false` to create bucket/table.
   - Runs `terraform init -migrate-state` after resources exist.
   - Idempotent: checks existing bucket/table before creation.
5. `scripts/bootstrap-terraform-backend.ps1`:
   - Same behavior as the bash script using PowerShell syntax.
   - Uses `terraform.exe`, Windows paths, and `Out-File` for in-place comment toggling.

**Acceptance criteria:**
- `terraform fmt -check` passes on all `.tf` files.
- `terraform validate` passes.
- Bucket policy resource denies insecure transport without breaking backend access.
- Bootstrap scripts are executable and contain `set -euo pipefail` (bash) / `$ErrorActionPreference = 'Stop'` (PowerShell).

### Chunk 2: Jenkins pipeline backend and lock verification (simple)
**Goal:** Extend the existing declarative pipeline so that `terraform init` explicitly targets the S3 backend and every run asserts that DynamoDB locking is functioning.

**Files:**
- `Jenkinsfile`

**Interfaces & behavior:**
1. Keep declarative syntax and the existing `isUnix()`/`bat` Windows branches.
2. In the `Init` stage:
   - Pass `-backend-config="bucket=${env.STATE_BUCKET_NAME ?: 'very-prince-terraform-state'}"` and `-backend-config="dynamodb_table=${env.DYNAMODB_LOCK_TABLE ?: 'very-prince-terraform-locks'}"` to `terraform init` (these values must match `terraform/backend.tf`).
   - Add `-input=false`.
3. Add a new `Verify Backend Lock` stage immediately after `Init`:
   - Run `terraform force-unlock -force <fake-lock-id>` against a non-existent lock ID. The expected behavior is that Terraform contacts DynamoDB and returns an error stating the lock does not exist (proving the backend + DynamoDB lock table are reachable).
   - Use `set +e` / `|| true` (Unix) and `exit 0` wrapper (Windows) so the intentional failure does not fail the build.
   - Parse the output for the string `"lock"` (case-insensitive) and fail the stage only if the word is NOT found.
4. Add environment variables:
   - `STATE_BUCKET_NAME = 'very-prince-terraform-state'`
   - `DYNAMODB_LOCK_TABLE = 'very-prince-terraform-locks'`
5. Keep native Windows `bat` support; no WSL requirement.

**Acceptance criteria:**
- `Jenkinsfile` remains valid declarative pipeline syntax.
- Both Unix and Windows branches contain backend config flags and lock verification.
- Lock verification stage intentionally exercises DynamoDB and passes only when Terraform reports a lock-related message.

### Chunk 3: Architecture documentation update (simple)
**Goal:** Document the S3/DynamoDB backend, locking semantics, bootstrap workflow, and Windows support in `docs/ARCHITECTURE.md`.

**Files:**
- `docs/ARCHITECTURE.md`

**Interfaces & behavior:**
1. Add a new top-level section `## Terraform State Management` after `## Overview`.
2. Include:
   - S3 bucket name, state key, region.
   - DynamoDB table name and `LockID` attribute.
   - Statement that concurrent `terraform apply` runs are serialized via DynamoDB locks.
   - Reference to `scripts/bootstrap-terraform-backend.sh` and `scripts/bootstrap-terraform-backend.ps1`.
   - Bootstrap steps enumerated.
3. Update the Mermaid diagram to show the S3 bucket and DynamoDB table as explicit backend resources.
4. Add a `### State Locking` subsection under `## Jenkins Pipeline` describing the `Verify Backend Lock` stage.

**Acceptance criteria:**
- All backend resource names match the Terraform variables/defaults.
- Bootstrap instructions are numbered and reproducible.
- Windows bootstrap is explicitly covered without WSL.

## Cross-Cutting Constraints
- Terraform version must remain `>= 1.5.0`.
- Jenkinsfile must remain declarative.
- Native Windows support must be preserved; WSL is not required.
- No new external dependencies beyond the HashiCorp AWS provider already in use.

## Verification Strategy
- `terraform fmt -recursive`
- `terraform validate`
- Jenkinsfile lint via `jenkins-cli` or online declarative validator (if unavailable, manual review).
- Reviewer checks that backend resource names and lock verification logic are consistent across Terraform, Jenkinsfile, and docs.
