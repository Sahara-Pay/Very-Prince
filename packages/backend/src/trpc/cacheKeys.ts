/**
 * @file cacheKeys.ts
 * @description Redis key builders and TTL constants for tRPC cached queries.
 */

export const TRPC_CACHE_TTL = {
  ORG_DETAILS: 5,
  STATS_GLOBAL: 300,
  STATS_TVL: 60,
  STATS_FUNDS_RAISED: 300,
  STATS_FUNDING_HISTORY: 60,
  STATS_TOP_MAINTAINERS: 300,
  ANALYTICS_LEADERBOARD: 300,
} as const;

export const trpcCacheKeys = {
  organizationGet: (id: string) => `trpc:organization.get:${id}`,
  statsGlobal: () => "trpc:stats.getGlobalStats",
  statsTvl: (format: string) => `trpc:stats.getTVL:${format}`,
  statsFundsRaised: (from?: string, to?: string) =>
    `trpc:stats.getTotalFundsRaised:${from ?? "all"}:${to ?? "all"}`,
  statsFundingHistory: (orgId: string) => `trpc:stats.getFundingHistory:${orgId}`,
  statsTopMaintainers: () => "trpc:stats.getTopMaintainers",
  analyticsLeaderboard: () => "trpc:analytics.getLeaderboard",
} as const;
