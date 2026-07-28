# Spec: Declarative AWS ECS Provisioning via Terraform

## Goal
Finalize declarative Terraform modules that provision an AWS ECS cluster and strict Fargate task definitions, ensure the Jenkins declarative pipeline runs end-to-end on both Unix and native Windows agents, and update the architecture documentation.

## Constraints
- Terraform >= 1.5 (already declared in root module).
- AWS provider ~> 4.0 (already pinned in `.terraform.lock.hcl`).
- Jenkinsfile must remain declarative and must not require WSL on Windows agents.
- All existing resource names, tags, and outputs must remain backward-compatible.

## Chunks

### Chunk A — Harden ECS Terraform modules and root wiring
**Complexity:** simple  
**Files:**
- `terraform/modules/ecs-cluster/main.tf`
- `terraform/modules/ecs-cluster/variables.tf`
- `terraform/modules/ecs-cluster/outputs.tf`
- `terraform/modules/ecs-cluster/README.md` (new)
- `terraform/modules/fargate-task/README.md` (update/complete)
- `terraform/modules/ecs-service/main.tf`
- `terraform/modules/ecs-service/variables.tf`
- `terraform/modules/ecs-service/outputs.tf`
- `terraform/modules/ecs-service/README.md` (new)
- `terraform/main.tf` (minor wiring / tagging only)
- `terraform/variables.tf` (only if a missing variable is discovered)
- `terraform/terraform.tfvars.example` (only if a missing variable is discovered)

**Expected behaviour:**
1. `ecs-cluster` module must create an `aws_ecs_cluster` with Container Insights enabled, capacity providers `FARGATE` and `FARGATE_SPOT`, and a `default_capacity_provider_strategy` that uses `FARGATE` as base/weight 1. Inputs `name` and `tags` are validated. Outputs expose `cluster_id`, `cluster_name`, and `cluster_arn`.
2. `fargate-task` module must create an `aws_ecs_task_definition` that is strictly Fargate-only: `network_mode = "awsvpc"`, `requires_compatibilities = ["FARGATE"]`, validated `cpu`/`memory`/`operating_system_family`/`cpu_architecture`. It must accept `execution_role_arn` and optional `task_role_arn`.
3. `ecs-service` module must compose a JSON container definition (using `jsonencode`) with `awslogs` log driver, port mappings, and environment support. It must call `fargate-task` as a child module and create an `aws_ecs_service` with circuit breaker/rollback enabled, private subnet placement, optional ALB target group attachment, and desired count.
4. Root `main.tf` must continue to compose `networking`, `ecs_cluster`, `cloudwatch_logs`, `ecs_service`, `cloudwatch_alarms`, `cloudwatch_dashboard`, `sns_topics`, and `asset_cdn`. No resource name changes.
5. Add `README.md` files for `ecs-cluster` and `ecs-service` matching the style of `modules/fargate-task/README.md` and `modules/networking/README.md`.
6. If validation reveals gaps (e.g., missing description on an output, missing variable validation), fill them without changing semantics.

**Acceptance criteria:**
- `terraform -chdir=terraform validate` returns no errors.
- `terraform -chdir=terraform plan` can run to completion (it may fail for missing AWS credentials or state, but must not error on HCL/module issues).
- All three ECS modules have READMEs with inputs/outputs tables.

---

### Chunk B — Jenkins declarative pipeline and native Windows support
**Complexity:** simple  
**Files:**
- `Jenkinsfile` (update/verify)
- `scripts/bootstrap-terraform-backend.ps1` (ensure exists and matches `bootstrap-terraform-backend.sh`)
- `scripts/terraform-setup.ps1` (ensure exists and provides native Windows install path)

**Expected behaviour:**
1. `Jenkinsfile` must use declarative pipeline syntax with `pipeline { ... }`, stages, environment block, options, and post block.
2. It must detect the OS via `isUnix()` and use `sh` on Unix agents and `bat` on Windows agents for all shell steps (terraform, docker, trivy).
3. It must pass `-backend-config` flags explicitly in `Init`, run `Validate`, `Plan` with `-out=tfplan`, and `Apply` on `main` with manual input.
4. It must include the `Verify Backend Lock` stage that asserts DynamoDB locking is reachable from the agent.
5. `scripts/terraform-setup.ps1` must install Terraform on native Windows (Chocolatey, Scoop, or direct zip) without requiring WSL.
6. `scripts/bootstrap-terraform-backend.ps1` must mirror the shell bootstrap script: verify S3 bucket and DynamoDB table exist, then run `terraform init -migrate-state -input=false -force-copy` and a plan/apply cycle with locking.

**Acceptance criteria:**
- `Jenkinsfile` parses as valid declarative pipeline syntax.
- PowerShell scripts parse without syntax errors (`powershell -Command "Get-Command ..."` or similar offline check).
- No WSL-specific commands appear in any script or pipeline step.

---

### Chunk C — Architecture documentation update
**Complexity:** simple  
**Files:**
- `docs/ARCHITECTURE.md`

**Expected behaviour:**
1. Add or update sections that describe the strict `ecs-cluster`, `fargate-task`, and `ecs-service` modules.
2. Document the Fargate task definition validation (cpu/memory/network_mode/OS family/architecture).
3. Document the Jenkins pipeline stages and the native Windows support path.
4. Keep the Mermaid diagram and state-management sections in sync with the actual code.
5. Ensure no WSL dependency is implied for local Terraform CLI usage.

**Acceptance criteria:**
- `docs/ARCHITECTURE.md` references all three ECS modules.
- Documentation matches the current `Jenkinsfile`, root module, and module interfaces.
- A reviewer can read the doc and understand how to run `terraform plan` on Windows without WSL.

---

## Verification
After all chunks are built, a Reviewer agent must:
1. Run `terraform -chdir=terraform validate`.
2. Run `terraform -chdir=terraform plan` (or at least syntax check if AWS credentials are unavailable).
3. Verify `Jenkinsfile` declarative syntax and Windows paths.
4. Verify `docs/ARCHITECTURE.md` covers the new/updated modules.
