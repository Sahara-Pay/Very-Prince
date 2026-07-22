import { describe, it, expect, vi, beforeEach } from "vitest";

const { safeGetMock, safeSetMock, safeDelMock, safeDelByPrefixMock } = vi.hoisted(() => ({
  safeGetMock: vi.fn<[string], Promise<string | null>>(),
  safeSetMock: vi.fn<[string, string, number], Promise<void>>(),
  safeDelMock: vi.fn<[string], Promise<void>>(),
  safeDelByPrefixMock: vi.fn<[string], Promise<void>>(),
}));

vi.mock("./cache.js", () => ({
  safeGet: safeGetMock,
  safeSet: safeSetMock,
  safeDel: safeDelMock,
  safeDelByPrefix: safeDelByPrefixMock,
  redis: { keys: vi.fn(), on: vi.fn() },
  bullRedisConnection: {},
}));

import {
  invalidateOnFundingEvent,
  invalidateOnTransactionEvent,
} from "./cacheInvalidation.js";

describe("cacheInvalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates funding-related controller and tRPC cache keys", async () => {
    await invalidateOnFundingEvent("stellar");

    expect(safeDelMock).toHaveBeenCalledWith("stats:funding-history:stellar");
    expect(safeDelMock).toHaveBeenCalledWith("trpc:stats.getFundingHistory:stellar");
    expect(safeDelMock).toHaveBeenCalledWith("stats:global");
    expect(safeDelMock).toHaveBeenCalledWith("trpc:stats.getGlobalStats");
    expect(safeDelByPrefixMock).toHaveBeenCalledWith("stats:funds-raised:");
    expect(safeDelByPrefixMock).toHaveBeenCalledWith("trpc:stats.getTotalFundsRaised:");
  });

  it("invalidates analytics leaderboard caches", async () => {
    await invalidateOnTransactionEvent();

    expect(safeDelMock).toHaveBeenCalledWith("analytics:leaderboard:7d");
    expect(safeDelMock).toHaveBeenCalledWith("trpc:analytics.getLeaderboard");
  });
});
