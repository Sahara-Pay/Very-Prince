# Plan — Declarative AWS ECS Provisioning via Terraform

## Goal

Provision AWS ECS clusters and Fargate task definitions declaratively with strict Terraform modules, a Jenkins declarative pipeline, and Windows-compatible local CLI execution. Update architecture documentation.

## Constraints

- Terraform `>= 1.5.0` (already pinned in `terraform/main.tf`).
- AWS provider `~> 4.0` (already pinned).
- Jenkinsfile uses **declarative pipeline syntax only** (`pipeline { ... }` top-level, `agent`, `stages`, `post`). No scripted `node {}` blocks.
- Native Windows support: every command path in the Jenkinsfile and any docs must work on Windows PowerShell/cmd without WSL. `terraform.exe`, `aws.exe`, `docker.exe`, `trivy.exe` invoked via `bat`.
- Acceptance criteria: `terraform plan` applies without errors, Jenkins pipeline completes end-to-end, architecture docs updated.

## Current State (from exploration)

- `terraform/main.tf` already wires ECS, networking, logs, alarms, dashboard, SNS, CDN modules.
- `terraform/modules/ecs-cluster/` (cluster + capacity providers) — exists, simple, no IAM.
- `terraform/modules/ecs-service/` — has task definition + service + IAM roles baked together; mixes concerns.
- `terraform/modules/fargate-task/` — strict, validated, standalone task definition module; **not referenced** from `main.tf`.
- `Jenkinsfile` is already **declarative** (`pipeline { ... }`) but uses `script {}` blocks with `isUnix()` for Windows branching.
- `docs/ARCHITECTURE.md` has an ECS Service subheading that is sparsely populated.

## Chunks

### Chunk 1 — Strict ECS cluster module

**Files changed:**
- `terraform/modules/ecs-cluster/main.tf`
- `terraform/modules/ecs-cluster/variables.tf`
- `terraform/modules/ecs-cluster/outputs.tf`
- `terraform/modules/ecs-cluster/README.md`

**Goal:** Make the ECS cluster module strict, validated, and self-contained (cluster + capacity providers).

**Accept when:**
- `terraform validate` on the module passes.
- Module exposes `cluster_id`, `cluster_name`, `cluster_arn`.
- Input validation on `name` (non-empty, ≤255 chars) and `tags` (map).
- Output `cluster_arn` is documented.

**Test coverage:** `terraform validate` in `terraform/`.

---

### Chunk 2 — Promote `fargate-task` module and wire into root

**Files changed:**
- `terraform/modules/fargate-task/main.tf` (no functional change — already strict)
- `terraform/main.tf` (reference `fargate-task` for the task definition portion OR keep `ecs-service` as the orchestrator and pass its task definition through; verify on build)
- `terraform/modules/fargate-task/README.md` (new)

**Goal:** Ensure the strict, validated `fargate-task` module is the authoritative task definition surface. Either:
(a) `ecs-service` module uses the strict `fargate-task` module internally for its `aws_ecs_task_definition`, OR
(b) root module wires `fargate-task` directly.

**Decision:** Take option (a) — `ecs-service` calls `fargate-task` so existing wiring in `main.tf` stays intact. This keeps `main.tf` stable while making the task definition surface strict and validated.

**Accept when:**
- `ecs-service` references `module "fargate-task"` for its `aws_ecs_task_definition` resource.
- `terraform validate` passes.
- Module's `container_definitions` are passed via `jsonencode()` with environment injection point.

**Test coverage:** `terraform validate`.

---

### Chunk 3 — Jenkinsfile: declarative pipeline, Windows-native

**Files changed:**
- `Jenkinsfile`

**Goal:** Convert the Jenkinsfile to a fully declarative pipeline. Eliminate `script {}` blocks by using declarative-native features:
- `tools { terraform '...' }` for Terraform CLI version.
- `withCredentials([...])` for AWS creds.
- `agent { label 'terraform' }` — already present.
- Single `sh`/`bat` decision via `agent { label ... }` matching, OR keep `isUnix()` inside a single declarative `steps` block (declarative pipelines allow `script {}` but we want minimal use). Approach: use a `when { expression { return isUnix() } }` style is not ideal; instead, define two parallel agents or use the cleaner pattern of an outer `script` only where unavoidable. Per the user's requirement ("declarative pipeline syntax"), we keep the file in `pipeline { ... }` form and remove unnecessary `script {}` wrappers around plain command invocations by using `sh`/`bat` steps conditionally with a `script` only when strictly needed (e.g. environment interpolation).

**Accept when:**
- Top-level is `pipeline { ... }` (declarative).
- No `node {}` scripted blocks.
- All stages work on Windows agents via `bat` and on Unix agents via `sh`.
- Stages: Checkout, Setup, Build, Scan, Init, Validate, Plan, Apply (main + manual input).
- `TF_VERSION` exposed via `tools { terraform }` or environment.

**Test coverage:** Manual lint — file parses as Groovy declarative.

---

### Chunk 4 — Architecture documentation update

**Files changed:**
- `docs/ARCHITECTURE.md`

**Goal:** Add an ECS / Fargate section describing the declarative modules, the strict `fargate-task` module, and the pipeline.

**Accept when:**
- Section titled `### ECS Cluster (terraform/modules/ecs-cluster/)` exists and describes inputs/outputs.
- Section titled `### Fargate Task Definition (terraform/modules/fargate-task/)` exists and lists validations.
- Section titled `### Jenkins Pipeline` explains stages and Windows compatibility.
- Renders as valid Markdown.

**Test coverage:** Visual / Markdown lint.

---

## Verification Strategy

1. From `terraform/`: `terraform init -backend=false` then `terraform validate` — must pass with zero errors.
2. `terraform plan -input=false -lock=false` — must produce a plan (state may be absent; we only check that `validate` and `plan` succeed).
3. `Jenkinsfile` Groovy syntax: `curl -fsSL ... jenkins-cli` not available offline; instead, run a simple `groovy -e "new File('Jenkinsfile').text"` if Groovy is installed, or visually verify the structure.
4. `docs/ARCHITECTURE.md` updated sections read coherently.

## Decision Log

- **Decision:** Keep `ecs-service` as the orchestrator module and have it call `fargate-task` internally. **Rejected:** Splitting `ecs-service` further into separate task / service modules — adds churn for no gain.
- **Decision:** Keep the `isUnix()` branching inside `script {}` blocks in the Jenkinsfile where dynamic interpolation is required. **Rejected:** Pure declarative `when` expressions — they cannot branch on shell type and would require duplicate stages.
- **Decision:** Do not bump AWS provider from `~> 4.0` to `~> 5.0`. **Rejected:** Out of scope for this task; user didn't request it.
- **Decision:** Do not change the existing Jenkinsfile's pipeline shape (declarative) — only refine and document. The existing file is already declarative.

## Risks

- `terraform plan` against real AWS requires credentials. We verify with `terraform validate` only and document a credentials requirement.
- `terraform init` will try to reach S3; we skip backend config with `-backend=false` for validation.
- The `fargate-task` module is referenced by `ecs-service` only after we wire it; root `main.tf` does not need to change.

## Open Questions

None — proceeding with the above.
