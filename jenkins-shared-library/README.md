# Very-Prince Jenkins Shared Library

Reusable Groovy build/deploy steps for the `Jenkinsfile` and
`Jenkinsfile.rds-snapshot-lifecycle` pipelines. Written in standard Jenkins
[Global Shared Library](https://www.jenkins.io/doc/book/pipeline/shared-libraries/)
`vars/` format: every file is a `def call(Map params) { ... }` step.

## Function catalog

| Function | Purpose |
|---|---|
| `crossPlatformSh` | Runs a Unix `sh` or Windows `bat` command depending on `isUnix()`. Reusable primitive, not called by the other functions today (see "Why each file ends with `return this`" below). |
| `tfSetup` | Prints version info for a list of CLIs (`terraform`, `aws`, `docker`, `trivy`). |
| `tfInit` | `terraform init`, optionally with `-backend-config` flags. |
| `tfVerifyBackendLock` | Confirms the DynamoDB state lock table is reachable. |
| `tfFormatCheck` | `terraform fmt -check -recursive`. |
| `tfValidate` | `terraform validate`, optionally preceded by a backend-less `init` for standalone module validation. |
| `tfPlan` | `terraform plan -out=<file>` + `stash`. |
| `tfApply` | `unstash` + `terraform apply <file>`. |
| `dockerBuildImage` | `docker build --file <dockerfile> --tag <image>:<tag> .` |
| `trivyScanImage` | `trivy image --exit-code <n> --severity <sev> <image>:<tag>` |

See each file's header comment for its exact parameters.

## Current status: staged in-repo, not yet a registered shared library

This directory is **not** currently registered with Jenkins as a Global
Pipeline Library — that requires Jenkins admin access ("Manage Jenkins" →
"System" → "Global Trusted Pipeline Libraries") and a **separate, dedicated
git repository** to point it at, neither of which is available from inside
this repo. Both are tracked as a follow-up (see
`.kimchi/docs/jenkins-shared-library-plan.md`).

In the meantime, both Jenkinsfiles load these functions directly from the
checked-out workspace via Jenkins' `load()` step, e.g.:

```groovy
def lib = [:]
...
lib.tfPlan = load('jenkins-shared-library/vars/tfPlan.groovy')
...
lib.tfPlan(dir: env.TERRAFORM_DIR, planFile: 'tfplan', stashName: 'tfplan', lockTimeout: '300s')
```

### Why each file ends with `return this`

A `vars/*.groovy` file used as a real shared-library global variable only
needs its `call()` method — Jenkins instantiates the compiled class and
invokes `.call(...)` directly, never running the script's implicit top-level
body. But the plain `load()` step *does* execute that top-level body and
returns the value of its last statement. Adding `return this` as the final
line makes `load(...)` return the script instance itself, which has a `call`
method — so it can be invoked directly (`loaded(params)`), while remaining
completely inert once the file is used the "real" shared-library way (that
path never runs the top-level body, so the extra `return this` is never
reached). The same file works unmodified in both modes.

Because `load()`-loaded scripts don't automatically share a namespace the
way real shared-library global variables do, each function here is
self-contained — none of them call `crossPlatformSh` or each other
internally. `crossPlatformSh` is kept as a documented reusable primitive for
future functions once real `@Library` wiring makes cross-calls natural.

## Follow-up: extracting this into its own repository

1. Split this directory's history into a standalone branch:
   ```sh
   git subtree split --prefix=jenkins-shared-library -b jenkins-shared-library-extract
   ```
2. Create the dedicated repository (e.g. `very-prince-jenkins-shared-library`)
   and push the extracted branch to its default branch:
   ```sh
   git push <new-repo-url> jenkins-shared-library-extract:main
   ```
3. In Jenkins: **Manage Jenkins → System → Global Trusted Pipeline
   Libraries**, add an entry (e.g. name `very-prince-shared-lib`, default
   version `main`, retrieval method "Modern SCM" pointing at the new repo).
   Add credentials there if the repo is private.
4. Replace the `load(...)` calls in both Jenkinsfiles with a single
   `@Library('very-prince-shared-lib@main') _` line at the top of the file,
   and remove the `def lib = [:]` / per-function `load()` calls — the
   functions become directly callable by name (`tfPlan(...)` instead of
   `lib.tfPlan(...)`). See the "future state" example in
   `.kimchi/docs/jenkins-shared-library-spec.md`.
5. Once both Jenkinsfiles are updated, this directory can be deleted from
   `Very-Prince` and consumed solely from the new repository going forward.
