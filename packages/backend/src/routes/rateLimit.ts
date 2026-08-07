/**
 * @file rateLimit.ts
 * @description REST endpoints for monitoring and managing rate limits.
 */

import type { FastifyInstance } from 'fastify';
import { getBucketState, resetBucket } from '../services/tokenBucketService.js';
import { tokenBucketConfig, extractIdentifier } from '../config/rateLimitConfig.js';
import { logger } from '../utils/logger.js';

export async function rateLimitRoutes(server: FastifyInstance) {
  /**
   * GET /rate-limit/status
   * Check current rate limit status for the requesting client.
   */
  server.get('/rate-limit/status', async (request, reply) => {
    try {
      const identifier = extractIdentifier(request);
      const state = await getBucketState(identifier, {
        capacity: tokenBucketConfig.capacity,
        refillRate: tokenBucketConfig.refillRate,
        keyPrefix: 'ratelimit:token_bucket',
      });

      if (!state) {
        return reply.send({
          identifier,
          status: 'fresh',
          capacity: tokenBucketConfig.capacity,
          refillRate: tokenBucketConfig.refillRate,
          currentTokens: tokenBucketConfig.capacity,
          message: 'No requests recorded yet for this identifier',
        });
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const elapsed = Math.max(0, currentTime - state.lastRefill);
      const tokensRefilled = elapsed * tokenBucketConfig.refillRate;
      const estimatedTokens = Math.min(
        tokenBucketConfig.capacity,
        state.tokens + tokensRefilled
      );

      return reply.send({
        identifier,
        status: 'active',
        capacity: tokenBucketConfig.capacity,
        refillRate: tokenBucketConfig.refillRate,
        currentTokens: Math.floor(estimatedTokens),
        lastRefill: new Date(state.lastRefill * 1000).toISOString(),
        secondsSinceLastRefill: elapsed,
        utilization: `${(((tokenBucketConfig.capacity - estimatedTokens) / tokenBucketConfig.capacity) * 100).toFixed(1)}%`,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get rate limit status');
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to retrieve rate limit status',
      });
    }
  });

  /**
   * POST /rate-limit/reset
   * Reset rate limit for the requesting client (requires admin authentication).
   */
  server.post('/rate-limit/reset', {
    config: {
      // This endpoint should be protected with authentication
      // Add your auth middleware here
    },
  }, async (request, reply) => {
    try {
      const identifier = extractIdentifier(request);
      
      await resetBucket(identifier, {
        capacity: tokenBucketConfig.capacity,
        refillRate: tokenBucketConfig.refillRate,
        keyPrefix: 'ratelimit:token_bucket',
      });

      logger.info({ identifier }, 'Rate limit reset');

      return reply.send({
        success: true,
        message: `Rate limit reset for identifier: ${identifier}`,
        identifier,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to reset rate limit');
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to reset rate limit',
      });
    }
  });

  /**
   * GET /rate-limit/config
   * Get current rate limit configuration.
   */
  server.get('/rate-limit/config', async (_request, reply) => {
    return reply.send({
      enabled: tokenBucketConfig.enabled,
      capacity: tokenBucketConfig.capacity,
      refillRate: tokenBucketConfig.refillRate,
      refillRatePerMinute: tokenBucketConfig.refillRate * 60,
      logRejections: tokenBucketConfig.logRejections,
      timeToFullRefill: `${Math.ceil(tokenBucketConfig.capacity / tokenBucketConfig.refillRate)} seconds`,
      description: 'Token bucket rate limiter with dynamic cost weights',
    });
  });
}
