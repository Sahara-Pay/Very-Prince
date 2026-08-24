/**
 * @file statsController.test.ts
 * @description Unit tests for statsController.getTotalFundsRaised() and
 * getOrgFundingHistory().
 *
 * These tests verify:
 *   - Correct aggregation and response shaping via Prisma aggregate/groupBy.
 *   - Optional date-filter parameters are forwarded to the query.
 *   - Zero/empty results are handled gracefully.
 *   - Results are cached for subsequent calls.
 *   - Cache is keyed by date filters so different filters get independent entries.
 *   - Org funding history is cursor-streamed from the DB.
 *
 * Prisma and the Redis cache are both mocked so no real DB or network
 * connection is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.mock calls are hoisted to the top of the file by Vitest's transform.
// To allow the mocked implementations to be accessed in tests, we use
// vi.hoisted() which also runs before the mock factories execute.
// ---------------------------------------------------------------------------
const { safeGetMock, safeSetMock, aggregateMock, groupByMock, findManyMock } = vi.hoisted(() => ({
  safeGetMock:       vi.fn(),
  safeSetMock:       vi.fn(),
  aggregateMock:     vi.fn(),
  groupByMock:       vi.fn(),
  findManyMock:      vi.fn(),
}));

vi.mock('../services/cache.js', () => ({
  safeGet:  safeGetMock,
  safeSet:  safeSetMock,
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

vi.mock('../services/db.js', () => ({
  prismaRead: {
    invoice: { aggregate: vi.fn() },
    fundingEvent: {
      aggregate: aggregateMock,
      groupBy:   groupByMock,
      findMany:  findManyMock,
    },
  },
}));

vi.mock('../services/stellarService.js', () => ({
  stellarService: {
    readAllOrganizations:  vi.fn().mockResolvedValue([]),
    readOrgBudget:         vi.fn().mockResolvedValue(0n),
    readMaintainers:       vi.fn().mockResolvedValue([]),
    readClaimableBalance:  vi.fn().mockResolvedValue(0n),
    readProfileStats:      vi.fn().mockResolvedValue({ totalXlm: '0', totalStroops: 0n, orgIds: [] }),
  },
}));

// ---------------------------------------------------------------------------
// Now import the controller under test
// ---------------------------------------------------------------------------
import { statsController } from '../controllers/statsController.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake Prisma aggregate result as the DB layer would return it. */
function makeAggregate(totalStroops: bigint | null, eventCount: number) {
  return {
    _sum: { amountStroops: totalStroops },
    _count: { _all: eventCount },
  };
}

/** Build a fake Prisma groupBy result (COUNT DISTINCT orgId). */
function makeGroupBy(orgIds: string[]) {
  return orgIds.map((orgId) => ({ orgId }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('statsController.getTotalFundsRaised()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // By default, cache misses so the DB query is always reached
    safeGetMock.mockResolvedValue(null);
    safeSetMock.mockResolvedValue(undefined);
    groupByMock.mockResolvedValue(makeGroupBy(['org-1', 'org-2']));
  });

  // -------------------------------------------------------------------------
  // Happy-path: all funds, no date filters
  // -------------------------------------------------------------------------
  it('returns correct aggregated totals with no date filters', async () => {
    const stroops = 150_000_000n; // 15 XLM
    aggregateMock.mockResolvedValue(makeAggregate(stroops, 3));

    const result = await statsController.getTotalFundsRaised();

    expect(result.totalFundsRaisedStroops).toBe('150000000');
    expect(result.totalFundsRaisedXlm).toBe('15.0000000');
    expect(result.totalFundingEvents).toBe(3);
    expect(result.distinctOrgsCount).toBe(2);
    expect(result.fromDate).toBeUndefined();
    expect(result.toDate).toBeUndefined();
    expect(result.cachedAt).toBeDefined();

    // No date filters → empty where clause on the aggregate.
    expect(aggregateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  // -------------------------------------------------------------------------
  // Happy-path: with both date filters
  // -------------------------------------------------------------------------
  it('passes fromDate and toDate through to the aggregate and response', async () => {
    aggregateMock.mockResolvedValue(makeAggregate(70_000_000n, 1));
    groupByMock.mockResolvedValue(makeGroupBy(['org-1']));

    const from = '2024-01-01T00:00:00.000Z';
    const to   = '2024-06-30T23:59:59.999Z';

    const result = await statsController.getTotalFundsRaised(from, to);

    expect(aggregateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date(from),
            lte: new Date(to),
          },
        },
      }),
    );

    expect(result.fromDate).toBe(from);
    expect(result.toDate).toBe(to);
    expect(result.totalFundsRaisedStroops).toBe('70000000');
    expect(result.distinctOrgsCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Edge-case: empty table (no funding events yet)
  // -------------------------------------------------------------------------
  it('handles zero results gracefully (empty FundingEvent table)', async () => {
    aggregateMock.mockResolvedValue(makeAggregate(0n, 0));
    groupByMock.mockResolvedValue([]);

    const result = await statsController.getTotalFundsRaised();

    expect(result.totalFundsRaisedStroops).toBe('0');
    expect(result.totalFundsRaisedXlm).toBe('0.0000000');
    expect(result.totalFundingEvents).toBe(0);
    expect(result.distinctOrgsCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Edge-case: DB returns null for the SUM (COALESCE to zero)
  // -------------------------------------------------------------------------
  it('handles null SUM from PostgreSQL (coalesces to zero)', async () => {
    aggregateMock.mockResolvedValue(makeAggregate(null, 0));

    const result = await statsController.getTotalFundsRaised();

    expect(result.totalFundsRaisedStroops).toBe('0');
    expect(result.totalFundingEvents).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Caching: warm cache returns cached value without hitting the DB
  // -------------------------------------------------------------------------
  it('returns the cached result and does NOT call the DB on cache hit', async () => {
    const cached = {
      totalFundsRaisedStroops: '999000000',
      totalFundsRaisedXlm:     '99.9000000',
      totalFundingEvents:      7,
      distinctOrgsCount:       3,
      cachedAt:                new Date().toISOString(),
    };
    safeGetMock.mockResolvedValue(JSON.stringify(cached));

    const result = await statsController.getTotalFundsRaised();

    expect(result.totalFundsRaisedStroops).toBe('999000000');
    expect(aggregateMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Caching: result is stored in cache with 5-minute TTL after DB fetch
  // -------------------------------------------------------------------------
  it('stores the result in the cache with a 5-minute TTL after fetching from DB', async () => {
    aggregateMock.mockResolvedValue(makeAggregate(50_000_000n, 2));
    groupByMock.mockResolvedValue(makeGroupBy(['org-1']));

    await statsController.getTotalFundsRaised();

    expect(safeSetMock).toHaveBeenCalledOnce();
    const [key, value, ttl] = safeSetMock.mock.calls[0] as [string, string, number];
    expect(key).toContain('funds-raised');
    expect(JSON.parse(value).totalFundsRaisedStroops).toBe('50000000');
    expect(ttl).toBe(300); // 5-minute TTL
  });

  // -------------------------------------------------------------------------
  // Caching: different filter combos produce independent cache keys
  // -------------------------------------------------------------------------
  it('uses separate cache keys for different date filter combinations', async () => {
    aggregateMock.mockResolvedValue(makeAggregate(10_000_000n, 1));

    await statsController.getTotalFundsRaised();
    await statsController.getTotalFundsRaised('2024-01-01T00:00:00.000Z');
    await statsController.getTotalFundsRaised(undefined, '2024-12-31T23:59:59.999Z');

    const keys = safeSetMock.mock.calls.map((c) => c[0] as string);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Only fromDate provided
  // -------------------------------------------------------------------------
  it('handles only fromDate without toDate', async () => {
    aggregateMock.mockResolvedValue(makeAggregate(20_000_000n, 1));

    const from = '2025-01-01T00:00:00.000Z';
    const result = await statsController.getTotalFundsRaised(from);

    expect(result.fromDate).toBe(from);
    expect(result.toDate).toBeUndefined();

    // Only the gte bound is forwarded to the aggregate query.
    expect(aggregateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { gte: new Date(from) } },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Only toDate provided
  // -------------------------------------------------------------------------
  it('handles only toDate without fromDate', async () => {
    aggregateMock.mockResolvedValue(makeAggregate(30_000_000n, 2));
    groupByMock.mockResolvedValue(makeGroupBy(['org-1', 'org-2']));

    const to = '2025-12-31T23:59:59.999Z';
    const result = await statsController.getTotalFundsRaised(undefined, to);

    expect(result.fromDate).toBeUndefined();
    expect(result.toDate).toBe(to);

    expect(aggregateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { createdAt: { lte: new Date(to) } },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // No WHERE clause when no date filters
  // -------------------------------------------------------------------------
  it('omits WHERE clause when no date filters are supplied', async () => {
    aggregateMock.mockResolvedValue(makeAggregate(0n, 0));

    await statsController.getTotalFundsRaised();

    const call = aggregateMock.mock.calls[0] as [{ where?: object }];
    expect(call[0]?.where).toEqual({});
  });

  // -------------------------------------------------------------------------
  // BigInt precision is preserved for very large amounts
  // -------------------------------------------------------------------------
  it('preserves BigInt precision for very large stroop values', async () => {
    // 1 billion XLM = 10^16 stroops — exceeds Number.MAX_SAFE_INTEGER
    const hugeStroops = 10_000_000_000_000_000n;
    aggregateMock.mockResolvedValue(makeAggregate(hugeStroops, 100));
    groupByMock.mockResolvedValue(makeGroupBy(Array.from({ length: 50 }, (_, i) => `org-${i}`)));

    const result = await statsController.getTotalFundsRaised();

    expect(result.totalFundsRaisedStroops).toBe('10000000000000000');
    // XLM conversion: 10^16 / 10^7 = 10^9 XLM
    expect(result.totalFundsRaisedXlm).toBe('1000000000.0000000');
  });
});

describe('statsController.getOrgFundingHistory()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    safeGetMock.mockResolvedValue(null);
    safeSetMock.mockResolvedValue(undefined);
  });

  it('returns empty history if no events are found', async () => {
    findManyMock.mockResolvedValue([]);

    const result = await statsController.getOrgFundingHistory('stellar');

    // First page: no cursor, `take` capped for streaming.
    expect(findManyMock).toHaveBeenCalledWith({
      where: { orgId: 'stellar' },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    expect(result).toEqual([]);
  });

  it('calculates running cumulative sums and shapes output correctly', async () => {
    const mockEvents = [
      {
        id: '1',
        orgId: 'stellar',
        from: 'GDX...',
        amountStroops: 10_000_000n, // 1 XLM
        amountXlm: '1.0000000',
        ledger: 100,
        txHash: 'hash1',
        createdAt: new Date('2026-07-17T08:00:00.000Z'),
      },
      {
        id: '2',
        orgId: 'stellar',
        from: 'GDY...',
        amountStroops: 25_000_000n, // 2.5 XLM
        amountXlm: '2.5000000',
        ledger: 101,
        txHash: 'hash2',
        createdAt: new Date('2026-07-17T09:00:00.000Z'),
      },
    ];
    findManyMock.mockResolvedValue(mockEvents);

    const result = await statsController.getOrgFundingHistory('stellar');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: '1',
      orgId: 'stellar',
      from: 'GDX...',
      amountStroops: '10000000',
      amountXlm: '1.0000000',
      cumulativeStroops: '10000000',
      cumulativeXlm: '1.0000000',
      txHash: 'hash1',
      createdAt: '2026-07-17T08:00:00.000Z',
    });
    expect(result[1]).toEqual({
      id: '2',
      orgId: 'stellar',
      from: 'GDY...',
      amountStroops: '25000000',
      amountXlm: '2.5000000',
      cumulativeStroops: '35000000',
      cumulativeXlm: '3.5000000',
      txHash: 'hash2',
      createdAt: '2026-07-17T09:00:00.000Z',
    });
  });

  it('streams from the DB (caching happens at the tRPC layer, not the controller)', async () => {
    const mockEvents = [
      {
        id: '1',
        orgId: 'stellar',
        from: 'GDX...',
        amountStroops: 10_000_000n,
        amountXlm: '1.0000000',
        ledger: 100,
        txHash: 'hash1',
        createdAt: new Date('2026-07-17T08:00:00.000Z'),
      },
    ];
    findManyMock.mockResolvedValue(mockEvents);

    const result = await statsController.getOrgFundingHistory('stellar');

    expect(findManyMock).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    // The controller itself never touches the cache — the tRPC router does.
    expect(safeGetMock).not.toHaveBeenCalled();
    expect(safeSetMock).not.toHaveBeenCalled();
  });
});
