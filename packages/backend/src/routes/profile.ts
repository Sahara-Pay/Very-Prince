/**
 * @file profile.ts
 * @description Public profile routes for the PayoutRegistry API.
 *
 * Registered at: /api/profile (see src/index.ts)
 *
 * ## Available Endpoints
 *
 * GET /profile/:address/stats — Aggregate historical payout stats for a wallet
 */

import type { FastifyPluginAsync } from "fastify";
import { stellarService } from "../services/stellarService.js";

export const profileRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /profile/:address/stats
   *
   * Returns total XLM earned, orgs funded by, and a payout timeline for any
   * Stellar wallet address. This page is fully public — no auth required.
   *
   * @example
   * GET /api/profile/GABC.../stats
   */
  fastify.get<{ Params: { address: string } }>(
    "/:address/stats",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
      schema: {
        params: {
          type: "object",
          required: ["address"],
          properties: {
            address: {
              type: "string",
              description: "Stellar public key (G...)",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              address: { type: "string" },
              totalStroops: { type: "string" },   // serialised as string (bigint safe)
              totalXlm: { type: "string" },
              orgIds: { type: "array", items: { type: "string" } },
              payouts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    orgId: { type: "string" },
                    amountStroops: { type: "string" },
                    ledger: { type: "number" },
                    ledgerClosedAt: { type: "string" },
                    txHash: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { address } = request.params;

      if (!address.startsWith("G") || address.length !== 56) {
        return reply.status(400).send({ error: "Invalid Stellar address." });
      }

      const stats = await stellarService.readProfileStats(address);

      // BigInt is not JSON-serialisable — convert to string before sending.
      return reply.send({
        ...stats,
        totalStroops: stats.totalStroops.toString(),
        payouts: stats.payouts.map((p) => ({
          ...p,
          amountStroops: p.amountStroops.toString(),
        })),
      });
    }
  );
};