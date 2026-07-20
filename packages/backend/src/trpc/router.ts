/**
 * @file router.ts
 * @description tRPC router definition for the Very-prince backend.
 */

import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { stellarService } from '../services/stellarService.js';
import { safeGet, safeSet } from '../services/cache.js';
import { statsController } from '../controllers/statsController.js';
import { logger } from '../utils/logger.js';

// Create tRPC instance
export const t = initTRPC.create();

// Create the main router
export const appRouter = t.router({
  // Organization related procedures
  organization: t.router({
    get: t.procedure
      .input(z.object({
        id: z.string().min(1).max(32),
      }))
      .query(async ({ input }) => {
        const { id } = input;
        
        // Check cache first (5-second TTL)
        const cacheKey = `org_details:${id}`;
        const cachedResult = await safeGet(cacheKey);
        
        if (cachedResult) {
          try {
            return JSON.parse(cachedResult);
          } catch (error) {
            // Cache corrupted, continue to fetch from contract
            logger.warn({ err: error, cacheKey }, "Cache corruption detected, fetching from contract");
          }
        }

        try {
          // Fetch organization details directly from contract
          const orgDetails = await stellarService.readOrganizationDetails(id);
          
          // Cache the result for 5 seconds
          await safeSet(cacheKey, JSON.stringify(orgDetails), 5);
          
          return orgDetails;
        } catch (error) {
          logger.error({ err: error, orgId: id }, "Failed to fetch organization details from contract");
          
          // Check if it's a "not found" error from the contract
          if (error instanceof Error && error.message.includes("not found")) {
            throw new Error(`Organization with ID '${id}' does not exist in the contract`);
          }
          
          // Generic error
          throw new Error("Unable to query the Soroban contract. Please try again later.");
        }
      }),

    // List organizations (placeholder for now)
    list: t.procedure
      .input(z.object({
        page: z.number().default(1),
        limit: z.number().default(10),
        search: z.string().optional(),
      }))
      .query(async ({ input }) => {
        // This would be implemented to fetch from database or contract
        // For now, return empty result as placeholder
        return {
          data: [],
          meta: {
            totalPages: 0,
            currentPage: input.page,
            totalCount: 0,
          },
        };
      }),

    // Register organization (placeholder for now)
    create: t.procedure
      .input(z.object({
        id: z.string().min(1).max(32),
        name: z.string().min(1).max(100),
        admin: z.string().min(1),
        signerSecret: z.string().min(1),
      }))
      .mutation(async () => {
        // This would be implemented to handle organization creation
        // For now, return placeholder response
        return {
          success: false,
          message: "Organization creation not yet implemented in tRPC",
        };
      }),
  }),

  // Contract related procedures
  contract: t.router({
    getStatus: t.procedure.query(() => ({
      status: 'ok',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    })),

    // Get contract details
    getDetails: t.procedure.query(() => ({
      contractId: 'placeholder-contract-id',
      network: 'testnet',
      lastUpdated: new Date().toISOString(),
    })),
  }),

  // Stats related procedures
  stats: t.router({
    getOverview: t.procedure.query(() => ({
      totalOrganizations: 0,
      totalPayouts: 0,
      totalVolume: '0',
      lastSync: new Date().toISOString(),
    })),
    getFundingHistory: t.procedure
      .input(z.object({
        orgId: z.string().min(1).max(32),
      }))
      .query(async ({ input }) => {
        return statsController.getOrgFundingHistory(input.orgId);
      }),
  }),
});

// Export type for client usage
export type AppRouter = typeof appRouter;
