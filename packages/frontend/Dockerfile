# syntax=docker/dockerfile:1.7
#
# Frontend image for @very-prince/frontend (Next.js standalone).
#
# Build strategy:
#   base       - shared Alpine + libc6-compat for native deps.
#   pruner     - Turbo produces a pruned lockfile scoped to the frontend
#                and its workspace deps (no backend/docs in the tree).
#   deps       - installs deps from the pruned lockfile with a BuildKit npm
#                cache mount. NO application source is copied here, so
#                source-only changes reuse this layer and the cache.
#   builder    - copies source, runs Turbo build. Cache mounts keep the
#                npm cache, the shared `node_modules/.cache`, and the
#                per-package `.turbo` cache warm across runs. Next.js
#                standalone output is emitted to `.next/standalone`.
#   runner     - minimal Node runtime: non-root user + the Next.js
#                standalone bundle, static assets, and public/ folder.
#
# BuildKit features used:
#   * --mount=type=cache,target=/root/.npm    (npm download cache)
#   * --mount=type=cache,target=...           (per-stage BuildKit caches)
#   * --mount=type=bind,from=...              (multi-stage artifact copy)
#
# This image must be built with `docker buildx build` (BuildKit) for the
# cache mounts to take effect.

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Shared base image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
# libc6-compat: required by some Node native dependencies on Alpine.
RUN apk add --no-cache libc6-compat

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Prune the monorepo to just the frontend + its workspace deps
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS pruner
RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
    npm install -g turbo@2.10.5

# Copy ONLY root + workspace package manifests. Touching application source
# here would invalidate the prune step and re-fetch the lockfile.
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/types/package.json   ./packages/types/package.json
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/docs/package.json    ./packages/docs/package.json

RUN turbo prune @very-prince/frontend --docker

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Install dependencies from the pruned lockfile (no source yet)
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/package-lock.json ./package-lock.json

# Install with the npm cache mount. `--prefer-offline` makes the second
# build (with the cache populated) skip the network almost entirely.
# `--ignore-scripts` skips postinstall scripts; Next.js telemetry is also
# disabled via the `NEXT_TELEMETRY_DISABLED` env var in the builder stage.
RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
    npm ci \
      --ignore-scripts \
      --no-audit \
      --prefer-offline

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: Build the Next.js frontend (standalone output)
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS builder

# Copy build configuration and source. Source is copied AFTER `npm ci` so
# changes to application code do not invalidate the deps layer.
COPY tsconfig.base.json turbo.json ./
COPY packages/types    ./packages/types
COPY packages/frontend ./packages/frontend

ENV NEXT_TELEMETRY_DISABLED=1

# Turbo build: cache mounts keep the npm cache, the shared `.cache`, and
# the per-package `.turbo` cache warm across runs.
RUN --mount=type=cache,target=/app/node_modules/.cache,sharing=locked \
    --mount=type=cache,target=/app/packages/frontend/.turbo,sharing=locked \
    --mount=type=cache,target=/root/.npm,id=npm-cache \
    npx turbo run build --filter=@very-prince/frontend...

# ─────────────────────────────────────────────────────────────────────────────
# Stage 5: Minimal production runtime (Next.js standalone)
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/packages/frontend

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Copy the Next.js standalone server (already includes the minimal
# production node_modules subset it needs) plus static + public assets.
COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/.next/static   ./packages/frontend/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/public         ./packages/frontend/public

USER nextjs
EXPOSE 3000

CMD ["node", "packages/frontend/server.js"]
