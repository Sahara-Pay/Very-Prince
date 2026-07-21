# Stage 1: Shared base image
FROM node:20-alpine AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN apk add --no-cache libc6-compat

# Stage 2: Generate a pruned frontend workspace
FROM base AS pruner
RUN npm install -g turbo@2.10.5 && npm cache clean --force

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/types/package.json ./packages/types/package.json
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/docs/package.json ./packages/docs/package.json
RUN turbo prune @very-prince/frontend --docker

# Stage 3: Install dependencies from the pruned lockfile
FROM base AS deps
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm ci --ignore-scripts && npm cache clean --force

# Stage 4: Build the frontend
FROM deps AS builder
COPY tsconfig.base.json turbo.json ./
COPY packages/types ./packages/types
COPY packages/frontend ./packages/frontend
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx turbo run build --filter=@very-prince/frontend...

# Stage 5: Production runtime image (Next standalone output)
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/packages/frontend

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/.next/static ./packages/frontend/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/public ./packages/frontend/public

USER nextjs
EXPOSE 3000

CMD ["node", "packages/frontend/server.js"]