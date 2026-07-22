# syntax=docker/dockerfile:1.7
#
# Backend image for @very-prince/backend.
#
# Build strategy:
#   base       - shared Alpine + native deps (libc6-compat, openssl for Prisma).
#   pruner     - uses Turbo to produce a pruned lockfile so each package only
#                pulls its own dependencies (no frontend/docs in the tree).
#   deps       - installs deps from the pruned lockfile with a BuildKit npm
#                cache mount. NO application source is copied in this stage,
#                so source-only changes reuse this layer and the cache.
#   builder    - copies source, generates Prisma client, runs Turbo build.
#                Cache mounts keep `node_modules/.cache`, the per-package
#                `.turbo` cache, and the npm cache warm across runs.
#   prod-deps  - reuses the builder's `node_modules`, switches NODE_ENV to
#                production, and runs `npm prune --omit=dev --ignore-scripts`
#                inside the npm cache mount so devDependencies and the
#                unused Prisma engine binaries are removed before the
#                production image is assembled.
#   runner     - minimal runtime: non-root user, compiled dist, and the
#                pruned production `node_modules`. No build tooling, no
#                devDependencies, no source tree.
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
# libc6-compat: required by Prisma + Turbo native binaries on Alpine.
# openssl:      required by Prisma engines.
RUN apk add --no-cache libc6-compat openssl

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Prune the monorepo to just the backend + its workspace deps
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS pruner
# Install Turbo globally inside an npm cache mount so the binary install is
# reused on subsequent builds.
RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
    npm install -g turbo@2.10.5

# Copy ONLY root + workspace package manifests. Touching application source
# here would invalidate the prune step and re-fetch the lockfile.
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/types/package.json   ./packages/types/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/docs/package.json    ./packages/docs/package.json

RUN turbo prune @very-prince/backend --docker

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Install dependencies from the pruned lockfile (no source yet)
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS deps
# Copy the pruned JSON manifests and lockfile from the pruner stage.
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/package-lock.json ./package-lock.json

# Install with the npm cache mount. `--prefer-offline` makes the second
# build (with the cache populated) skip the network almost entirely.
# `--ignore-scripts` avoids running package postinstall scripts (we run
# Prisma generate in the builder stage with the engine cache mount).
RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
    npm ci \
      --ignore-scripts \
      --no-audit \
      --prefer-offline

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: Generate Prisma client + build the backend
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS builder

# Copy build configuration and source. Source is copied AFTER `npm ci` so
# changes to application code do not invalidate the deps layer.
COPY tsconfig.base.json turbo.json ./
COPY packages/types   ./packages/types
COPY packages/backend ./packages/backend

# Prisma generate: cache the engine download directory so re-builds reuse the
# downloaded engines instead of re-fetching them on every build.
RUN --mount=type=cache,target=/app/node_modules/.cache,sharing=locked \
    --mount=type=cache,target=/root/.npm,id=npm-cache \
    npx prisma generate --schema=packages/backend/prisma/schema.prisma

# Turbo build: cache mounts keep the npm cache, the shared `.cache`, and
# the per-package `.turbo` cache warm across runs.
RUN --mount=type=cache,target=/app/node_modules/.cache,sharing=locked \
    --mount=type=cache,target=/app/packages/backend/.turbo,sharing=locked \
    --mount=type=cache,target=/root/.npm,id=npm-cache \
    npx turbo run build --filter=@very-prince/backend...

# ─────────────────────────────────────────────────────────────────────────────
# Stage 5: Prune dev dependencies for the production image
# ─────────────────────────────────────────────────────────────────────────────
FROM builder AS prod-deps
ENV NODE_ENV=production

# Reuse the builder's `node_modules` and prune devDependencies. The npm
# cache mount keeps the offline package cache warm so this prune reuses
# already-downloaded tarballs.
RUN --mount=type=cache,target=/root/.npm,id=npm-cache \
    npm prune --omit=dev --ignore-scripts \
 && rm -rf node_modules/prisma \
          node_modules/@prisma/engines \
          node_modules/@prisma/fetch-engine

# ─────────────────────────────────────────────────────────────────────────────
# Stage 6: Minimal production runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app/packages/backend

# Create a dedicated non-root user for the runtime.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 fastify

# Copy the pruned production node_modules + the compiled backend.
COPY --from=prod-deps --chown=fastify:nodejs /app/node_modules              /app/node_modules
COPY --from=prod-deps --chown=fastify:nodejs /app/packages/backend/node_modules ./node_modules
COPY --from=builder   --chown=fastify:nodejs /app/packages/backend/package.json ./package.json
COPY --from=builder   --chown=fastify:nodejs /app/packages/backend/dist          ./dist

USER fastify
EXPOSE 3001

CMD ["node", "dist/index.js"]
