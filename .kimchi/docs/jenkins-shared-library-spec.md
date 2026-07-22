# Jenkins Shared Library — Implementation Spec

## Goal
Replace the duplicated `if (isUnix()) { sh ... } else { bat ... }` build/deploy logic in `Jenkinsfile` and `Jenkinsfile.rds-snapshot-lifecycle` with calls to a set of parameterized, reusable Groovy functions, staged in `jenkins-shared-library/vars/*.groovy` in true Jenkins Global Shared Library format, wired into both pipelines today via the `load()` step.

## Constraints
- Terraform version must remain `>= 1.5.0` — enforced by not touching any `.tf` file.
- Both Jenkinsfiles must remain declarative (`pipeline { ... }`); only step bodies inside `steps { script { ... } }` change.
- Native Windows support must be preserved — every function keeps the `isUnix()` → `sh`/`bat` (`terraform.exe`) branch; no WSL dependency introduced.
- No external repository or Jenkins admin action is performed by this change (out of reach of this environment) — see Notes in the plan doc.

## Implementation Chunks

### Chunk 1: `jenkins-shared-library/vars/*.groovy` function signatures

| File | `call(Map params)` | Behavior |
|---|---|---|
| `crossPlatformSh.groovy` | `sh` (required), `bat` (optional, defaults to `sh`), `returnStdout` (default false), `returnStatus` (default false) | Runs `sh`/`bat` per `isUnix()`. Documented reusable primitive; not called by the other 9 functions (see "load() namespace" note below). |
| `tfSetup.groovy` | `tools` (List, default `['terraform']`; subset of `terraform`/`aws`/`docker`/`trivy`) | Runs each tool's version-check command from an internal catalog. Unknown tool name → `error()`. |
| `tfInit.groovy` | `dir` (required), `backendConfig` (Map, optional), `inputFalse` (default true) | `dir(params.dir){}` wrapping `terraform init` + `-input=false` (if enabled) + one `-backend-config="k=v"` per `backendConfig` entry. |
| `tfVerifyBackendLock.groovy` | `dir` (required), `lockId` (default `'nonexistent-lock-id'`) | Runs `terraform force-unlock -force <lockId>` once with `returnStdout: true`; asserts output contains `'lock'`; `error()`s with the original message otherwise. |
| `tfFormatCheck.groovy` | `dir` (required) | `terraform fmt -check -recursive` inside `dir(params.dir)`. |
| `tfValidate.groovy` | `dir` (required), `standalone` (default false) | `standalone: true` → `terraform init -backend=false -input=false` then `validate`. `standalone: false` → just `validate`. |
| `tfPlan.groovy` | `dir`, `planFile`, `stashName` (required), `target` (optional), `lockTimeout` (optional), `inputFalse` (default false) | Builds `terraform plan` with optional `-input=false`, `-lock=true -lock-timeout=<v>`, `-target=`, `-out=<planFile>`; `stash includes: "<dir>/<planFile>", name: stashName`. |
| `tfApply.groovy` | `dir`, `planFile`, `stashName` (required), `lockTimeout` (optional), `autoApprove` (default true), `inputFalse` (default false) | `unstash stashName`; inside `dir(params.dir)` runs `terraform apply` with the equivalent flags + `-auto-approve` (if enabled) + `planFile`. |
| `dockerBuildImage.groovy` | `dockerfile`, `imageName`, `tag` (required) | `docker build --file <dockerfile> --tag <imageName>:<tag> .`, with a `\`-separated Dockerfile path on Windows. |
| `trivyScanImage.groovy` | `imageName`, `tag` (required), `severity` (default `'HIGH,CRITICAL'`), `exitCode` (default `1`) | `trivy image --exit-code <exitCode> --severity <severity> <imageName>:<tag>`. |

**`load()` namespace note:** functions loaded via `load()` don't share a call-by-name namespace with each other the way real shared-library global variables do, so none of the 9 higher-level functions call `crossPlatformSh` internally — each inlines its own `isUnix()` branch. Once real `@Library` wiring is in place, these could be refactored to call `crossPlatformSh` directly if desired; not done now to keep the `load()`-based bridge small and easy to reason about without a live Jenkins to test against.

**Why `return this`:** as a real shared-library global variable, Jenkins invokes `.call(...)` directly on the compiled class and never runs the script's top-level body. Under `load()`, Jenkins *does* run that body and returns its last statement's value — so `return this` makes `load(...)` return the script instance (which has the `call` method), letting it be invoked directly (`loaded(params)`). The line is inert once real `@Library` wiring replaces `load()`.

### Chunk 2: old command → new function call mapping

**`Jenkinsfile`**

| Stage | Original inline command(s) | New call |
|---|---|---|
| Setup | 4x `isUnix()` version checks (terraform/aws/docker/trivy) | `lib.tfSetup(tools: ['terraform','aws','docker','trivy'])` |
| Build Docker Image | `docker build --file packages/backend/Dockerfile --tag $DOCKER_IMAGE:$BUILD_NUMBER .` | `lib.dockerBuildImage(dockerfile: 'packages/backend/Dockerfile', imageName: env.DOCKER_IMAGE, tag: env.BUILD_NUMBER)` |
| Scan Docker Image | `trivy image --exit-code 1 --severity HIGH,CRITICAL $DOCKER_IMAGE:$BUILD_NUMBER` | `lib.trivyScanImage(imageName: env.DOCKER_IMAGE, tag: env.BUILD_NUMBER)` |
| Init | `terraform init -input=false -backend-config="bucket=..." -backend-config="dynamodb_table=..." -backend-config="region=..." -backend-config="encrypt=true"` | `lib.tfInit(dir: env.TERRAFORM_DIR, backendConfig: [bucket: env.STATE_BUCKET_NAME, dynamodb_table: env.DYNAMODB_LOCK_TABLE, region: env.AWS_DEFAULT_REGION, encrypt: 'true'])` |
| Verify Backend Lock | force-unlock probe run twice (status + stdout) | `lib.tfVerifyBackendLock(dir: env.TERRAFORM_DIR)` — runs once (documented simplification) |
| Validate | `terraform validate` | `lib.tfValidate(dir: env.TERRAFORM_DIR)` |
| Plan | `terraform plan -lock=true -lock-timeout=300s -out=tfplan` + stash | `lib.tfPlan(dir: env.TERRAFORM_DIR, planFile: 'tfplan', stashName: 'tfplan', lockTimeout: '300s')` |
| Apply | unstash + `terraform apply -lock=true -lock-timeout=300s -auto-approve tfplan` | `lib.tfApply(dir: env.TERRAFORM_DIR, planFile: 'tfplan', stashName: 'tfplan', lockTimeout: '300s')` |

**`Jenkinsfile.rds-snapshot-lifecycle`**

| Stage | Original inline command(s) | New call |
|---|---|---|
| Setup | 2x `isUnix()` version checks (terraform/aws) | `lib.tfSetup(tools: ['terraform','aws'])` |
| Format Check | `terraform fmt -check -recursive` in `MODULE_DIR` | `lib.tfFormatCheck(dir: env.MODULE_DIR)` |
| Init | `terraform init -input=false` | `lib.tfInit(dir: env.TERRAFORM_DIR)` |
| Validate Module | `terraform init -backend=false -input=false` + `terraform validate` in `MODULE_DIR` | `lib.tfValidate(dir: env.MODULE_DIR, standalone: true)` |
| Plan | `terraform plan -input=false -out=${PLAN_FILE} -target=module.rds_snapshot_lifecycle` + stash | `lib.tfPlan(dir: env.TERRAFORM_DIR, planFile: env.PLAN_FILE, stashName: 'rds-lifecycle-plan', target: 'module.rds_snapshot_lifecycle', inputFalse: true)` |
| Apply | unstash + `terraform apply -input=false -auto-approve ${PLAN_FILE}` | `lib.tfApply(dir: env.TERRAFORM_DIR, planFile: env.PLAN_FILE, stashName: 'rds-lifecycle-plan', inputFalse: true)` |

### Chunk 3: future state after `@Library` is registered

Once `jenkins-shared-library/` is extracted to its own repository and registered as a Jenkins Global Pipeline Library (see `jenkins-shared-library/README.md`), both Jenkinsfiles drop `def lib = [:]` and every `load(...)` call, add one line at the top, and call functions directly:

```groovy
@Library('very-prince-shared-lib@main') _

pipeline {
    ...
    stages {
        stage('Setup') {
            steps {
                script {
                    tfSetup(tools: ['terraform', 'aws', 'docker', 'trivy'])
                }
            }
        }
        stage('Plan') {
            steps {
                script {
                    tfPlan(dir: env.TERRAFORM_DIR, planFile: 'tfplan', stashName: 'tfplan', lockTimeout: '300s')
                }
            }
        }
        ...
    }
}
```

No changes to the `vars/*.groovy` files themselves are required for this transition — the `return this` line is simply never reached in this mode.

## Cross-Cutting Constraints
- Terraform version stays `>= 1.5.0`; no `.tf` files touched.
- Both Jenkinsfiles stay declarative.
- Native Windows support preserved (`bat`/`terraform.exe`, no WSL) in every function.
- No new external dependencies introduced.

## Verification Strategy
- `npx npm-groovy-lint --files "jenkins-shared-library/vars/**/*.groovy"` and against both Jenkinsfiles — zero errors.
- Manual diff of each mapping-table row against the actual `vars/*.groovy` implementation.
- `terraform fmt -check -recursive` / `terraform validate` in `terraform/` (no-op sanity check; no `.tf` changes).
- Real Jenkins execution (parsing, `load()` runtime/CPS behavior, script-security sandbox) cannot be verified in this environment — treat the first real pipeline run as the actual test, ideally on a non-`main` branch first (Apply stages are `branch 'main'`-gated, so a feature-branch run only exercises Setup → Plan).
