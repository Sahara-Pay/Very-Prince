/**
 * @file router.ts
 * @description tRPC router definition for the Very-prince backend.
 */

import { z } from 'zod';
import { stellarService } from '../services/stellarService.js';
import { safeGet, safeSet } from '../services/cache.js';
import { evictionEngine } from '../services/probabilisticEviction.js';
import { statsController } from '../controllers/statsController.js';
import { analyticsController } from '../controllers/analyticsController.js';
import { logger } from '../utils/logger.js';
import { t } from './trpc.js';
import { withTrpcCache } from './cacheMiddleware.js';
import { TRPC_CACHE_TTL, trpcCacheKeys } from './cacheKeys.js';
import { organizationService } from '../services/organizationService.js';
import {
  fundOrgInputSchema,
  allocatePayoutInputSchema,
  claimPayoutInputSchema,
} from "../schemas/transactionSchemas.js";
import { syncRouter } from './syncRouter.js';
import { subscriptionRouter } from './subscriptions.js';

export { t };

export const appRouter = t.router({
  organization: t.router({
    get: t.procedure
      .input(z.object({
        id: z.string().min(1).max(32),
      }))
      .use(withTrpcCache(
        (input: { id: string }) => trpcCacheKeys.organizationGet(input.id),
        TRPC_CACHE_TTL.ORG_DETAILS,
      ))
      .query(async ({ input }) => {
        const { id } = input;
        
        // Check cache first (5-second base TTL, adaptive for hot keys)
        const cacheKey = `org_details:${id}`;
        const cachedResult = await safeGet(cacheKey);
        
        if (cachedResult) {
          // Record this access so the eviction engine promotes the key
          evictionEngine.recordAccess(cacheKey);
          try {
            return JSON.parse(cachedResult);
          } catch (error) {
            // Cache corrupted, continue to fetch from contract
            console.warn(`Cache corruption for key ${cacheKey}:`, error);
          }
        }

        try {
          // Fetch organization details directly from contract
          const orgDetails = await stellarService.readOrganizationDetails(id);
          
          // Record the access AND get an adaptive TTL in one call.
          // The eviction engine increments the sketch counter *before*
          // computing the TTL so that cache misses still contribute to
          // the frequency estimate.
          const adaptiveTTL = evictionEngine.recordAndGetTTL(cacheKey, 5);
          await safeSet(cacheKey, JSON.stringify(orgDetails), adaptiveTTL);
          
          return orgDetails;

        try {
          return await stellarService.readOrganizationDetails(id);
        } catch (error) {
          logger.error({ err: error, orgId: id }, "Failed to fetch organization details from contract");

          if (error instanceof Error && error.message.includes("not found")) {
            throw new Error(`Organization with ID '${id}' does not exist in the contract`);
          }

          throw new Error("Unable to query the Soroban contract. Please try again later.");
        }
      }),

    list: t.procedure
      .input(z.object({
        cursor: z.string().optional(),
        limit: z.number().default(10),
        search: z.string().optional(),
      }))
      .query(async ({ input }) => {
        return await organizationService.getOrganizationsCursor(
          input.cursor,
          input.limit,
          input.search
        );
      }),

    create: t.procedure
      .input(z.object({
        id: z.string().min(1).max(32),
        name: z.string().min(1).max(100),
        admin: z.string().min(1),
        signerSecret: z.string().min(1),
      }))
      .mutation(async () => {
        return {
          success: false,
          message: "Organization creation not yet implemented in tRPC",
        };
      }),
  }),

  contract: t.router({
    getStatus: t.procedure.query(() => ({
      status: 'ok',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    })),

    getDetails: t.procedure.query(() => ({
      contractId: 'placeholder-contract-id',
      network: 'testnet',
      lastUpdated: new Date().toISOString(),
    })),
  }),

  stats: t.router({
    getGlobalStats: t.procedure
      .use(withTrpcCache(() => trpcCacheKeys.statsGlobal(), TRPC_CACHE_TTL.STATS_GLOBAL))
      .query(() => statsController.getGlobalStats()),

    getTVL: t.procedure
      .input(z.object({
        format: z.enum(["full", "short"]).default("full"),
      }))
      .use(withTrpcCache(
        (input: { format: "full" | "short" }) => trpcCacheKeys.statsTvl(input.format),
        TRPC_CACHE_TTL.STATS_TVL,
      ))
      .query(({ input }) => statsController.getTVL(input.format)),

    getTotalFundsRaised: t.procedure
      .input(z.object({
        fromDate: z.string().datetime().optional(),
        toDate: z.string().datetime().optional(),
      }))
      .use(withTrpcCache(
        (input: { fromDate?: string; toDate?: string }) =>
          trpcCacheKeys.statsFundsRaised(input.fromDate, input.toDate),
        TRPC_CACHE_TTL.STATS_FUNDS_RAISED,
      ))
      .query(({ input }) => statsController.getTotalFundsRaised(input.fromDate, input.toDate)),

    getTopMaintainers: t.procedure
      .use(withTrpcCache(() => trpcCacheKeys.statsTopMaintainers(), TRPC_CACHE_TTL.STATS_TOP_MAINTAINERS))
      .query(() => statsController.getTopMaintainers()),

    getFundingHistory: t.procedure
      .input(z.object({
        orgId: z.string().min(1).max(32),
      }))
      .use(withTrpcCache(
        (input: { orgId: string }) => trpcCacheKeys.statsFundingHistory(input.orgId),
        TRPC_CACHE_TTL.STATS_FUNDING_HISTORY,
      ))
      .query(({ input }) => statsController.getOrgFundingHistory(input.orgId)),
  }),

  analytics: t.router({
    getLeaderboard: t.procedure
      .use(withTrpcCache(() => trpcCacheKeys.analyticsLeaderboard(), TRPC_CACHE_TTL.ANALYTICS_LEADERBOARD))
      .query(() => analyticsController.getLeaderboard()),
  }),

  events: subscriptionRouter,

  transaction: t.router({
    validateFundOrg: t.procedure
      .input(fundOrgInputSchema)
      .mutation(async ({ input }) => {
        await stellarService.readOrganizationDetails(input.orgId);
        return { valid: true };
      }),

    validateAllocatePayout: t.procedure
      .input(allocatePayoutInputSchema)
      .mutation(async ({ input }) => {
        await stellarService.readOrganizationDetails(input.orgId);
        return { valid: true };
      }),

    validateClaimPayout: t.procedure
      .input(claimPayoutInputSchema)
      .mutation(async () => {
        return { valid: true };
      }),
  }),

  sync: syncRouter,
});

export type AppRouter = typeof appRouter;
