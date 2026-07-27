import type { FastifyPluginAsync } from 'fastify';
import { statsController } from '../controllers/statsController.js';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

let globalStatsCache: CacheEntry<Awaited<ReturnType<typeof statsController.getGlobalStats>>> | null = null;
let tvlCache: CacheEntry<Awaited<ReturnType<typeof statsController.getTVL>>> | null = null;
const CACHE_TTL_MS = 60 * 1000;

export const statsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /global
   * Returns platform-wide aggregate statistics including total organizations,
   * funded stroops, and claimed stroops. Results are cached for 60 seconds.
   *
   * @param _request - Fastify request (unused).
   * @param reply - Fastify reply.
   * @returns Global stats object with totals and cache metadata.
   */
  fastify.get(
    '/global',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              totalOrganizations: { type: 'number' },
              totalFundedStroops: { type: 'string' },
              totalFundedXlm: { type: 'string' },
              totalClaimedStroops: { type: 'string' },
              totalClaimedXlm: { type: 'string' },
              cachedAt: { type: 'string' },
              cacheExpiresAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const now = Date.now();
      if (globalStatsCache && now < globalStatsCache.expiresAt) {
        return reply.send(globalStatsCache.data);
      }
      const data = await statsController.getGlobalStats();
      globalStatsCache = { data, expiresAt: now + CACHE_TTL_MS };
      return reply.send(data);
    }
  );

  /**
   * GET /tvl
   * Returns the Total Value Locked (TVL) across all active invoices in USD.
   * Accepts an optional `format` query param (`full` or `short`). Results are
   * cached for 60 seconds.
   *
   * @param request - Fastify request with optional `format` query param.
   * @param reply - Fastify reply.
   * @returns `{ tvlUSD, lastUpdated }`.
   */
  fastify.get(
    '/tvl',
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: '1 minute',
        },
      },
      schema: {
        querystring: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['full', 'short'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              tvlUSD: { type: 'string' },
              lastUpdated: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const now = Date.now();
      const format = (request.query as { format?: string }).format ?? 'full';
      if (tvlCache && now < tvlCache.expiresAt) {
        return reply.send(tvlCache.data);
      }
      const data = await statsController.getTVL(format as 'full' | 'short');
      tvlCache = { data, expiresAt: now + CACHE_TTL_MS };
      return reply.send(data);
    }
  );

  /**
   * GET /top-maintainers
   * Returns the top maintainers ranked by total XLM earnings across all organizations.
   *
   * @param _request - Fastify request (unused).
   * @param reply - Fastify reply.
   * @returns Array of top maintainers with earnings and organization count.
   */
  fastify.get(
    '/top-maintainers',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
      schema: {
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                address: { type: 'string' },
                totalEarningsXlm: { type: 'string' },
                totalEarningsStroops: { type: 'string' },
                organizationsAssisted: { type: 'number' },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const data = await statsController.getTopMaintainers();
      return reply.send(data);
    }
  );

  /**
   * GET /funds-raised
   * Returns the total funds raised across all organisations, derived from a
   * single optimised PostgreSQL aggregation over the `FundingEvent` table.
   *
   * This endpoint replaces the previous N+1 Stellar RPC approach used by
   * `getGlobalStats()` and is the primary resolution for issue #16.
   *
   * Query Parameters:
   *   - fromDate: ISO date string — only include events on/after this date (optional)
   *   - toDate:   ISO date string — only include events on/before this date (optional)
   *
   * @example
   * GET /api/stats/funds-raised
   * GET /api/stats/funds-raised?fromDate=2024-01-01&toDate=2024-12-31
   */
  fastify.get(
    "/funds-raised",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        querystring: {
          type: "object",
          properties: {
            fromDate: { type: "string", format: "date-time" },
            toDate:   { type: "string", format: "date-time" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              totalFundsRaisedStroops: { type: "string" },
              totalFundsRaisedXlm:    { type: "string" },
              totalFundingEvents:     { type: "number" },
              distinctOrgsCount:      { type: "number" },
              fromDate:               { type: "string" },
              toDate:                 { type: "string" },
              cachedAt:               { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { fromDate, toDate } = request.query as {
        fromDate?: string;
        toDate?: string;
      };
      const data = await statsController.getTotalFundsRaised(fromDate, toDate);
      return reply.send(data);
    }
  );

  /**
   * GET /funding-history/:orgId
   * Returns the historical funding events and cumulative funding over time
   * for a specific organization.
   *
   * @param request - Fastify request with orgId parameter
   * @param reply - Fastify reply
   * @returns Array of funding history events with running cumulative totals
   */
  fastify.get<{ Params: { orgId: string } }>(
    "/funding-history/:orgId",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            orgId: { type: "string" },
          },
          required: ["orgId"],
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                orgId: { type: "string" },
                from: { type: "string" },
                amountStroops: { type: "string" },
                amountXlm: { type: "string" },
                cumulativeStroops: { type: "string" },
                cumulativeXlm: { type: "string" },
                txHash: { type: "string" },
                createdAt: { type: "string" },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const data = await statsController.getOrgFundingHistory(orgId);
      return reply.send(data);
    }
  );
};
