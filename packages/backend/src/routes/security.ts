/**
 * @file security.ts
 * @description HTTP monitoring endpoint for tRPC deep-nesting attack metrics.
 *
 * Exposes a GET /api/v1/security/metrics endpoint that returns a live snapshot
 * of the securityMetrics singleton.  The endpoint is:
 *
 * - Rate-limited (10 req/min) to prevent the monitoring endpoint itself
 *   from becoming a DoS vector.
 * - Protected by an optional SECURITY_METRICS_TOKEN env var.  When set,
 *   every request must carry  Authorization: Bearer <token>.
 * - Schema-documented for Swagger.
 *
 * A companion GET /api/v1/security/config endpoint surfaces the active
 * security configuration (limits and path overrides) for operator visibility.
 *
 * Both endpoints are intentionally read-only.  Mutations (e.g. resetting
 * counters) are left as an operator-only action to prevent accidental
 * clearance of forensic data.
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { getSecurityMetrics, securityMetrics } from '../trpc/securityMetrics.js';
import { getSecurityConfigSummary } from '../config/securityConfig.js';
import { logger } from '../utils/logger.js';

/**
 * Bearer-token guard.  Returns 401 if SECURITY_METRICS_TOKEN is set and the
 * request does not present it.
 */
function assertBearerToken(request: FastifyRequest, reply: FastifyReply): boolean {
  const token = process.env['SECURITY_METRICS_TOKEN'];
  if (!token) {
    // Token not configured — endpoint is open (acceptable in dev/staging)
    return true;
  }

  const authHeader = request.headers.authorization ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (provided !== token) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Valid Bearer token required' });
    return false;
  }

  return true;
}

export const securityRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /metrics
   * Returns a live snapshot of the security middleware counters.
   *
   * Response shape:
   * {
   *   totalRequests: number,
   *   blockedRequests: number,
   *   blockRate: string,          // e.g. "2.50%"
   *   violations: {
   *     depthExceeded: number,
   *     nodeCountExceeded: number,
   *     arraySizeExceeded: number,
   *     circularReference: number
   *   },
   *   blockedByPath: Record<string, number>,
   *   topBlockedPaths: Array<{ path: string; count: number }>,
   *   metricsAge: { resetAt: string; ageSeconds: number },
   *   collectedAt: string
   * }
   */
  fastify.get(
    '/metrics',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['Security'],
        description: 'Live snapshot of tRPC deep-nesting attack counters.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              totalRequests: { type: 'number' },
              blockedRequests: { type: 'number' },
              blockRate: { type: 'string' },
              violations: {
                type: 'object',
                properties: {
                  depthExceeded: { type: 'number' },
                  nodeCountExceeded: { type: 'number' },
                  arraySizeExceeded: { type: 'number' },
                  circularReference: { type: 'number' },
                },
              },
              blockedByPath: { type: 'object', additionalProperties: { type: 'number' } },
              topBlockedPaths: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    count: { type: 'number' },
                  },
                },
              },
              metricsAge: {
                type: 'object',
                properties: {
                  resetAt: { type: 'string' },
                  ageSeconds: { type: 'number' },
                },
              },
              collectedAt: { type: 'string' },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!assertBearerToken(request, reply)) return;

      const snapshot = getSecurityMetrics();
      const total = snapshot.totalRequests;
      const blocked = snapshot.blockedRequests;
      const blockRate = total > 0
        ? ((blocked / total) * 100).toFixed(2) + '%'
        : '0.00%';

      // Top-5 blocked paths, sorted descending
      const topBlockedPaths = Object.entries(snapshot.blockedByPath)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([path, count]) => ({ path, count }));

      const now = new Date();
      const ageSeconds = Math.floor(
        (now.getTime() - new Date(securityMetrics.resetAt).getTime()) / 1000,
      );

      return reply.code(200).send({
        totalRequests: total,
        blockedRequests: blocked,
        blockRate,
        violations: snapshot.violations,
        blockedByPath: snapshot.blockedByPath,
        topBlockedPaths,
        metricsAge: {
          resetAt: securityMetrics.resetAt.toISOString(),
          ageSeconds,
        },
        collectedAt: now.toISOString(),
      });
    },
  );

  /**
   * GET /config
   * Returns the active security configuration (limits and per-path overrides).
   * Useful for operators to verify which limits are in effect without reading source.
   */
  fastify.get(
    '/config',
    {
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['Security'],
        description: 'Active tRPC deep-nesting security configuration.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              global: {
                type: 'object',
                properties: {
                  maxDepth: { type: 'number' },
                  maxNodes: { type: 'number' },
                  maxArraySize: { type: 'number' },
                  trackPaths: { type: 'boolean' },
                },
              },
              overrideCount: { type: 'number' },
              paths: { type: 'array', items: { type: 'string' } },
            },
          },
          401: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!assertBearerToken(request, reply)) return;
      return reply.code(200).send(getSecurityConfigSummary());
    },
  );
};

/**
 * Logs a periodic security metrics summary to the structured logger.
 * Intended to be called from a cron schedule so CloudWatch / log aggregators
 * can build dashboards and set alarms on blocked request rates.
 *
 * @param thresholdPct - Alert if block rate exceeds this percentage (default 1%)
 */
export function emitSecurityMetricsSummary(thresholdPct = 1): void {
  const snapshot = getSecurityMetrics();
  const total = snapshot.totalRequests;
  const blocked = snapshot.blockedRequests;
  const blockRatePct = total > 0 ? (blocked / total) * 100 : 0;

  const payload = {
    event: 'security_metrics_summary',
    totalRequests: total,
    blockedRequests: blocked,
    blockRatePct: parseFloat(blockRatePct.toFixed(4)),
    violations: snapshot.violations,
    topBlockedPaths: Object.entries(snapshot.blockedByPath)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([path, count]) => ({ path, count })),
    metricsResetAt: securityMetrics.resetAt.toISOString(),
  };

  if (blockRatePct >= thresholdPct) {
    logger.warn(payload, 'Security alert: elevated tRPC block rate detected');
  } else {
    logger.info(payload, 'Security metrics summary');
  }
}
