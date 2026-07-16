/**
 * @file statsController.ts
 * @description Business logic for platform-wide statistics aggregation.
 *
 * Stats are derived from on-chain state via stellarService.
 * No Prisma / database layer exists in this project — all data lives on Stellar.
 */

import { stellarService } from "../services/stellarService.js";
import { safeGet, safeSet } from "../services/cache.js";
import { prisma } from "../services/db.js";

export interface GlobalStatsResponse {
  /** Number of registered organizations on-chain. */
  totalOrganizations: number;
  /** Sum of all org budgets currently held in the contract (stroops). */
  totalFundedStroops: string;
  /** Same value expressed in whole XLM. */
  totalFundedXlm: string;
  /** Sum of all maintainer claimable balances (stroops). */
  totalClaimedStroops: string;
  /** Same value expressed in whole XLM. */
  totalClaimedXlm: string;
  /** ISO timestamp of when this result was computed. */
  cachedAt: string;
  /** ISO timestamp of when the cache will expire. */
  cacheExpiresAt: string;
}

export interface TopMaintainer {
  address: string;
  totalEarningsXlm: string;
  totalEarningsStroops: string;
  organizationsAssisted: number;
}

function stroopsToXlm(stroops: bigint): string {
  return (Number(stroops) / 10_000_000).toFixed(7);
}

/**
 * Format a number as abbreviated string (e.g., 14.5M instead of 14500000).
 */
function formatShort(value: number): string {
  if (value >= 1_000_000_000) {
    return (value / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  }
  if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (value >= 1_000) {
    return (value / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return value.toFixed(2);
}

export const statsController = {
  /**
   * Get global platform statistics.
   * 
   * This method performs a multi-step aggregation:
   * 1. Fetches all registered organizations from the contract.
   * 2. For each organization, it fetches the current budget and maintainer list.
   * 3. For each maintainer, it fetches their current claimable balance.
   * 4. Aggregates all values into a single response object.
   * 
   * Performance Notes:
   * - Uses `Promise.all` for parallel fetching of org data.
   * - Implements a 5-minute cache to prevent RPC rate limiting.
   * - BigInt is used for all stroop calculations to prevent precision loss.
   */
  async getGlobalStats(): Promise<GlobalStatsResponse> {
    const cacheKey = "stats:global";
    const cached = await safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const orgs = await stellarService.readAllOrganizations();

    let totalFunded = 0n;
    let totalClaimed = 0n;

    await Promise.all(
      orgs.map(async (orgId) => {
        const [budget, maintainers] = await Promise.all([
          stellarService.readOrgBudget(orgId),
          stellarService.readMaintainers(orgId),
        ]);

        totalFunded += BigInt(budget);

        const balances = await Promise.all(
          maintainers.map((m) => stellarService.readClaimableBalance(m))
        );
        for (const b of balances) totalClaimed += BigInt(b);
      })
    );

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 300_000); // 5 minutes

    const response: GlobalStatsResponse = {
      totalOrganizations: orgs.length,
      totalFundedStroops: totalFunded.toString(),
      totalFundedXlm: stroopsToXlm(totalFunded),
      totalClaimedStroops: totalClaimed.toString(),
      totalClaimedXlm: stroopsToXlm(totalClaimed),
      cachedAt: now.toISOString(),
      cacheExpiresAt: expiresAt.toISOString(),
    };

    await safeSet(cacheKey, JSON.stringify(response), 300);

    return response;
  },

  /**
   * Get Total Value Locked (TVL) across the platform.
   * Aggregates faceValue of all active, non-repaid invoices.
   *
   * @param format - 'full' returns exact value, 'short' returns abbreviated (e.g., 14.5M)
   */
  async getTVL(format: "full" | "short" = "full"): Promise<TVLResponse> {
    const cacheKey = `stats:tvl:${format}`;
    const cached = await safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Aggregate sum of faceValueUSD for all active invoices
    const result = await prisma.invoice.aggregate({
      where: {
        status: "ACTIVE",
      },
      _sum: {
        faceValueUSD: true,
      },
    });

    const totalUSD = result._sum.faceValueUSD?.toNumber() ?? 0;
    const now = new Date();

    const response: TVLResponse = {
      tvlUSD: format === "short" ? formatShort(totalUSD) : totalUSD.toFixed(2),
      lastUpdated: now.toISOString(),
    };

    await safeSet(cacheKey, JSON.stringify(response), 60); // Cache for 1 minute

    return response;
  },

  /**
   * Get the total funds raised across all organisations via a single optimised
   * PostgreSQL aggregation query.
   *
   * Problem being solved:
   *   The old `getGlobalStats()` fetches org budgets via N+1 Stellar RPC calls
   *   (one per org) which is slow, rate-limited, and expensive.  By persisting
   *   every `OrgFunded` on-chain event into the `FundingEvent` table we can
   *   answer this question with a single SQL statement:
   *
   *     SELECT SUM(amount_stroops), COUNT(*), COUNT(DISTINCT org_id)
   *     FROM   "FundingEvent"
   *     [WHERE  created_at BETWEEN $from AND $to]
   *
   * @param fromDate - Optional ISO date string; only events on/after this date
   * @param toDate   - Optional ISO date string; only events on/before this date
   */
  async getTotalFundsRaised(
    fromDate?: string,
    toDate?: string,
  ): Promise<FundsRaisedResponse> {
    const cacheKey = `stats:funds-raised:${fromDate ?? "all"}:${toDate ?? "all"}`;
    const cached = await safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Build the optional WHERE clause fragments
    const conditions: string[] = [];
    const params: (Date | string)[] = [];

    if (fromDate) {
      params.push(new Date(fromDate));
      conditions.push(`"createdAt" >= $${params.length}`);
    }
    if (toDate) {
      params.push(new Date(toDate));
      conditions.push(`"createdAt" <= $${params.length}`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Single round-trip to PostgreSQL — no Stellar RPC, no N+1 loops
    type AggRow = {
      total_stroops: bigint | null;
      event_count: bigint;
      org_count: bigint;
    };

    const [row] = await prisma.$queryRawUnsafe<AggRow[]>(
      `SELECT
         COALESCE(SUM("amountStroops"), 0)           AS total_stroops,
         COUNT(*)                                     AS event_count,
         COUNT(DISTINCT "orgId")                      AS org_count
       FROM "FundingEvent"
       ${whereClause}`,
      ...params,
    );

    const totalStroops = BigInt(row?.total_stroops ?? 0n);
    const eventCount = Number(row?.event_count ?? 0n);
    const orgCount = Number(row?.org_count ?? 0n);

    const now = new Date();
    const response: FundsRaisedResponse = {
      totalFundsRaisedStroops: totalStroops.toString(),
      totalFundsRaisedXlm: stroopsToXlm(totalStroops),
      totalFundingEvents: eventCount,
      distinctOrgsCount: orgCount,
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {}),
      cachedAt: now.toISOString(),
    };

    // Cache for 5 minutes (300 s) — same TTL as global stats
    await safeSet(cacheKey, JSON.stringify(response), 300);

    return response;
  },

  /**
    * Get top maintainers ranked by total earnings.
    * 
    * This endpoint identifies the most impactful contributors across the entire
    * Very Prince ecosystem. 
    * 
    * Ranking Logic:
    * - Primary: Total earnings in Stroops (highest first).
    * - Secondary: Number of organizations assisted.
    * 
    * Data Source:
    * - Maintainer addresses are discovered via `readMaintainers` for every org.
    * - Earnings stats are fetched via `readProfileStats` which parses on-chain events.
    * 
    * Optimization:
    * - The list of unique maintainers is built first to avoid redundant stats calls.
    * - The final sorted list is cached for 5 minutes.
    */
   async getTopMaintainers(): Promise<TopMaintainer[]> {
    const cacheKey = "stats:top-maintainers";
    const cached = await safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const orgs = await stellarService.readAllOrganizations();
    const maintainerAddresses = new Set<string>();

    // Collect all unique maintainer addresses
    await Promise.all(
      orgs.map(async (orgId) => {
        const maintainers = await stellarService.readMaintainers(orgId);
        maintainers.forEach((m) => maintainerAddresses.add(m));
      })
    );

    // Fetch stats for each maintainer
    const maintainersData = await Promise.all(
      [...maintainerAddresses].map(async (address) => {
        const stats = await stellarService.readProfileStats(address);
        return {
          address,
          totalEarningsXlm: stats.totalXlm,
          totalEarningsStroops: stats.totalStroops.toString(),
          organizationsAssisted: stats.orgIds.length,
          rawStroops: stats.totalStroops,
        };
      })
    );

    // Sort by earnings descending
    const sorted = maintainersData
      .sort((a, b) => {
        if (b.rawStroops > a.rawStroops) return 1;
        if (b.rawStroops < a.rawStroops) return -1;
        return 0;
      })
      .map(({ rawStroops, ...rest }) => rest);

    await safeSet(cacheKey, JSON.stringify(sorted), 300); // Cache for 5 minutes

    return sorted;
  },
} as const;

export interface TVLResponse {
  /** Total Value Locked in USD. */
  tvlUSD: string;
  /** ISO timestamp of when this value was computed. */
  lastUpdated: string;
}

export interface FundsRaisedResponse {
  /** Total funds raised across all organisations, in stroops. */
  totalFundsRaisedStroops: string;
  /** Total funds raised expressed in whole XLM. */
  totalFundsRaisedXlm: string;
  /** Total number of individual funding transactions. */
  totalFundingEvents: number;
  /** Number of distinct organisations that received funds. */
  distinctOrgsCount: number;
  /** ISO timestamp of the earliest funding event included (if filtered). */
  fromDate?: string;
  /** ISO timestamp of the latest funding event included (if filtered). */
  toDate?: string;
  /** ISO timestamp of when this result was computed. */
  cachedAt: string;
}