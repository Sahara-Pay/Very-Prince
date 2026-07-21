/**
 * @file cacheInvalidation.ts
 * @description Coordinated Redis cache invalidation for stats, analytics, and tRPC layers.
 */

import { safeDel, safeDelByPrefix } from "./cache.js";
import { trpcCacheKeys } from "../trpc/cacheKeys.js";

/** Invalidate aggregation caches after a new funding event is indexed. */
export async function invalidateOnFundingEvent(orgId: string): Promise<void> {
  await Promise.all([
    safeDel(`stats:funding-history:${orgId}`),
    safeDel(trpcCacheKeys.statsFundingHistory(orgId)),
    safeDelByPrefix("stats:funds-raised:"),
    safeDelByPrefix("trpc:stats.getTotalFundsRaised:"),
    safeDel("stats:global"),
    safeDel(trpcCacheKeys.statsGlobal()),
  ]);
}

/** Invalidate leaderboard caches after a new transaction is indexed. */
export async function invalidateOnTransactionEvent(): Promise<void> {
  await Promise.all([
    safeDel("analytics:leaderboard:7d"),
    safeDel(trpcCacheKeys.analyticsLeaderboard()),
  ]);
}

/** Invalidate organization detail caches after on-chain org state changes. */
export async function invalidateOrganizationCaches(orgId: string): Promise<void> {
  await Promise.all([
    safeDel(`org_details:${orgId}`),
    safeDel(trpcCacheKeys.organizationGet(orgId)),
    safeDel(`org:${orgId}`),
  ]);
}
