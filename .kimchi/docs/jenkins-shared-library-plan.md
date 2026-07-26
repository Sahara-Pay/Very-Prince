# Plan: Jenkins Shared Library for Reusable CI/CD Pipeline Steps

## Objective
Abstract the repetitive Groovy build/deploy logic duplicated across `Jenkinsfile` and `Jenkinsfile.rds-snapshot-lifecycle` into a version-controlled shared library of callable functions, keep both pipelines declarative, preserve Terraform `>= 1.5` compatibility and native-Windows (no WSL) support, update architecture documentation, and account for a dedicated Jenkins shared-library repository.

## Context from Exploration
- Only two Jenkins pipeline files exist in the repo: `Jenkinsfile` (main build/deploy) and `Jenkinsfile.rds-snapshot-lifecycle` (RDS module plan/apply). Both are declarative. No `.groovy` files, `vars/`, `src/`, or `@Library` directive existed prior to this change.
- Both files repeated an `if (isUnix()) { sh '...' } else { bat '...' } ` pattern roughly a dozen times combined, and had near-identical `options{}` / `post{}` blocks, differing mainly in: presence of `-backend-config` flags on `init`, plan-file/stash names, `-target` on plan, approval message text, and the Setup-stage tool checklist.
- `terraform/main.tf` and `terraform/modules/rds-snapshot-lifecycle/main.tf` both pin `required_version = ">= 1.5.0"` — untouched by this change (no `.tf` files are modified).
- `scripts/terraform-setup.ps1`, `scripts/bootstrap-terraform-backend.ps1` provide native-Windows, non-WSL Terraform installation/bootstrap; both existing Jenkinsfiles already respect this via `isUnix()`/`bat`.
- `docs/ARCHITECTURE.md` (448 lines) has its entire content duplicated top-to-bottom, including two copies of the `## Jenkins Pipeline` and `## Windows Support` sections — a pre-existing issue, out of scope to fully deduplicate here, but both copies are kept in sync by this change.
- No Jenkins admin access or ability to create an external git repository is available from this environment, so the acceptance criterion "a dedicated Jenkins shared-library repository must be accounted for" cannot be fully satisfied (repo creation + Global Pipeline Library registration are both admin-only, out-of-repo actions). This is addressed by staging the library in-repo, ready for extraction, with the extraction/registration steps fully documented.

## Acceptance Criteria Mapping

| Acceptance Criterion | Implementation |
|---|---|
| Terraform must remain compatible with Terraform >= 1.5 | No `.tf` files touched; `required_version = ">= 1.5.0"` untouched. |
| Jenkinsfiles must use declarative pipeline syntax | Both Jenkinsfiles remain `pipeline { ... }` declarative; only step bodies inside `steps { script { ... } }` blocks changed. |
| Local Terraform commands must work natively on Windows; no WSL-only dependencies | Every shared-library function preserves the existing `isUnix()` → `sh`/`bat` (`terraform.exe`) branching; no new WSL dependency introduced. |
| Repetitive Groovy build/deploy steps must be abstracted into callable shared-library functions | 10 functions added under `jenkins-shared-library/vars/*.groovy` in idiomatic Jenkins Global Shared Library format; both Jenkinsfiles call them (via `load()`, see Chunk 2). |
| Architecture documentation must be updated | `docs/ARCHITECTURE.md` — both duplicated `## Jenkins Pipeline` and `## Windows Support` sections updated. |
| A dedicated Jenkins shared-library repository must be accounted for | Cannot be created/registered from this environment (no repo-creation or Jenkins admin access). Addressed by staging the library at `jenkins-shared-library/` in a layout ready for `git subtree split` extraction, with exact extraction and Jenkins Global Pipeline Library registration steps documented in `jenkins-shared-library/README.md`. |

## Chunks

### Chunk 1 — Scaffold the shared library
**Complexity:** simple
**Files touched:**
- `jenkins-shared-library/vars/crossPlatformSh.groovy`
- `jenkins-shared-library/vars/tfSetup.groovy`
- `jenkins-shared-library/vars/tfInit.groovy`
- `jenkins-shared-library/vars/tfVerifyBackendLock.groovy`
- `jenkins-shared-library/vars/tfFormatCheck.groovy`
- `jenkins-shared-library/vars/tfValidate.groovy`
- `jenkins-shared-library/vars/tfPlan.groovy`
- `jenkins-shared-library/vars/tfApply.groovy`
- `jenkins-shared-library/vars/dockerBuildImage.groovy`
- `jenkins-shared-library/vars/trivyScanImage.groovy`
- `jenkins-shared-library/README.md`

**Changes:**
Each `vars/*.groovy` file defines a single `def call(Map params) { ... }` step (see `.kimchi/docs/jenkins-shared-library-spec.md` for exact signatures) reproducing the command(s) one or more existing inline Jenkinsfile stages used, parameterized to cover both Jenkinsfiles' divergent details (backend-config presence, plan/stash names, `-target`, approval text stays in the Jenkinsfile since it's a declarative `input{}` directive, not a step). Each file ends with `return this` so it works both as a real shared-library global variable (future `@Library` use) and when loaded today via the `load()` step — see the README for why.

**Acceptance criteria for Chunk 1:**
- Each `vars/*.groovy` file passes Groovy syntax/lint checks (`npm-groovy-lint`) with zero errors.
- `jenkins-shared-library/README.md` documents the function catalog, the `return this` / `load()` compatibility trick, and the extraction-to-dedicated-repo steps.

### Chunk 2 — Wire both Jenkinsfiles to call the shared library via `load()`
**Complexity:** moderate
**Files touched:**
- `Jenkinsfile`
- `Jenkinsfile.rds-snapshot-lifecycle`

**Changes:**
1. Add `def lib = [:]` before the `pipeline {}` block in each file.
2. In each file's existing `Setup` stage, `load()` every shared-library function that Jenkinsfile needs into `lib`, then call `lib.tfSetup(tools: [...])` with the same tool list the stage checked before (main: `terraform, aws, docker, trivy`; rds: `terraform, aws`).
3. Replace every other stage's inline `if (isUnix()) { sh ... } else { bat ... }` body with the matching `lib.xxx(...)` call, passing the same directory/env values the stage already used (`env.TERRAFORM_DIR`, `env.MODULE_DIR`, `env.PLAN_FILE`, `env.STATE_BUCKET_NAME`, etc.).
4. Leave `agent{}`, `options{}`, `environment{}`, `when{}`, `input{}`, and `post{}` completely unchanged — these are declarative directives, not extractable step logic.

**Acceptance criteria for Chunk 2:**
- Both Jenkinsfiles pass Groovy syntax/lint checks with zero errors.
- Every stage's `lib.xxx(...)` call reproduces the exact command flags of the inline code it replaces (see the mapping table in the spec doc), except two documented, deliberate deviations: `tfSetup` normalizes `terraform version` → `terraform -version` for consistency; `tfVerifyBackendLock` runs the force-unlock probe once instead of twice (the original ran an identical command twice — once for `returnStatus`, once for `returnStdout` — which was redundant).
- No `.tf` file, `agent`, `options`, `environment`, `when`, `input`, or `post` block changed.

### Chunk 3 — Update architecture documentation
**Complexity:** simple
**Files touched:**
- `docs/ARCHITECTURE.md`

**Changes:**
1. Add a bullet to both duplicated `## Jenkins Pipeline (Jenkinsfile)` sections describing the shared library, that it's loaded via `load()` today, and pointing at `jenkins-shared-library/README.md` for the `@Library` follow-up.
2. Add a bullet to both duplicated `## Windows Support` sections confirming the shared library preserves the existing `isUnix()`/`bat`/`terraform.exe` behavior and introduces no WSL dependency.

**Acceptance criteria for Chunk 3:**
- Both occurrences of each section are updated identically so neither copy goes stale.
- `docs/ARCHITECTURE.md` renders correctly as Markdown.

## Verification Strategy
- `npx npm-groovy-lint` against `jenkins-shared-library/vars/**/*.groovy`, `Jenkinsfile`, and `Jenkinsfile.rds-snapshot-lifecycle` — zero errors required.
- Manual line-by-line comparison of each new function's generated command(s) against the original inline `sh`/`bat` strings it replaces (see spec doc mapping table).
- `terraform fmt -check -recursive` / `terraform validate` in `terraform/` as a no-op sanity check, since no `.tf` files are touched by this change.
- Markdown review of `docs/ARCHITECTURE.md` and both new `.kimchi/docs/*.md` files.
- **Not verifiable in this environment:** actual Jenkins parsing/execution of the rewritten pipelines, `load()`'s CPS/serialization and shared-binding behavior at runtime, or script-security sandbox approval. The first real pipeline run after merge is the actual test; running it on a non-`main` branch first is recommended since `Apply` stages are `branch 'main'`-gated and won't trigger on a feature branch, limiting exposure to Setup → Plan.

## Notes
- The "dedicated Jenkins shared-library repository" acceptance criterion cannot be fully completed from this repository or environment: creating a new git repository and registering a Jenkins Global Pipeline Library both require access this environment doesn't have (repo-hosting admin rights, Jenkins "Manage Jenkins" access). `jenkins-shared-library/README.md` documents the exact `git subtree split` extraction command and Jenkins registration steps for whoever has that access to complete as a follow-up.
- `docs/ARCHITECTURE.md`'s whole-document duplication (unrelated to this change) is intentionally left as-is; fully deduplicating it is a separate, larger diff that shouldn't ride on this change. Both copies of the relevant sections were kept in sync so neither goes stale as a result of this work.
