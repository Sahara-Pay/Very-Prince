import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { appRouter } from './router.js';
import type { AppRouter } from './router.js';

const procedures = appRouter._def.procedures as Record<string, unknown>;

export async function configureTRPC(server: FastifyInstance) {
  server.post('/trpc/:path', {
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
      const result = await handleTRPCRequest(path, body);
      return reply.send(result);
    } catch (error) {
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}

async function handleTRPCRequest(path: string, input: any) {
  // eslint-disable-next-line security/detect-object-injection
  const procedure = procedures[path] as
    | { _def: { subscription?: boolean; resolver: (opts: { ctx: object; input: unknown; signal: AbortSignal }) => unknown } }
    | undefined;

  if (!procedure) {
    throw new Error(`Procedure ${path} not found`);
  }

  if (procedure._def.subscription) {
    throw new Error('Subscription procedures must be called over WebSocket');
  }

  return await procedure._def.resolver({
    ctx: {},
    input,
    signal: new AbortController().signal,
  });
}

export type { AppRouter };
