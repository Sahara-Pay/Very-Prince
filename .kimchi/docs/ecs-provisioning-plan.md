# Plan: Declarative AWS ECS Provisioning via Terraform

## Objective
Ensure the existing Terraform workspace provisions an ECS Fargate cluster and service without `terraform plan` errors, the declarative Jenkins pipeline completes on both Linux and native Windows agents, and the architecture documentation reflects the final module design.

## Current State
- `terraform/modules/ecs-cluster/` exists and is valid.
- `terraform/modules/fargate-task/` exists and is strictly validated.
- `terraform/modules/ecs-service/` references `aws_iam_role.execution` and `aws_iam_role.task` but **does not define these resources**, causing `terraform plan` to fail.
- `Jenkinsfile` already uses declarative syntax and branches between `sh` (Unix) and `bat` (Windows).
- Native Windows helper scripts exist (`scripts/terraform-setup.ps1`, `scripts/bootstrap-terraform-backend.ps1`).
- `docs/ARCHITECTURE.md` already documents most components but omits the IAM role model used by the ECS service.

## Implementation Chunks

### Chunk 1 — Add IAM roles to `terraform/modules/ecs-service/`
**Complexity:** simple (IAM policy documents and role attachments; no concurrency or algorithms)
**Files:**
- `terraform/modules/ecs-service/main.tf` (modify)
- `terraform/modules/ecs-service/outputs.tf` (modify)

**Work:**
1. Define a Fargate task execution IAM role (`aws_iam_role.execution`) with a trust policy for `ecs-tasks.amazonaws.com`.
2. Attach the AWS managed policy `arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy` to the execution role.
3. Define an optional application task IAM role (`aws_iam_role.task`) with a trust policy for `ecs-tasks.amazonaws.com`. Keep it minimal: attach no managed policies by default, and output its ARN so callers can add policies outside the module. (This satisfies the existing `task_role_arn = aws_iam_role.task.arn` reference.)
4. Add outputs for both role ARNs and names.

**Acceptance criteria:**
- `terraform validate` passes from the `terraform/` directory.
- `terraform plan` no longer reports "Reference to undeclared resource" for `aws_iam_role.execution` or `aws_iam_role.task`.
- `terraform plan` succeeds in mock mode (no AWS credentials required) for the module via `terraform plan -target=module.ecs_service` or equivalent scoped validation.

### Chunk 2 — Validate root module and Jenkins pipeline surface
**Complexity:** simple
**Files:**
- `Jenkinsfile` (read-only verification; modify only if WSL-specific commands are found)

**Work:**
1. Confirm `Jenkinsfile` uses only declarative pipeline syntax and branches between `sh`/`bat` via `isUnix()`.
2. Confirm no WSL-specific paths or commands exist in `Jenkinsfile` or the Terraform scripts.
3. Run `terraform fmt -check -recursive` from the repository root.

**Acceptance criteria:**
- `terraform fmt -check -recursive` reports no formatting issues.
- No WSL-specific dependencies are present in the Jenkins pipeline or Terraform wrapper scripts.

### Chunk 3 — Update architecture documentation
**Complexity:** simple
**Files:**
- `docs/ARCHITECTURE.md` (modify)

**Work:**
1. Add an "IAM Roles" subsection under the ECS Service section describing the execution role (CloudWatch Logs + ECR pull) and the task role (application-level, minimal by default).
2. Update the component table if necessary to list the new IAM resources.
3. Keep the existing Windows Support section and confirm native CLI execution without WSL.

**Acceptance criteria:**
- Documentation accurately describes the IAM roles created by `terraform/modules/ecs-service/`.
- No references to WSL as a requirement remain.

## Test Strategy
- Run `terraform fmt -check -recursive` for style validation.
- Run `terraform validate` in the root `terraform/` directory.
- Run `terraform plan` with a mocked/invalid backend to verify plan-time evaluation (no undeclared resource errors). Because AWS credentials are not available in this environment, the plan is expected to fail on AWS API access, not on configuration errors.
- Verify the Jenkinsfile is syntactically declarative and platform-agnostic.

## Windows Support Notes
- All Terraform commands use `terraform.exe` on Windows agents.
- No WSL, bash-for-Windows, or Linux-path assumptions are introduced.
- Helper scripts `scripts/terraform-setup.ps1` and `scripts/bootstrap-terraform-backend.ps1` remain the canonical Windows bootstrap path.
