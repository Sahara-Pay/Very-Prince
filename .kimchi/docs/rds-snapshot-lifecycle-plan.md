# Plan: Automated RDS Snapshot Lifecycle Rules via Terraform

## Objective
Wire the existing `terraform/modules/rds-snapshot-lifecycle` module into the root Terraform configuration, expose backup-window and retention-period settings as code, and document the architecture so orphaned RDS snapshots are pruned automatically.

## Context from Exploration
- `terraform/modules/rds-snapshot-lifecycle/` already contains a Lambda + EventBridge module that deletes manual RDS DB and DB cluster snapshots older than `snapshot_retention_days`.
- The root module `terraform/main.tf` does **not** currently call this module, so the pruning infrastructure is not deployed.
- `terraform/modules/rds-snapshot-lifecycle/variables.tf` defines `preferred_backup_window`, but the value is not consumed inside the module.
- `Jenkinsfile.rds-snapshot-lifecycle` already provides a declarative, cross-platform (Windows `bat` / Unix `sh`) pipeline that targets `module.rds_snapshot_lifecycle`.
- `scripts/terraform-setup.ps1` provides native Windows Terraform installation without WSL.
- `docs/ARCHITECTURE.md` has no RDS snapshot lifecycle section.

## Acceptance Criteria Mapping

| Acceptance Criterion | Implementation |
|---|---|
| Backup windows and retention periods are defined as code | Root variables `rds_snapshot_retention_days` and `rds_backup_window` feed the module; values can be overridden in `terraform.tfvars`. |
| Old snapshots are purged dynamically | EventBridge schedule invokes the Lambda; the Lambda deletes manual snapshots older than the retention period. |
| Architecture documentation is updated | `docs/ARCHITECTURE.md` gains an RDS Snapshot Lifecycle section and an updated diagram. |
| Terraform >= 1.5 | Module adds `required_version = ">= 1.5.0"`. |
| Native Windows Terraform CLI support | No change needed; existing Jenkinsfile uses `bat` / `terraform.exe` and `scripts/terraform-setup.ps1` is already present. |

## Chunks

### Chunk 1 — Wire the RDS snapshot lifecycle module into the root Terraform stack
**Complexity:** simple  
**Files touched:**
- `terraform/main.tf`
- `terraform/variables.tf`
- `terraform/terraform.tfvars.example`
- `terraform/modules/rds-snapshot-lifecycle/main.tf`

**Changes:**
1. In `terraform/main.tf`, add a `module "rds_snapshot_lifecycle"` block after `module "asset_cdn"`:
   - `source = "./modules/rds-snapshot-lifecycle"`
   - `name_prefix = "${var.project_name}-${var.environment}"`
   - `snapshot_retention_days = var.rds_snapshot_retention_days`
   - `preferred_backup_window = var.rds_backup_window`
   - `schedule_expression = var.rds_snapshot_prune_schedule`
   - `tags = { Project = var.project_name, Environment = var.environment, ManagedBy = "terraform" }`
2. In `terraform/variables.tf`, append three new variables:
   - `rds_snapshot_retention_days` (number, default `7`)
   - `rds_backup_window` (string, default `"03:00-04:00"`, validation regex `^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$`)
   - `rds_snapshot_prune_schedule` (string, default `"rate(1 day)"`, validation that it starts with `rate(` or `cron(`)
3. In `terraform/terraform.tfvars.example`, add commented examples for the three new variables.
4. In `terraform/modules/rds-snapshot-lifecycle/main.tf`, add a `terraform` block at the top with `required_version = ">= 1.5.0"`.

**Acceptance criteria for Chunk 1:**
- `terraform fmt -recursive` returns no formatting changes.
- `terraform validate` in both `terraform/` and `terraform/modules/rds-snapshot-lifecycle/` succeeds.
- `terraform plan` from `terraform/` shows the creation of the Lambda, IAM role, EventBridge rule, and EventBridge target for `module.rds_snapshot_lifecycle`.

### Chunk 2 — Update architecture documentation
**Complexity:** simple  
**Files touched:**
- `docs/ARCHITECTURE.md`

**Changes:**
1. Add a new top-level section `## RDS Snapshot Lifecycle (terraform/modules/rds-snapshot-lifecycle/)` between `## Components` and `## Data Flow` (or adjacent to other component sections) that describes:
   - Purpose: prune orphaned manual RDS DB and DB cluster snapshots after the configured retention period to reduce storage cost.
   - Trigger: EventBridge rule on `schedule_expression`.
   - Compute: Python 3.11 Lambda with least-privilege IAM permissions (`rds:DescribeDBSnapshots`, `rds:DescribeDBClusterSnapshots`, `rds:DeleteDBSnapshot`, `rds:DeleteDBClusterSnapshot`, CloudWatch Logs).
   - Configuration as code: `snapshot_retention_days`, `preferred_backup_window`, `schedule_expression`.
2. Update the Mermaid diagram in the `## Overview` section to include the EventBridge rule, Lambda, and manual RDS snapshots.
3. Add a small `## Jenkinsfile — RDS Snapshot Lifecycle` subsection under the existing `## Jenkins Pipeline` section, noting:
   - Declarative syntax.
   - Stages: Setup → Format Check → Init → Validate Module → Plan → Apply (gated to `main`).
   - Cross-platform `bat`/`sh` support without WSL.
4. Add the new Lambda function name and EventBridge rule name to the `## Operations` reference list.

**Acceptance criteria for Chunk 2:**
- `docs/ARCHITECTURE.md` renders correctly as Markdown.
- The new section explicitly mentions retention days, backup window, and pruning schedule.
- The diagram includes the new components.

## Verification Strategy
- `terraform fmt -recursive`.
- `terraform validate` in module and root directories.
- `terraform plan` in root directory (dry-run; may require AWS credentials or `-input=false` with mocked/commented values).
- Markdown render check for `docs/ARCHITECTURE.md`.

## Notes
- The `preferred_backup_window` variable is kept as a code-defined operational parameter even though the current module does not provision RDS instances. It documents the intended backup window so pruning can be scheduled outside it.
- No new Jenkinsfile is required; the existing `Jenkinsfile.rds-snapshot-lifecycle` already satisfies declarative syntax and Windows support.
- No new tests are added because the repository has no Terraform testing framework; validation is performed by Terraform itself and the Jenkins pipeline.
