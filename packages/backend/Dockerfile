# Stage 1: Shared base image
FROM node:20-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Required by native packages used by Prisma/Turbo on Alpine.
RUN apk add --no-cache libc6-compat openssl

# Stage 2: Generate a pruned backend workspace
FROM base AS pruner
RUN npm install -g turbo@2.10.5 && npm cache clean --force

# Copy only workspace manifests first so dependency pruning stays cached when
# application source changes.
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/docs/package.json ./packages/docs/package.json
RUN turbo prune @very-prince/backend --docker

# Stage 3: Install dependencies from the pruned lockfile
FROM base AS deps
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm ci --ignore-scripts && npm cache clean --force

# Stage 4: Generate Prisma Client and build the backend
FROM deps AS builder
COPY tsconfig.base.json turbo.json ./
COPY packages/types ./packages/types
COPY packages/backend ./packages/backend

# turbo prune drops a couple of transitive type packages needed only to compile.
RUN npm install --no-save --ignore-scripts @types/urijs @types/json-schema \
  && npm cache clean --force
RUN npx prisma generate --schema=packages/backend/prisma/schema.prisma
RUN npx turbo run build --filter=@very-prince/backend...

# Stage 5: Prune build-time dependencies from node_modules
FROM builder AS prod-deps
ENV NODE_ENV=production
RUN npm prune --omit=dev --ignore-scripts \
  && rm -rf node_modules/prisma node_modules/@prisma/engines \
    node_modules/@prisma/fetch-engine \
  && npm cache clean --force

# Stage 6: Production runtime image
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app/packages/backend

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 fastify

COPY --from=prod-deps --chown=fastify:nodejs /app/node_modules /app/node_modules
COPY --from=prod-deps --chown=fastify:nodejs /app/packages/backend/node_modules ./node_modules
COPY --from=builder --chown=fastify:nodejs /app/packages/backend/package.json ./package.json
COPY --from=builder --chown=fastify:nodejs /app/packages/backend/dist ./dist

USER fastify

EXPOSE 3001

CMD ["node", "dist/index.js"]
