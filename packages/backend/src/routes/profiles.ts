import type { FastifyPluginAsync } from 'fastify';
import { stellarService } from '../services/stellarService.js';

export const profileRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /:address/stats
   * Returns aggregate payout statistics for a Stellar wallet address.
   *
   * @param request - Fastify request containing `address` path parameter.
   * @param reply - Fastify reply.
   * @returns Payout history including total stroops, total XLM, org IDs, and individual payout records.
   */
  fastify.get(
    "/:address/stats",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const { address } = (request.params as { address: string });
      try {
        const stats = await stellarService.readProfileStats(address);
        return reply.send({
          address: stats.address,
          totalStroops: stats.totalStroops.toString(),
          totalXlm: stats.totalXlm,
          orgIds: stats.orgIds,
          payouts: stats.payouts.map((p) => ({
            orgId: p.orgId,
            amountStroops: p.amountStroops.toString(),
            ledger: p.ledger,
            ledgerClosedAt: p.ledgerClosedAt,
            txHash: p.txHash,
          })),
        });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: 'Failed to fetch profile stats' });
      }
    }
  );
};
