/**
 * @file staleCacheMiddleware.ts
 * @description Type-safe tRPC middleware with stale cache probabilistic eviction.
 *
 * This middleware provides stale-while-revalidate caching for tRPC procedures:
 * - Returns stale data immediately to avoid blocking
 * - Probabilistically refreshes cache in background
 * - Maintains type safety across the tRPC boundary
 * - Integrates with the existing probabilistic eviction engine
 *
 * IMPORTANT: Chain `.input()` before `.use(withStaleCache(...))` so parsed input
 * is available when building the cache key.
 */

import { staleCacheService, type StaleCacheConfig } from "../services/staleCache.js";
import { logger } from "../utils/logger.js";
import { t } from "./trpc.js";

/**
 * Wraps a tRPC query procedure with stale-while-revalidate caching.
 * Mutations bypass the cache entirely.
 *
 * @param buildKey - Function to build cache key from input
 * @param config - Stale cache configuration (optional)
 * @returns tRPC middleware
 */
export function withStaleCache<TInput>(
  buildKey: (input: TInput) => string,
  config?: StaleCacheConfig
) {
  return t.middleware(async ({ next, input, type }: { next: any; input: any; type: string }) => {
    if (type !== "query") {
      return next();
    }

    const key = buildKey(input as TInput);

    try {
      // Use stale cache service for non-blocking reads
      const result = await staleCacheService.get(
        key,
        async () => {
          const procedureResult = await next();
          if (!procedureResult.ok) {
            throw new Error("Procedure failed, cannot cache error");
          }
          return procedureResult.data;
        },
        config
      );

      return {
        ok: true as const,
        data: result as unknown,
        marker: undefined as never,
      };
    } catch (error) {
      logger.error({ err: error, key }, "Stale cache middleware failed, falling through to procedure");
      
      // Fall back to direct procedure call on cache failure
      return next();
    }
  });
}

/**
 * Wraps a tRPC mutation procedure with cache invalidation.
 * Automatically invalidates cache entries after successful mutations.
 *
 * @param buildKey - Function to build cache key from input
 * @returns tRPC middleware
 */
export function withCacheInvalidation<TInput>(
  buildKey: (input: TInput) => string | string[]
) {
  return t.middleware(async ({ next, input, type }: { next: any; input: any; type: string }) => {
    const result = await next();

    // Only invalidate on successful mutations
    if (type === "mutation" && result.ok) {
      try {
        const keys = buildKey(input as TInput);
        const keyArray = Array.isArray(keys) ? keys : [keys];
        
        await Promise.all(
          keyArray.map(key => staleCacheService.invalidate(key))
        );
      } catch (error) {
        logger.error({ err: error }, "Cache invalidation failed");
      }
    }

    return result;
  });
}

/**
 * Combines stale cache for queries with automatic invalidation for mutations.
 * Useful for CRUD operations where mutations should invalidate related query caches.
 *
 * @param buildKey - Function to build cache key from input
 * @param config - Stale cache configuration (optional)
 * @returns Object with query and mutation middleware
 */
export function withStaleCacheAndInvalidation<TInput>(
  buildKey: (input: TInput) => string | string[],
  config?: StaleCacheConfig
) {
  const keyBuilder = typeof buildKey === "function" 
    ? (input: TInput) => {
        const keys = buildKey(input);
        return Array.isArray(keys) ? keys[0]! : keys;
      }
    : buildKey;

  return {
    query: withStaleCache(keyBuilder, config),
    mutation: withCacheInvalidation(buildKey),
  };
}
