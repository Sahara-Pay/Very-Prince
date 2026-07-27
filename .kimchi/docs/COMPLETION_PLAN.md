# Completion Plan: Dockerfile BuildKit Caching & node_modules Optimization

## Overview

The task is to complete what's not done in the project. Based on audit of current state:

### Audit Findings

| Area | Current State | What's Missing |
|------|---------------|---------------|
| **Dockerfiles (BuildKit)** | Both use `--mount=type=cache,target=/root/.npm` for npm cache. Backend has `npm prune` stage. Frontend has no prune stage. | Frontend should also prune dev deps for production. Backend prunes but still copies full node_modules. Both should use `RUN --mount=type=cache,target=/app/node_modules/.cache` for turbo/prisma builds. |
| **Jenkinsfile** | Only builds backend Docker image. Uses registry cache for backend only. | Needs to build frontend Docker image too. Needs consistent cache ref names. No explicit `turbo` or `prisma` cache mount for build tools. |
| **docker-bake.hcl** | Uses `very-prince-backend:cache` and `very-prince-frontend:cache` as local cache refs. | Jenkinsfile uses `ghcr.io/.../buildcache` for remote registry. These are inconsistent. Remote image registry should match. |
| **docker-compose.staging.yml** | Builds backend only. | No frontend build. No buildkit cache export for local development. |
| **ARCHITECTURE.md** | Covers Terraform state, ECS, SNS, CloudFront, Jenkins. | Does NOT document: BuildKit caching strategy, node_modules optimization, multistage Dockerfile structure, frontend Docker image. |
| **Terraform modules** | All modules use `required_version = "~> 1.9.0"` (>= 1.5 ✓). EKS module is incomplete (no vars/outputs). | EKS module needs variables.tf and outputs.tf to be complete. |

### Acceptance Criteria Verification

| Criterion | Status | Action Needed |
|-----------|--------|----------------|
| Dockerfiles utilize multistage builds effectively | ✅ Done (6 stages backend, 5 stages frontend) | Minor: optimize cache mounts for turbo/prisma |
| Build caches are preserved across Jenkins agents | ⚠️ Partial | Jenkinsfile uses `--cache-from=type=registry` but only for backend. Need frontend cache. Different cache ref patterns between bake.hcl and Jenkinsfile |
| Architecture documentation updated | ⚠️ Partial | ARCHITECTURE.md describes Docker/BuildKit in Jenkins section but missing detailed Dockerfile structure and BuildKit strategy |

### Technical Requirements Check

| Requirement | Status | Notes |
|------------|--------|-------|
| Terraform >= 1.5 | ✅ | All modules use `required_version = "~> 1.9.0"` |
| Declarative Jenkinsfile | ✅ | Jenkinsfile uses `pipeline { ... }` with `stages` |
| Native Windows support (no WSL) | ✅ | `scripts/terraform-setup.ps1`, `scripts/bootstrap-terraform-backend.ps1`, Jenkinsfile `bat`/`isUnix()` |
| No WSL dependencies | ✅ | All scripts use native PowerShell/cmd |

## Phase 1: Optimize Dockerfiles for BuildKit & node_modules

### Backend Dockerfile Changes
1. Add `RUN --mount=type=cache,target=/app/node_modules/.cache` for turbo/prisma in builder stage
2. Move `npm prune` to use `--mount=type=cache,target=/root/.npm npm prune --production` for better cache reuse
3. Remove `ENV DOCKER_BUILDKIT=1` (not needed at runtime; only needed at build time via `docker buildx`)

### Frontend Dockerfile Changes
1. Add `prod-deps` stage: `RUN npm prune --omit=dev --ignore-scripts` after builder to minimize runtime image size
2. Use `COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/node_modules` instead of relying on standalone output's bundled node_modules (might be unnecessary if standalone includes all deps)
3. Add `RUN --mount=type=cache,target=/app/node_modules/.cache npx turbo run build` for frontend build cache

## Phase 2: Align Jenkinsfile & docker-bake.hcl

### Jenkinsfile
1. Add frontend build stage with `--cache-from=type=registry,ref=ghcr.io/bridgetthnkechi87-cloud/very-prince-frontend:buildcache`
2. Fix cache ref: `BUILDKIT_CACHE_REF` should be consistent between the two targets

### docker-bake.hcl
1. Update cache refs to match Jenkinsfile: use `ghcr.io/bridgetthnkechi87-cloud/very-prince-backend:buildcache` and `ghcr.io/bridgetthnkechi87-cloud/very-prince-frontend:buildcache`
2. Add `mode=max` to cache-to for both

### docker-compose.staging.yml
1. Add frontend build target with BuildKit caching
2. Add `--cache-to` and `--cache-from` for local development

## Phase 3: Update Architecture Documentation

### ARCHITECTURE.md
1. Add section "Docker Build Optimization" detailing:
   - BuildKit enabled via `docker buildx`
   - Cache-mount types for npm, turbo, prisma
   - Registry-based cache for cross-agent reuse
   - Multistage structure (prune → deps → builder → prod-deps → runner)
2. Add section "Frontend Docker Image" with standalone output details
3. Update "Jenkins Pipeline" section with both backend and frontend build stages
4. Document node_modules optimization (prune dev deps, separate prod-only node_modules)

## Phase 4: Verify & Test

1. `lsp_diagnostics` on all edited files
2. `terraform validate` on terraform modules
3. `knip.json` check for unused exports
4. `package-lock.json` consistency