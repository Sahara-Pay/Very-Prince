/**
 * @file server.ts
 * @description tRPC server configuration for Fastify integration.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { appRouter } from './router.js';
import type { AppRouter } from './router.js';

// Create a simple tRPC HTTP handler for Fastify
export async function configureTRPC(server: FastifyInstance) {
  // Register tRPC routes manually
  server.post('/trpc/:path', {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { path } = request.params as { path: string };
    const body = request.body as any;
    
    try {
      // Simple routing - this is a basic implementation
      // In a real setup, you'd use the proper tRPC handler
      const result = await handleTRPCRequest(path, body);
      return reply.send(result);
    } catch (error) {
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
}

// Basic tRPC request handler (simplified)
async function handleTRPCRequest(path: string, input: any) {
  const pathParts = path.split('.');
  const procedure = pathParts.pop();
  
  // Navigate through the router structure
  let current: any = appRouter;
  for (const part of pathParts) {
    if (current[part]) {
      current = current[part];
    } else {
      throw new Error(`Procedure ${path} not found`);
    }
  }
  
  if (current && procedure && current[procedure]) {
    return await current[procedure](input);
  }
  
  throw new Error(`Procedure ${path} not found`);
}

// Export the router type for frontend usage
export type { AppRouter };
