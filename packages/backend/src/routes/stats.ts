/**
 * @file stats.ts
 * @description Global ecosystem statistics endpoint.
 *
 * Registered at: /api/stats (see src/index.ts)
 *
 * ## Available Endpoints
 *
 * GET /api/stats/global  — Aggregated platform-wide statistics (1-minute cache)
 * GET /api/stats/tvl     — Total Value Locked across the platform
 */

import type { FastifyPluginAsync } from "fastify";
import { statsController } from "../controllers/statsController.js";

// --- In-memory cache ---------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

let globalStatsCache: CacheEntry<Awaited<ReturnType<typeof statsController.getGlobalStats>>> | null = null;
let tvlCache: CacheEntry<Awaited<ReturnType<typeof statsController.getTVL>>> | null = null;
const CACHE_TTL_MS = 60 * 1000; // 1 minute

// --- Route Plugin ------------------------------------------------------

export const statsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /global
   * Returns aggregated platform statistics, cached for 1 minute.
   *
   * @example
   * GET /api/stats/global
   */
  fastify.get(
    "/global",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              totalOrganizations: { type: "number" },
              totalFundedStroops: { type: "string" },
              totalFundedXlm: { type: "string" },
              totalClaimedStroops: { type: "string" },
              totalClaimedXlm: { type: "string" },
              cachedAt: { type: "string" },
              cacheExpiresAt: { type: "string" },
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
   * Returns Total Value Locked across the platform.
   *
   * Query Parameters:
   *   - format: 'full' returns exact value, 'short' returns abbreviated (e.g., 14.5M)
   *
   * @example
   * GET /api/stats/tvl
   * GET /api/stats/tvl?format=short
   */
  fastify.get(
    "/tvl",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            format: { type: "string", enum: ["full", "short"] },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              tvlUSD: { type: "string" },
              lastUpdated: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const now = Date.now();
      const format = (request.query as { format?: string }).format ?? "full";

      // Cache is per-format, so we check if format matches
      if (tvlCache && now < tvlCache.expiresAt) {
        return reply.send(tvlCache.data);
      }

      const data = await statsController.getTVL(format as "full" | "short");
      tvlCache = { data, expiresAt: now + CACHE_TTL_MS };

      return reply.send(data);
    }
  );

  /**
   * GET /top-maintainers
   * Returns a ranked list of top maintainers by earnings.
   *
   * @example
   * GET /api/stats/top-maintainers
   */
  fastify.get(
    "/top-maintainers",
    {
      schema: {
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                address: { type: "string" },
                totalEarningsXlm: { type: "string" },
                totalEarningsStroops: { type: "string" },
                organizationsAssisted: { type: "number" },
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
};