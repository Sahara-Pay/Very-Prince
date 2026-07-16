import type { FastifyPluginAsync } from 'fastify';
import { analyticsController } from '../controllers/analyticsController.js';

export const analyticsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/leaderboard',
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
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rank: { type: 'integer' },
                walletAddress: { type: 'string' },
                truncatedAddress: { type: 'string' },
                volumeUSD: { type: 'number' },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const result = await analyticsController.getLeaderboard();
      return reply.send(result);
    }
  );
};
