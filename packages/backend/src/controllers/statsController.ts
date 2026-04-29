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
   * Get top maintainers ranked by total earnings.
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