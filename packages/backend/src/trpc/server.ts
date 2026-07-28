/**
 * @file server.ts
 * @description tRPC server configuration for Fastify integration.
 */

import type { FastifyInstance } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { appRouter } from './router.js';
import type { AppRouter } from './router.js';

// Configure tRPC HTTP handler for Fastify
export async function configureTRPC(server: FastifyInstance) {
  // Register the official tRPC Fastify plugin
  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: () => ({}), // Empty context as currently defined
    },
  });
}

// Export the router type for frontend usage
export type { AppRouter };
