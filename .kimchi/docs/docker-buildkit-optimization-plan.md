# Dockerfile BuildKit Caching & node_modules Optimization Plan

## Objective
Restructure `packages/backend/Dockerfile` and `packages/frontend/Dockerfile` to maximize BuildKit layer/cache reuse, optimize `node_modules` installation/pruning, and update `Jenkinsfile` so BuildKit registry caches survive across Jenkins agent runs. Update `docs/ARCHITECTURE.md` to reflect the new build flow.

## Constraints (from task description)
- Terraform modules must remain compatible with Terraform >= 1.5 (currently `~> 1.9.0`).
- Jenkinsfile must use declarative pipeline syntax.
- Native Windows Terraform CLI execution must be supported; no WSL dependencies.

## Current issues identified
1. **Jenkinsfile cache-reference bug**: the build step interpolates `$BUILDKIT_CACHE_REF` but the environment block defines `$BUILDKIT_CACHE_REF_BACKEND` and `$BUILDKIT_CACHE_REF_FRONTEND`. The undefined variable causes cache-from/cache-to to be ignored on the backend build.
2. **Frontend image is not built in CI**: `Jenkinsfile` only builds `very-prince-backend`; `very-prince-frontend` is ignored despite being part of the architecture.
3. **No registry push in CI**: images are built with `--load` only, so they are not available to downstream agents or deployments that pull from a registry.
4. **`node_modules` layer invalidation**: copying source code into the `deps` stage invalidates `npm ci` whenever application source changes, even when lockfile is unchanged.
5. **Cache mount scope**: the npm cache mount is present, but `node_modules` itself is written into the image layer. Large `node_modules` layers slow pulls and increase image size.
6. **Inconsistent bake vs. Jenkins**: `docker-bake.hcl` uses different cache refs (`:cache`) than Jenkins (`:buildcache`).

## Target state
- Both Dockerfiles use multistage builds with: `base` → `pruner` → `deps` → `builder` → `prod-deps` (backend only) → `runner`.
- `npm ci` / `npm prune` run with `--mount=type=cache,target=/root/.npm` and a checksum-stable cache-busting strategy based on `package-lock.json`.
- Application source is copied **after** dependency install so source changes do not invalidate the dependency layer.
- Backend production image strips Prisma engines/dev dependencies; frontend production image uses Next.js standalone output.
- Jenkins builds backend and frontend in parallel declarative stages, pushes both to the registry, and uses `--cache-from` / `--cache-to` with the correct environment variables.
- `docker-bake.hcl` cache refs align with Jenkins env vars and support local multi-platform builds.
- Architecture doc is updated with the new Docker build/cache sections.

## Chunk 1 — Backend Dockerfile optimization

**Complexity:** complex (multistage, BuildKit cache mounts, Turbo prune, Prisma engine handling)

**Files:** `packages/backend/Dockerfile`

**Changes:**
1. Keep the `# syntax=docker/dockerfile:1.7` directive and `node:20-alpine` base.
2. `base` stage: set `WORKDIR /app`, `NODE_ENV=production` only in runtime, install `libc6-compat openssl`.
3. `pruner` stage: install `turbo` globally using npm cache mount; copy only root/package manifests and workspace `package.json` files; run `turbo prune @very-prince/backend --docker`.
4. `deps` stage: copy **only** `/app/out/json/` and `package-lock.json` from `pruner`. Run:
   ```dockerfile
   RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
       npm ci --ignore-scripts --prefer-offline --no-audit
   ```
   Do **not** copy application source in this stage.
5. `builder` stage: copy `node_modules` from `deps`; copy `tsconfig.base.json`, `turbo.json`, `packages/types`, `packages/backend`; run `npx prisma generate` and `npx turbo run build --filter=@very-prince/backend...` with cache mounts for `/root/.npm`, `/app/node_modules/.cache`, and `/app/packages/backend/.turbo`.
6. `prod-deps` stage: copy `node_modules` from `builder`; set `NODE_ENV=production`; run `npm prune --omit=dev --ignore-scripts` with npm cache mount; remove Prisma engine/fetch-engine packages.
7. `runner` stage: create non-root user; copy `node_modules` from `prod-deps` and backend artifacts from `builder`; expose `3001`; run `dist/index.js`.

**Acceptance criteria:**
- `docker buildx build -f packages/backend/Dockerfile -t very-prince-backend:test .` succeeds.
- Re-running the build after a source-only change reuses the `deps` layer and completes faster than after a lockfile change.
- `docker run --rm very-prince-backend:test node -e "console.log('ok')"` starts.
- Image has no `prisma` dev engine packages in `/app/node_modules`.

## Chunk 2 — Frontend Dockerfile optimization

**Complexity:** complex (multistage, BuildKit cache mounts, Next.js standalone output)

**Files:** `packages/frontend/Dockerfile`

**Changes:**
1. Mirror the backend structure: `base` → `pruner` → `deps` → `builder` → `runner`.
2. Remove `ENV DOCKER_BUILDKIT=1` from inside the Dockerfile (already set by Jenkins/cli).
3. `pruner` stage: prune `@very-prince/frontend`.
4. `deps` stage: copy only pruned JSON/lockfile; run `npm ci --ignore-scripts --prefer-offline --no-audit` with npm cache mount. Do not copy source here.
5. `builder` stage: copy `node_modules` from `deps`; copy `tsconfig.base.json`, `turbo.json`, `packages/types`, `packages/frontend`; set `NEXT_TELEMETRY_DISABLED=1`; build with cache mounts for `/root/.npm`, `/app/node_modules/.cache`, `/app/packages/frontend/.turbo`.
6. `runner` stage: use `node:20-alpine`, create non-root user, copy Next.js standalone output (`.next/standalone`, static, public), expose `3000`.

**Acceptance criteria:**
- `docker buildx build -f packages/frontend/Dockerfile -t very-prince-frontend:test .` succeeds.
- Re-running after a source-only change reuses the `deps` layer.
- `docker run --rm very-prince-frontend:test node -e "console.log('ok')"` starts.

## Chunk 3 — Jenkinsfile declarative cache/push pipeline

**Complexity:** complex (cross-platform sh/bat, parallel stages, registry cache refs, image push)

**Files:** `Jenkinsfile`

**Changes:**
1. Fix the cache-reference variable names (use `BUILDKIT_CACHE_REF_BACKEND` and `BUILDKIT_CACHE_REF_FRONTEND`).
2. Add registry/image push variables:
   - `REGISTRY = 'ghcr.io/bridgetthnkechi87-cloud'`
   - `DOCKER_IMAGE_REF = "${REGISTRY}/very-prince-backend"`
   - `FRONTEND_IMAGE_REF = "${REGISTRY}/very-prince-frontend"`
3. Replace the single `Build Docker Image` stage with a `Build & Push Images` stage containing two parallel branches:
   - `Backend`
   - `Frontend`
   Each branch runs the platform-appropriate `docker buildx build` with:
   - `--cache-from=type=registry,ref=<correct-cache-ref>`
   - `--cache-to=type=registry,ref=<correct-cache-ref>,mode=max`
   - `--push` (instead of `--load`) so the image is available in the registry for downstream agents/deployments.
   - Tags: `:<BUILD_NUMBER>` and `:latest`.
4. Update the `Scan Docker Image` stage to scan the registry reference `very-prince-backend:<BUILD_NUMBER>` (or keep local build with `--load` for the backend and push after scan if security gate must run before push). For simplicity and to satisfy "scan before deploy", build backend with `--load`, scan, then push if scan passes. Frontend can be pushed in parallel because the security gate currently only applies to backend. Document this behavior.
5. Keep all existing Terraform stages unchanged (they already meet Terraform >= 1.5 and Windows support requirements).
6. Ensure `isUnix()` / `bat()` / `sh()` choices cover Windows agents.

**Acceptance criteria:**
- `Jenkinsfile` validates with Jenkins Declarative Pipeline linter (or at least has no obvious syntax errors).
- Both backend and frontend cache refs are referenced correctly.
- Backend scan still gates deployment.
- Frontend image is built and pushed in CI.

## Chunk 4 — docker-bake.hcl alignment

**Complexity:** simple

**Files:** `docker-bake.hcl`

**Changes:**
1. Update cache refs to match Jenkins env vars:
   - backend: `ghcr.io/bridgetthnkechi87-cloud/very-prince-backend:buildcache`
   - frontend: `ghcr.io/bridgetthnkechi87-cloud/very-prince-frontend:buildcache`
2. Add `output = ["type=registry"]` or keep local `type=docker` default; document that CI uses Jenkins env vars, local builds can override with `--set`.

**Acceptance criteria:**
- `docker buildx bake --print` succeeds (requires buildx). At minimum the file parses without syntax errors.

## Chunk 5 — Architecture documentation update

**Complexity:** simple

**Files:** `docs/ARCHITECTURE.md`

**Changes:**
1. Update the Jenkins pipeline section to describe:
   - Parallel backend/frontend image builds.
   - BuildKit registry cache refs and how they persist across agents.
   - Backend security scan gate before push.
2. Add a "Docker Build Caching" subsection under "Jenkins Pipeline" explaining the cache mounts (`/root/.npm`, `node_modules/.cache`, `.turbo`) and layer invalidation strategy.
3. Confirm Terraform version compatibility and native Windows support are already documented; no changes needed unless clarifying.

**Acceptance criteria:**
- ARCHITECTURE.md accurately reflects the new Jenkins stages and cache refs.
- No stale references to `$BUILDKIT_CACHE_REF` (undefined).

## Ordering & dependencies
1. Chunk 1 and Chunk 2 are independent → can be built in parallel.
2. Chunk 3 depends on Chunk 1 and Chunk 2 (Jenkins needs the Dockerfiles to exist and build successfully).
3. Chunk 4 is independent of Chunk 1/2 but should align with Chunk 3 cache refs; build after Chunk 3.
4. Chunk 5 depends on Chunk 3 (document the final pipeline).

## Testing strategy
- Build both images locally with `docker buildx build` after each Dockerfile change.
- Run a timed rebuild after touching only source code to confirm cache reuse.
- Validate `Jenkinsfile` syntax via `jenkins-cli` if available; otherwise visually inspect nested `script`/`parallel`/`stage` blocks.
- Confirm `terraform validate` still passes (no Terraform changes, but run as regression).
- Confirm `docker buildx bake --print` parses `docker-bake.hcl`.
