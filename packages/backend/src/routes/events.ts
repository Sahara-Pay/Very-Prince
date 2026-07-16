import type { FastifyPluginAsync } from 'fastify';
import { emitSSEEvent } from '../services/sse.ts';

const sseConnections = new Set<any>();

export { emitSSEEvent };

export const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/stream',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    (request, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control',
      });

      sseConnections.add(reply.raw);
      reply.raw.write('event: connected\ndata: ' + JSON.stringify({ timestamp: Date.now() }) + '\n\n');

      request.raw.on('close', () => {
        sseConnections.delete(reply.raw);
      });

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write('event: heartbeat\ndata: ' + JSON.stringify({ timestamp: Date.now() }) + '\n\n');
        } catch {
          clearInterval(heartbeat);
          sseConnections.delete(reply.raw);
        }
      }, 30000);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
      });

      return reply;
    }
  );
};
