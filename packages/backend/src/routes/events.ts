import type { FastifyPluginAsync } from 'fastify';
import {
  addSSEConnection,
  emitSSEEvent,
  removeSSEConnection,
} from '../services/sse.js';

export { emitSSEEvent };

export const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /stream
   * Opens a Server-Sent Events (SSE) connection for real-time event streaming.
   *
   * Emits a `connected` event on handshake and a `heartbeat` event every 30 seconds
   * to keep the connection alive. The connection is cleaned up automatically when
   * the client disconnects.
   *
   * @param request - Fastify request.
   * @param reply - Fastify reply used as a raw SSE stream.
   * @returns An open SSE stream (does not resolve until the client disconnects).
   */
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

      addSSEConnection(reply.raw);
      reply.raw.write('event: connected\ndata: ' + JSON.stringify({ timestamp: Date.now() }) + '\n\n');

      request.raw.on('close', () => {
        removeSSEConnection(reply.raw);
      });

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write('event: heartbeat\ndata: ' + JSON.stringify({ timestamp: Date.now() }) + '\n\n');
        } catch {
          clearInterval(heartbeat);
          removeSSEConnection(reply.raw);
        }
      }, 30000);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
      });

      return reply;
    }
  );
};
