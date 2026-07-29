/**
 * @file server.ts
 * @description tRPC server configuration for Fastify integration with differential synchronization.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
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

const procedures = appRouter._def.procedures as Record<string, unknown>;

// Configure tRPC HTTP handler for Fastify
export async function configureTRPC(server: FastifyInstance) {
  await server.register(etagCachePlugin);

  server.post('/trpc/:path', {
    preHandler: [tokenBucketMiddleware, queryComplexityMiddleware],
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { path } = request.params as { path: string };
    const query = request.query as any;
    const isBatch = query.batch === '1';

    // ─── Batch Processing ───────────────────────────────────────────────────
    if (isBatch) {
      const paths = path.split(',');
      const bodies = request.body as Record<string, any>; // tRPC passes batch payload as an object map

      const results = await Promise.all(paths.map(async (p, index) => {
        const input = bodies[String(index)];
        // Skip diff sync for batched requests by not passing state hash
        const ctx: TRPCContext = {};

        try {
          evictionEngine.recordAccess(`trpc:${p}`);
          const { result } = await handleTRPCRequest(p, input, ctx);
          // Standard tRPC batch response format
          return { result: { data: result } };
        } catch (error) {
          logger.error({ err: error, path: p }, 'tRPC HTTP batched request failed');
          return { error: { message: error instanceof Error ? error.message : 'Unknown error' } };
        }
      }));

      return reply.send(results);
    }

    // ─── Single Processing with Diff Sync ───────────────────────────────────
    const body = request.body as any;
    
    // Extract the client's last known state hash from the custom header
    const clientStateHash = request.headers['x-state-hash'] as string | undefined;
    
    const ctx: TRPCContext = clientStateHash !== undefined 
      ? { stateHash: clientStateHash } 
      : {};
    const ctx: TRPCContext = clientStateHash ? { stateHash: clientStateHash } : {};
    
    try {
      // Record the query path in the eviction engine so the sketch learns
      // which procedures are hot across the entire tRPC surface.
      evictionEngine.recordAccess(`trpc:${path}`);
      
      const { result, cacheable } = await handleTRPCRequest(path, body, ctx);
      
      // ─── Streaming Branch ───────────────────────────────────────────────────
      // If the result is an AsyncIterable (e.g. from getOrgFundingHistoryStream),
      // we bypass differential sync and stream the response directly to the buffer.
      // This prevents OOM on massive ledger histories.
      if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
        return await streamAsyncEnvelope(
          reply.raw,
          { status: 'full', hash: 'streamed' },
          () => result as AsyncIterable<any>
        );
      }

      // Only queries are safe to serve as 304 Not Modified: mutations must
      // always return their actual result body to the caller.
      if (cacheable) {
        request.etagCacheable = true;
      }
      
      // We only apply differential sync to query procedures (cacheable queries)
      // and only when the result is a non-null object.
      const isQuery = cacheable;
      
      if (isQuery && result && typeof result === 'object') {
        const serialized = deterministicStringify(result);
        const newHash = cyrb53(serialized);
        
        // 1. Check if the client's state is already identical to the current state
        if (clientStateHash && clientStateHash === newHash) {
          return reply.send({
            status: 'no_change',
            hash: newHash,
          });
        }
        
        // 2. Cache the new state in Redis for future diff comparisons (1 hour TTL)
        const cacheKey = `state_hash:${newHash}`;
        await safeSet(cacheKey, serialized, 3600);
        
        // 3. If client sent a hash, look up the old state and compute the patch
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
              console.warn(`Failed to parse cached state for hash ${clientStateHash}:`, error);
              // Fall back to full payload transmission
            }
          }
        }
        
        // 4. Return full payload if client had a cache miss or is a new session
        return reply.send({
          status: 'full',
          hash: newHash,
          data: result,
        });
      }
      
      // Return standard result for primitive/mutation responses
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

// Basic tRPC request handler utilizing AppRouter's procedures
async function handleTRPCRequest(
  path: string,
  input: any,
  ctx: TRPCContext
): Promise<{ result: unknown; cacheable: boolean }> {
  // eslint-disable-next-line security/detect-object-injection
  const procedure = procedures[path] as
    | {
        _def: {
          query?: boolean;
          subscription?: boolean;
          resolver: (opts: { ctx: TRPCContext; input: unknown; signal: AbortSignal }) => unknown;
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
    ctx,
    input,
    signal: new AbortController().signal,
  });

  return { result, cacheable: procedure._def.query === true };
}

// Export the router type for frontend usage
export type { AppRouter };
