# Plan: Restructure Dockerfiles for BuildKit Caching & Optimize node_modules Installation

## Objective
Restructure `packages/backend/Dockerfile` and `packages/frontend/Dockerfile` to:
1. Use BuildKit cache mounts (`--mount=type=cache`) for npm package downloads
2. Remove harmful `npm cache clean --force` calls
3. Optimize multistage build layer ordering for maximum cache reuse
4. Update Jenkinsfile to enable BuildKit and preserve caches across runs
5. Tighten Terraform version constraints and upgrade AWS provider to 5.x
6. Update `docs/ARCHITECTURE.md` to reflect changes

---

## Current State (from exploration)

### Backend Dockerfile (6 stages)
| Stage | Problem |
|-------|---------|
| `pruner` | `npm cache clean --force` after `turbo` install |
| `deps` | `npm ci` + `npm cache clean --force` — no BuildKit cache mount |
| `builder` | Extra `npm install --no-save @types/urijs @types/json-schema` + cache clean — could fold into `deps` |
| `prod-deps` | `npm prune --omit=dev` + manual Prisma engine cleanup + cache clean |

### Frontend Dockerfile (4 stages)
| Stage | Problem |
|-------|---------|
| `pruner` | `npm cache clean --force` after `turbo` install |
| `deps` | `npm ci` + `npm cache clean --force` — no BuildKit cache mount |
| `builder` | OK (Next.js standalone output bundles deps) |

### Jenkinsfile
- No `DOCKER_BUILDKIT=1` env var
- `docker build` without `--cache-from` / `--cache-to`
- `cleanWs()` in `post { always }` destroys workspace (and any local layer cache)
- Single agent (`terraform` label) — no cross-agent cache sharing needed if we use BuildKit registry cache

### Terraform
- `required_version = ">= 1.5.0"` → should be `~> 1.9.0` (matches Jenkins `TF_VERSION = '1.9.0'`)
- `required_providers.aws = "~> 4.0"` → **EOL**, must be `~> 5.0`
- `fargate-task` module uses deprecated `cpu_architecture` (removed in provider 5.x)

### Architecture docs
- `docs/ARCHITECTURE.md` references AWS provider 4.x, `cpu_architecture`, bootstrap scripts

---

## Implementation Plan

### Phase 1: Backend Dockerfile Restructure

**File:** `packages/backend/Dockerfile`

**Changes:**
1. Add `# syntax=docker/dockerfile:1.7` at top (enables BuildKit features)
2. Set `ENV DOCKER_BUILDKIT=1` in base stage (explicit opt-in)
3. **pruner stage**: Remove `npm cache clean --force`. Add `RUN --mount=type=cache,target=/root/.npm npm install -g turbo@2.10.5`
4. **deps stage**: 
   - Remove `npm cache clean --force`
   - Add `RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts`
   - Fold the transitive type packages (`@types/urijs @types/json-schema`) into this stage via a single `npm ci` that includes them in the pruned lockfile (or install them here before `npm ci`)
5. **builder stage**: Remove the separate `npm install --no-save @types/...` + cache clean. Prisma generate and turbo build stay.
6. **prod-deps stage**: Remove `npm cache clean --force`. Keep `npm prune --omit=dev` and Prisma engine cleanup.
7. **runner stage**: Unchanged (correct).

**Key insight**: The `turbo prune --docker` in the pruner stage already generates a pruned `package-lock.json` with only backend + types deps. The transitive `@types/urijs` and `@types/json-schema` are pulled in by the backend package's dependencies. We can either:
- Add them to `packages/backend/package.json` as `devDependencies` (preferred — then they're in the pruned lockfile automatically)
- Or install them in `deps` stage with a single combined `npm ci`

**Decision**: Add to `packages/backend/package.json` as `devDependencies` so `turbo prune` captures them. This keeps `deps` stage simple: one `npm ci` with cache mount.

### Phase 2: Frontend Dockerfile Restructure

**File:** `packages/frontend/Dockerfile`

**Changes:**
1. Add `# syntax=docker/dockerfile:1.7`
2. Set `ENV DOCKER_BUILDKIT=1` in base stage
3. **pruner stage**: Remove `npm cache clean --force`. Add cache mount for global turbo install.
4. **deps stage**: Remove `npm cache clean --force`. Add `RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts`
5. **builder stage**: Unchanged (Next.js standalone bundles deps)
6. **runner stage**: Unchanged

### Phase 3: Jenkinsfile Updates

**File:** `Jenkinsfile`

**Changes:**
1. Add `DOCKER_BUILDKIT=1` to environment block
2. Update `Build Docker Image` stage:
   - Use `docker buildx build` instead of `docker build` (BuildKit required for cache mounts)
   - Add `--cache-from=type=registry,ref=ghcr.io/bridgetthnkechi87-cloud/very-prince-backend:cache` (or similar)
   - Add `--cache-to=type=registry,ref=ghcr.io/bridgetthnkechi87-cloud/very-prince-backend:cache,mode=max`
   - Tag with `BUILD_NUMBER` and `latest`
3. Remove `cleanWs()` from `post { always }` — preserves workspace for layer cache
   - Add explicit `cleanWs()` only on `failure` if disk space is a concern
4. Since this is a **single-agent pipeline** (`label 'terraform'`), registry cache is sufficient. No need for multi-agent cache sharing.
5. Keep Windows/Unix branching (`isUnix()` / `bat`) for Terraform CLI calls — already correct.

**Note**: If registry cache isn't available, fall back to local layer cache (which works because workspace isn't wiped). The `cleanWs()` removal is the key change.

### Phase 4: Terraform Version & Provider Updates

**Files:**
- `terraform/main.tf`
- `terraform/modules/fargate-task/main.tf` (and variables.tf if needed)

**Changes:**
1. `terraform/main.tf`:
   - `required_version = "~> 1.9.0"`
   - `required_providers.aws.version = "~> 5.0"`
2. `terraform/modules/fargate-task/main.tf`:
   - Remove `cpu_architecture` from `runtime_platform` block (deprecated in provider 5.x)
   - Remove `cpu_architecture` variable and validation
   - Default to `X86_64` implicitly (provider 5.x default)
3. Run `terraform init -upgrade` to fetch provider 5.x
4. Verify `terraform validate` and `terraform plan` pass

### Phase 5: Architecture Documentation Updates

**File:** `docs/ARCHITECTURE.md`

**Changes:**
1. Update Terraform version constraint from `>= 1.5.0` to `~> 1.9.0`
2. Update AWS provider version from `~> 4.0` to `~> 5.0`
3. Remove `cpu_architecture` / `X86_64` references from Fargate Task section
4. Add BuildKit cache mount section under "Jenkins Pipeline" or new "Docker Build Optimization" section:
   - Document `RUN --mount=type=cache,target=/root/.npm` usage
   - Document registry cache (`docker buildx build --cache-from/--cache-to`)
   - Note removal of `npm cache clean --force`
5. Verify bootstrap script references are still accurate (they are)

---

## Acceptance Criteria Checklist

| Criterion | Verification |
|-----------|--------------|
| Dockerfiles use multistage builds effectively | ✅ Already true; we optimize layer ordering |
| Build caches preserved across Jenkins agents | ✅ Registry cache + no `cleanWs()` |
| Architecture documentation updated | ✅ `ARCHITECTURE.md` updates |
| Terraform >= 1.5 | ✅ Pinned to `~> 1.9.0` |
| Jenkinsfile uses declarative pipeline | ✅ Already true; we only add env vars and build flags |
| Native Windows support (no WSL required) | ✅ Unchanged — Jenkinsfile already has `isUnix()`/`bat` branching; Terraform CLI runs natively |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| BuildKit cache mount syntax requires Dockerfile syntax directive | Add `# syntax=docker/dockerfile:1.7` at top of each Dockerfile |
| Registry cache requires authenticated access to GHCR | Use `docker login` in Jenkins `Setup` stage or rely on local layer cache (workspace preserved) |
| Provider 5.x may have breaking changes beyond `cpu_architecture` | Run `terraform plan` in staging first; review provider 5.x upgrade guide |
| `turbo prune` may not include transitive type deps if not in `package.json` | Add `@types/urijs` and `@types/json-schema` to `packages/backend/package.json` `devDependencies` |
| Removing `cleanWs()` may fill agent disk over time | Add periodic disk cleanup job or `cleanWs()` only on `failure` |

---

## File Change Summary

| File | Change Type |
|------|-------------|
| `packages/backend/Dockerfile` | Modify (add syntax, cache mounts, remove cache cleans, fold type deps) |
| `packages/backend/package.json` | Modify (add `@types/urijs`, `@types/json-schema` to devDependencies) |
| `packages/frontend/Dockerfile` | Modify (add syntax, cache mounts, remove cache cleans) |
| `Jenkinsfile` | Modify (add DOCKER_BUILDKIT, buildx cache flags, remove cleanWs) |
| `terraform/main.tf` | Modify (pin versions) |
| `terraform/modules/fargate-task/main.tf` | Modify (remove cpu_architecture) |
| `terraform/modules/fargate-task/variables.tf` | Modify (remove cpu_architecture variable) |
| `docs/ARCHITECTURE.md` | Modify (version updates, BuildKit section) |

---

## Execution Order

1. Backend Dockerfile + package.json (Phase 1)
2. Frontend Dockerfile (Phase 2)
3. Jenkinsfile (Phase 3)
4. Terraform version/provider + fargate-task (Phase 4)
5. Architecture docs (Phase 5)
6. Test: `docker buildx build` locally, `terraform validate`, `terraform plan`
7. Independent review