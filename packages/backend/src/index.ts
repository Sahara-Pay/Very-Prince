/**
 * @file index.ts
 * @description Fastify server entry point for the Very-prince backend.
 *
 * This file is responsible for:
 *  1. Creating the Fastify instance with sensible defaults.
 *  2. Registering plugins (CORS, Helmet, etc.).
 *  3. Mounting route plugins under versioned prefixes.
 *  4. Starting the HTTP server.
 *
 * ## Architecture
 *
 * ```
 * index.ts (bootstrap)
 *   └─ routes/contract.ts (route plugin)
 *       └─ controllers/contractController.ts (business logic)
 *           └─ services/stellarService.ts (Stellar SDK + Soroban RPC)
 *               └─ config/env.ts (environment)
 * ```
 */

import Fastify from "fastify";
import { profileRoutes } from "./routes/profile.js";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { SERVER_HOST, SERVER_PORT } from "./config/env.js";
import { contractRoutes } from "./routes/contract.js";
import rateLimit from "@fastify/rate-limit";
import { errorHandler } from "./plugins/errorHandler.js";
import { statsRoutes } from "./routes/stats.js";
import { tokenRoutes } from "./routes/token.js";
import { eventsRoutes } from "./routes/events.js";
import { organizationRoutes } from "./routes/organization.js";
import { authRoutes } from "./routes/auth.js";
import { webhookRoutes } from "./routes/webhook.js";
import { apiKeyRoutes } from "./routes/apiKeys.js";
import { healthRoutes } from "./routes/health.js";
import { indexerService } from "./services/indexerService.js";
import { notificationController } from "./controllers/notificationController.js";
import { configureTRPC } from "./trpc/server.js";
import { webhookWorker } from "./workers/WebhookWorker.js";

// Sentry initialization
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

// Initialize Sentry only in production and when DSN is available
if (process.env.NODE_ENV === "production" && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [
      nodeProfilingIntegration(),
    ],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
  });
}

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = Fastify({
  logger: {
    level: process.env["NODE_ENV"] === "production" ? "warn" : "info",
    transport:
      process.env["NODE_ENV"] !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any,
});

// ─── Plugin Registration ──────────────────────────────────────────────────────

// Security headers — important even for internal APIs.
await server.register(helmet, {
  contentSecurityPolicy: false, // relaxed for development; tighten for production
});

await server.register(rateLimit, {
  global: true,
  max: 100,
  timeWindow: "1 minute",
  addHeaders: {
    "x-ratelimit-limit": true,
    "x-ratelimit-remaining": true,
    "x-ratelimit-reset": true,
    "retry-after": true,
  },
  errorResponseBuilder: (_req, context) => ({
    statusCode: 429,
    error: "Too Many Requests",
    message: `Rate limit exceeded. Retry after ${context.after}.`,
  }),
});

// CORS — allows the Next.js frontend (port 3000) to call this API.
await server.register(cors, {
  origin:
    process.env["NODE_ENV"] === "production"
      ? process.env["FRONTEND_URL"] ?? false // restrict in production
      : true, // allow all origins in development
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

await server.register(errorHandler);

// ─── Swagger Documentation ─────────────────────────────────────────────────────

await server.register(swagger, {
  swagger: {
    info: {
      title: 'Very Prince API',
      description: 'Multi-organization maintenance payout infrastructure on the Stellar network',
      version: '0.1.0',
    },
    host: `${SERVER_HOST}:${SERVER_PORT}`,
    schemes: ['http', 'https'],
    consumes: ['application/json'],
    produces: ['application/json'],
    tags: [
      { name: 'Organizations', description: 'Organization management endpoints' },
      { name: 'Contracts', description: 'Smart contract interactions' },
      { name: 'Profiles', description: 'User profile management' },
      { name: 'Tokens', description: 'Token operations' },
      { name: 'Auth', description: 'Authentication endpoints' },
      { name: 'Stats', description: 'Statistics and analytics' },
      { name: 'Events', description: 'Event tracking' },
      { name: 'Webhooks', description: 'Webhook management' },
      { name: 'Health', description: 'Service health and uptime' },
    ],
  },
});

await server.register(swaggerUi, {
  routePrefix: '/api/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: false,
  },
  uiHooks: {
    onRequest: function (_request, _reply, next) { next() },
    preHandler: function (_request, _reply, next) { next() },
  },
  staticCSP: true,
  transformStaticCSP: (header) => header,
});

// ─── Route Registration ───────────────────────────────────────────────────────

/**
 * All contract-related routes are mounted under versioned prefixes.
 * 
 * Versioning Strategy:
 * - /api/v1/...: Standard versioned API endpoints.
 * - /api/stats/...: Unversioned endpoints for global platform statistics.
 * - /api/events/...: Unversioned endpoints for event stream consumption.
 * 
 * Each route plugin is responsible for its own validation schemas and controllers.
 */

// All contract-related routes are mounted under /api/v1/contract.
// The v1 prefix supports future API versioning without breaking changes.
await server.register(contractRoutes, { prefix: "/api/v1/contract" });
await server.register(profileRoutes, { prefix: "/api/v1/profile" });
await server.register(tokenRoutes, { prefix: "/api/v1/tokens" });
await server.register(authRoutes, { prefix: "/api/v1/auth" });

await server.register(statsRoutes, { prefix: "/api/stats" });
await server.register(eventsRoutes, { prefix: "/api/events" });
await server.register(organizationRoutes, { prefix: "/api/org" });
await server.register(webhookRoutes, { prefix: "/api/org/:orgId/webhook" });
await server.register(apiKeyRoutes, { prefix: "/api/org" });
await server.register(healthRoutes, { prefix: "/health" });

// Configure tRPC routes manually
await configureTRPC(server);

// ─── Notification Routes ──────────────────────────────────────────────────────

/**
 * Notification management endpoints.
 * 
 * These endpoints handle user preferences for off-chain notifications (Email, etc.)
 * based on on-chain activity.
 */
server.post("/api/v1/notifications/preferences", notificationController.saveEmailPreference);
server.delete("/api/v1/notifications/preferences", notificationController.deleteEmailPreference);
server.get("/api/v1/notifications/unsubscribe", notificationController.unsubscribe);

/**
 * System Health & Diagnostics
 */

// Indexer status endpoint
server.get("/indexer/status", async () => {
  return indexerService.getStatus();
});

// Manual sync trigger endpoint (for testing/admin)
server.post("/indexer/sync", async () => {
  await indexerService.triggerSync();
  return { message: "Sync triggered" };
});

// ─── Start ───────────────────────────────────────────────────────────────────

try {
  await server.listen({ port: SERVER_PORT, host: SERVER_HOST });
  server.log.info(
    `Very-prince backend listening on http://${SERVER_HOST}:${SERVER_PORT}`
  );
  
  // Start the background indexer service
  indexerService.start();
  
  // Graceful shutdown
  const gracefulShutdown = async (signal: string) => {
    server.log.info(`Received ${signal}, shutting down gracefully...`);
    indexerService.stop();
    await webhookWorker.stop();
    server.close(() => {
      server.log.info('Server closed');
      process.exit(0);
    });
  };
  
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
