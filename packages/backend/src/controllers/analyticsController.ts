/**
 * @file analyticsController.ts
 * @description Controller for analytics-related operations.
 */

import { prismaRead } from "../services/db.js";
import { safeGet, safeSet } from "../services/cache.js";
import type { LeaderboardEntry } from "@very-prince/types";

export const analyticsController = {
  /**
   * Fetch the leaderboard of top traders based on 7-day volume.
   */
  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    const cacheKey = "analytics:leaderboard:7d";
    const cached = await safeGet(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // 1. Group transactions from the last 7 days by wallet address
    // 2. Sum volumeUSD per wallet
    const groupedResults = await prismaRead.transaction.groupBy({
      by: ["walletAddress"],
      _sum: {
        volumeUSD: true,
      },
      where: {
        createdAt: {
          gte: sevenDaysAgo,
        },
      },
      orderBy: {
        _sum: {
          volumeUSD: "desc",
        },
      },
      take: 10,
    });

    // 3. Format the results
    const leaderboard = groupedResults.map((result, index) => {
      const walletAddress = result.walletAddress;
      const truncatedAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
      const volumeUSD = Number(result._sum.volumeUSD || 0);

      return {
        rank: index + 1,
        walletAddress,
        truncatedAddress,
        volumeUSD: parseFloat(volumeUSD.toFixed(2)),
      };
    });

    // 4. Cache for 5 minutes (300 seconds)
    await safeSet(cacheKey, JSON.stringify(leaderboard), 300);

    return leaderboard;
  },
};
