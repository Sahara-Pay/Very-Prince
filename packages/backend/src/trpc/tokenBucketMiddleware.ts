/**
 * @file tokenBucketMiddleware.ts
 * @description Fastify preHandler that enforces dynamic token bucket rate limiting
 * for tRPC requests based on computational weight.
 * 
 * This middleware:
 * 1. Extracts the tRPC route path(s) from the request
 * 2. Calculates the total cost based on route weights
 * 3. Checks the token bucket using atomic Redis Lua scripts
 * 4. Returns 429 with Retry-After header if bucket is depleted
 * 
 * Unlike the query complexity middleware (which analyzes input AST), this
 * middleware focuses on route-level cost weights to prevent resource exhaustion
 * across distributed backend instances.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { checkTokenBucket } from '../services/tokenBucketService.js';
import {
  getRouteCostWeight,
  tokenBucketConfig,
  extractIdentifier,
  DEFAULT_ROUTE_WEIGHT,
} from '../config/rateLimitConfig.js';
import { logger } from '../utils/logger.js';

export interface TokenBucketCheckResult {
  routes: Array<{ path: string; weight: number }>;
  totalCost: number;
  identifier: string;
  allowed: boolean;
  remainingTokens: number;
  retryAfter: number;
}

/**
 * Parse batched tRPC route paths from the URL parameter.
 * Example: "organization.get,stats.getTVL" → ["organization.get", "stats.getTVL"]
 */
function parseTRPCPaths(rawPath: string): string[] {
  return rawPath
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Calculate the total cost of a batched tRPC request.
 */
export function calculateRequestCost(rawPath: string): {
  routes: Array<{ path: string; weight: number }>;
  totalCost: number;
} {
  const paths = parseTRPCPaths(rawPath);

  const routes = paths.map((path) => ({
    path,
    weight: getRouteCostWeight(path),
  }));

  const totalCost = routes.reduce((sum, r) => sum + r.weight, 0);

  // If no routes were parsed, default to a single route with default weight
  if (routes.length === 0) {
    return {
      routes: [{ path: rawPath, weight: DEFAULT_ROUTE_WEIGHT }],
      totalCost: DEFAULT_ROUTE_WEIGHT,
    };
  }

  return { routes, totalCost };
}

/**
 * Fastify preHandler middleware that enforces token bucket rate limiting.
 * 
 * Usage:
 * ```typescript
 * server.post('/trpc/:path', {
 *   preHandler: [tokenBucketMiddleware, queryComplexityMiddleware],
 * }, async (request, reply) => { ... });
 * ```
 */
export async function tokenBucketMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Skip if disabled
  if (!tokenBucketConfig.enabled) return;

  const { path } = request.params as { path?: string };
  if (!path) return;

  // Calculate total cost
  const { routes, totalCost } = calculateRequestCost(path);

  // Extract identifier (IP address by default)
  const identifier = extractIdentifier(request);

  // Check token bucket
  const result = await checkTokenBucket(identifier, totalCost, {
    capacity: tokenBucketConfig.capacity,
    refillRate: tokenBucketConfig.refillRate,
    keyPrefix: 'ratelimit:token_bucket',
  });

  // Add rate limit info to response headers (even if allowed)
  reply.header('X-RateLimit-Limit', tokenBucketConfig.capacity.toString());
  reply.header('X-RateLimit-Remaining', Math.floor(result.remainingTokens).toString());
  reply.header('X-RateLimit-Cost', totalCost.toString());

  if (!result.allowed) {
    // Log rejection if enabled
    if (tokenBucketConfig.logRejections) {
      logger.warn(
        {
          event: 'token_bucket_rate_limit_exceeded',
          identifier,
          routes,
          totalCost,
          remainingTokens: result.remainingTokens,
          retryAfter: result.retryAfter,
        },
        'Token bucket rate limit exceeded',
      );
    }

    // Add Retry-After header (RFC 6585)
    reply.header('Retry-After', result.retryAfter.toString());
    reply.header('X-RateLimit-Reset', (Math.floor(Date.now() / 1000) + result.retryAfter).toString());

    // Return 429 with detailed error
    await reply.code(429).send({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. You have consumed ${totalCost} tokens but only ${Math.floor(result.remainingTokens)} remain. Retry after ${result.retryAfter} seconds.`,
      retryAfter: result.retryAfter,
      remainingTokens: Math.floor(result.remainingTokens),
      cost: totalCost,
      routes: routes.map((r) => ({ path: r.path, weight: r.weight })),
    });
  }
}

/**
 * Get current rate limit status for an identifier (debugging/monitoring).
 */
export async function getRateLimitStatus(identifier: string): Promise<{
  identifier: string;
  capacity: number;
  refillRate: number;
  currentTokens: number | null;
  lastRefill: number | null;
} | null> {
  try {
    const { getBucketState } = await import('../services/tokenBucketService.js');
    const state = await getBucketState(identifier, {
      capacity: tokenBucketConfig.capacity,
      refillRate: tokenBucketConfig.refillRate,
      keyPrefix: 'ratelimit:token_bucket',
    });

    if (!state) {
      return {
        identifier,
        capacity: tokenBucketConfig.capacity,
        refillRate: tokenBucketConfig.refillRate,
        currentTokens: null,
        lastRefill: null,
      };
    }

    return {
      identifier,
      capacity: tokenBucketConfig.capacity,
      refillRate: tokenBucketConfig.refillRate,
      currentTokens: state.tokens,
      lastRefill: state.lastRefill,
    };
  } catch (error) {
    logger.error({ err: error, identifier }, 'Failed to get rate limit status');
    return null;
  }
}
