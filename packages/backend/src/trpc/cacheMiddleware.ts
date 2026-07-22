/**
 * @file cacheMiddleware.ts
 * @description Type-safe tRPC middleware that serves query results from ephemeral Redis cache.
 *
 * IMPORTANT: Chain `.input()` before `.use(withTrpcCache(...))` so parsed input
 * is available when building the cache key.
 */

import { safeGet, safeSet } from "../services/cache.js";
import { logger } from "../utils/logger.js";
import { t } from "./trpc.js";

/**
 * Wraps a tRPC query procedure with Redis read-through caching.
 * Mutations bypass the cache entirely.
 */
export function withTrpcCache<TInput>(
  buildKey: (input: TInput) => string,
  ttlSeconds: number,
) {
  return t.middleware(async ({ next, input, type }) => {
    if (type !== "query") {
      return next();
    }

    const key = buildKey(input as TInput);
    const cached = await safeGet(key);
    if (cached !== null) {
      try {
        return {
          ok: true as const,
          data: JSON.parse(cached) as unknown,
          marker: undefined as never,
        };
      } catch (error) {
        logger.warn({ err: error, key }, "tRPC cache corruption detected");
      }
    }

    const result = await next();
    if (result.ok) {
      void safeSet(key, JSON.stringify(result.data), ttlSeconds);
    }
    return result;
  });
}
