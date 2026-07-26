import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { appRouter } from './router.js';
import type { AppRouter } from './router.js';
import { logger } from '../utils/logger.js';
import { etagCachePlugin } from '../plugins/etagCache.js';
import { queryComplexityMiddleware } from './queryComplexityMiddleware.js';

const procedures = appRouter._def.procedures as Record<string, unknown>;

export async function configureTRPC(server: FastifyInstance) {
  await server.register(etagCachePlugin);

  server.post('/trpc/:path', {
    preHandler: queryComplexityMiddleware,
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { path } = request.params as { path: string };
    const body = request.body as any;

    try {
      const { result, cacheable } = await handleTRPCRequest(path, body);
      // Only queries are safe to serve as 304 Not Modified: mutations must
      // always return their actual result body to the caller.
      if (cacheable) {
        request.etagCacheable = true;
      }
      return reply.send(result);
    } catch (error) {
      logger.error({ err: error, path }, 'tRPC HTTP request failed');
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}

async function handleTRPCRequest(
  path: string,
  input: any,
): Promise<{ result: unknown; cacheable: boolean }> {
  // eslint-disable-next-line security/detect-object-injection
  const procedure = procedures[path] as
    | {
        _def: {
          query?: boolean;
          subscription?: boolean;
          resolver: (opts: { ctx: object; input: unknown; signal: AbortSignal }) => unknown;
        };
      }
    | undefined;

  if (!procedure) {
    throw new Error(`Procedure ${path} not found`);
  }

  if (procedure._def.subscription) {
    throw new Error('Subscription procedures must be called over WebSocket');
  }

  const result = await procedure._def.resolver({
    ctx: {},
    input,
    signal: new AbortController().signal,
  });

  return { result, cacheable: procedure._def.query === true };
}

export type { AppRouter };
