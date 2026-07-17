import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { SERVER_HOST, SERVER_PORT } from './config/env.js';
import { errorHandler } from './plugins/errorHandler.js';
import { contractRoutes } from './routes/contract.js';
import { profileRoutes } from './routes/profile.js';
import { statsRoutes } from './routes/stats.js';
import { tokenRoutes } from './routes/token.js';
import { eventsRoutes } from './routes/events.js';
import { organizationRoutes } from './routes/organization.js';
import { authRoutes } from './routes/auth.js';
import { webhookRoutes } from './routes/webhook.js';
import { apiKeyRoutes } from './routes/apiKeys.js';
import { exportRoutes } from './routes/export.js';
import { analyticsRoutes } from './routes/analytics.js';
import { indexerService } from './services/indexerService.js';
import { notificationController } from './controllers/notificationController.js';
import { configureTRPC } from './trpc/server.js';
import { webhookWorker } from './workers/WebhookWorker.js';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

if (process.env.NODE_ENV === 'production' && process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
  });
}

const server = Fastify({
  logger: {
    level: process.env['NODE_ENV'] === 'production' ? 'warn' : 'info',
    transport: process.env['NODE_ENV'] !== 'production' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  } as any,
});

await server.register(helmet, { contentSecurityPolicy: false });

await server.register(rateLimit, {
  global: false,
  errorResponseBuilder: (_req, context) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: 'Rate limit exceeded. Retry after ' + context.after + '.',
  }),
});

await server.register(cors, {
  origin: process.env['NODE_ENV'] === 'production' ? process.env['FRONTEND_URL'] ?? false : true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

await server.register(errorHandler);

await server.register(swagger, {
  swagger: {
    info: { title: 'Very Prince API', description: 'Multi-organization maintenance payout infrastructure on the Stellar network', version: '0.1.0' },
    host: SERVER_HOST + ':' + SERVER_PORT,
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
  uiConfig: { docExpansion: 'list', deepLinking: false },
  uiHooks: { onRequest: function (_request, _reply, next) { next() }, preHandler: function (_request, _reply, next) { next() } },
  staticCSP: true,
  transformStaticCSP: (header) => header,
});

await server.register(contractRoutes, { prefix: '/api/v1/contract' });
await server.register(profileRoutes, { prefix: '/api/v1/profile' });
await server.register(tokenRoutes, { prefix: '/api/v1/tokens' });
await server.register(authRoutes, { prefix: '/api/v1/auth' });
await server.register(statsRoutes, { prefix: '/api/stats' });
await server.register(eventsRoutes, { prefix: '/api/events' });
await server.register(organizationRoutes, { prefix: '/api/org' });
await server.register(webhookRoutes, { prefix: '/api/org/:orgId/webhook' });
await server.register(apiKeyRoutes, { prefix: '/api/org' });
await server.register(exportRoutes, { prefix: '/api/export' });
await server.register(analyticsRoutes, { prefix: '/api/v1/analytics' });

await configureTRPC(server);

server.post('/api/v1/notifications/preferences', {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
    },
  },
}, notificationController.saveEmailPreference);
server.delete('/api/v1/notifications/preferences', {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
    },
  },
}, notificationController.deleteEmailPreference);
server.get('/api/v1/notifications/unsubscribe', {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: '1 minute',
    },
  },
}, notificationController.unsubscribe);

server.get('/health', async () => ({ status: 'ok', version: '0.1.0', timestamp: new Date().toISOString(), uptime: process.uptime() }));
server.get('/indexer/status', {
  config: {
    rateLimit: {
      max: 60,
      timeWindow: '1 minute',
    },
  },
}, async () => indexerService.getStatus());
server.post('/indexer/sync', {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
    },
  },
}, async () => { await indexerService.triggerSync(); return { message: 'Sync triggered' }; });

try {
  await server.listen({ port: SERVER_PORT, host: SERVER_HOST });
  server.log.info('Very-prince backend listening on http://' + SERVER_HOST + ':' + SERVER_PORT);
  indexerService.start();
  const gracefulShutdown = async (signal: string) => {
    server.log.info('Received ' + signal + ', shutting down gracefully...');
    indexerService.stop();
    await webhookWorker.stop();
    server.close(() => { server.log.info('Server closed'); process.exit(0); });
  };
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
