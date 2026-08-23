/**
 * @file server.ts
 * @description tRPC server configuration for Fastify integration with differential synchronization.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { TRPCError } from '@trpc/server';
import { appRouter } from './router.js';
import type { AppRouter } from './router.js';
import { evictionEngine } from '../services/probabilisticEviction.js';
import type { TRPCContext } from './trpc.js';
import { logger } from '../utils/logger.js';
import { etagCachePlugin } from '../plugins/etagCache.js';
import { queryComplexityMiddleware } from './queryComplexityMiddleware.js';
import { deterministicStringify, cyrb53, compare } from './diff.js';
import { safeGet, safeSet } from '../services/cache.js';
import { tokenBucketMiddleware } from './tokenBucketMiddleware.js';
import { streamAsyncEnvelope } from '../utils/streamingJson.js';
import {
  toTRPCError,
  formatTRPCErrorShape,
  trpcCodeToHttpStatus,
} from './errors.js';

const procedures = appRouter._def.procedures as Record<string, unknown>;

// Configure tRPC HTTP handler for Fastify
export async function configureTRPC(server: FastifyInstance) {
  await server.register(etagCachePlugin);

  server.post(
    '/trpc/:path',
    {
      preHandler: [tokenBucketMiddleware, queryComplexityMiddleware],
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { path } = request.params as { path: string };
      const query = request.query as any;
      const isBatch = query.batch === '1';

      // ─── Batch Processing ───────────────────────────────────────────────────
      if (isBatch) {
        const paths = path.split(',');
        const bodies = request.body as Record<string, any>;

        const results = await Promise.all(
          paths.map(async (p, index) => {
            const input = bodies[String(index)];
            const ctx: TRPCContext = {};

            try {
              evictionEngine.recordAccess(`trpc:${p}`);
              const { result } = await handleTRPCRequest(p, input, ctx);
              return { result: { data: result } };
            } catch (error) {
              logger.error({ err: error, path: p }, 'tRPC HTTP batched request failed');
              const trpcErr = toTRPCError(error);
              return { error: formatTRPCErrorShape(trpcErr, p) };
            }
          }),
        );

        return reply.send(results);
      }

      // ─── Single Processing with Diff Sync ───────────────────────────────────
      const body = request.body as any;

      const clientStateHash = request.headers['x-state-hash'] as string | undefined;

      const ctx: TRPCContext = clientStateHash
        ? { stateHash: clientStateHash }
        : {};

      try {
        evictionEngine.recordAccess(`trpc:${path}`);

        const { result, cacheable } = await handleTRPCRequest(path, body, ctx);

        // Streaming branch — bypass differential sync for AsyncIterable results
        if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
          return await streamAsyncEnvelope(
            reply.raw,
            { status: 'full', hash: 'streamed' },
            () => result as AsyncIterable<any>,
          );
        }

        if (cacheable) {
          request.etagCacheable = true;
        }

        const isQuery = cacheable;

        if (isQuery && result && typeof result === 'object') {
          const serialized = deterministicStringify(result);
          const newHash = cyrb53(serialized);

          if (clientStateHash && clientStateHash === newHash) {
            return reply.send({
              status: 'no_change',
              hash: newHash,
            });
          }

          const cacheKey = `state_hash:${newHash}`;
          await safeSet(cacheKey, serialized, 3600);

          if (clientStateHash) {
            const oldStateStr = await safeGet(`state_hash:${clientStateHash}`);
            if (oldStateStr) {
              try {
                const oldState = JSON.parse(oldStateStr);
                const patch = compare(oldState, result);
                return reply.send({
                  status: 'diff',
                  hash: newHash,
                  patch,
                });
              } catch (error) {
                console.warn(
                  `Failed to parse cached state for hash ${clientStateHash}:`,
                  error,
                );
              }
            }
          }

          return reply.send({
            status: 'full',
            hash: newHash,
            data: result,
          });
        }

        return reply.send(result);
      } catch (error) {
        logger.error({ err: error, path }, 'tRPC HTTP request failed');
        const trpcErr = toTRPCError(error);
        const shape = formatTRPCErrorShape(trpcErr, path);
        return reply.status(trpcCodeToHttpStatus(trpcErr.code)).send({ error: shape });
      }
    },
  );
}

async function handleTRPCRequest(
  path: string,
  input: any,
  ctx: TRPCContext,
): Promise<{ result: unknown; cacheable: boolean }> {
  // eslint-disable-next-line security/detect-object-injection
  const procedure = procedures[path] as
    | {
        _def: {
          query?: boolean;
          subscription?: boolean;
          resolver: (opts: {
            ctx: TRPCContext;
            input: unknown;
            signal: AbortSignal;
          }) => unknown;
        };
      }
    | undefined;

  if (!procedure) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Procedure ${path} not found`,
    });
  }

  if (procedure._def.subscription) {
    throw new TRPCError({
      code: 'METHOD_NOT_SUPPORTED',
      message: 'Subscription procedures must be called over WebSocket',
    });
  }

  const result = await procedure._def.resolver({
    ctx,
    input,
    signal: new AbortController().signal,
  });

  return { result, cacheable: procedure._def.query === true };
}

export type { AppRouter };
