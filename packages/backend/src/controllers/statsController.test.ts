/**
 * @file statsController.test.ts
 * @description Unit tests for statsController.getTotalFundsRaised().
 *
 * These tests verify:
 *   - Correct SQL aggregation and response shaping.
 *   - Optional date-filter parameters are forwarded to the query.
 *   - Zero/empty results are handled gracefully.
 *   - Results are cached for subsequent calls.
 *   - Cache is keyed by date filters so different filters get independent entries.
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
const { safeGetMock, safeSetMock, queryRawUnsafeMock, findManyMock } = vi.hoisted(() => ({
  safeGetMock:          vi.fn<[string], Promise<string | null>>(),
  safeSetMock:          vi.fn<[string, string, number], Promise<void>>(),
  queryRawUnsafeMock:   vi.fn(),
  findManyMock:         vi.fn(),
}));

vi.mock('../services/cache.js', () => ({
  safeGet:  safeGetMock,
  safeSet:  safeSetMock,
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

vi.mock('../services/db.js', () => ({
  prismaRead: {
    $queryRawUnsafe: queryRawUnsafeMock,
    invoice: { aggregate: vi.fn() },
    fundingEvent: { findMany: findManyMock },
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

/** Build a fake aggregation row as PostgreSQL would return it. */
function makeAggRow(totalStroops: bigint, eventCount: bigint, orgCount: bigint) {
  return [
    {
      total_stroops: totalStroops,
      event_count:   eventCount,
      org_count:     orgCount,
    },
  ];
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
  });

  // -------------------------------------------------------------------------
  // Happy-path: all funds, no date filters
  // -------------------------------------------------------------------------
  it('returns correct aggregated totals with no date filters', async () => {
    const stroops = 150_000_000n; // 15 XLM
    queryRawUnsafeMock.mockResolvedValue(makeAggRow(stroops, 3n, 2n));

    const result = await statsController.getTotalFundsRaised();

    expect(result.totalFundsRaisedStroops).toBe('150000000');
    expect(result.totalFundsRaisedXlm).toBe('15.0000000');
    expect(result.totalFundingEvents).toBe(3);
    expect(result.distinctOrgsCount).toBe(2);
    expect(result.fromDate).toBeUndefined();
    expect(result.toDate).toBeUndefined();
    expect(result.cachedAt).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Happy-path: with both date filters
  // -------------------------------------------------------------------------
  it('passes fromDate and toDate through to the raw query and response', async () => {
    queryRawUnsafeMock.mockResolvedValue(makeAggRow(70_000_000n, 1n, 1n));

    const from = '2024-01-01T00:00:00.000Z';
    const to   = '2024-06-30T23:59:59.999Z';

    const result = await statsController.getTotalFundsRaised(from, to);

    expect(queryRawUnsafeMock).toHaveBeenCalledOnce();
    const [sqlTemplate, p1, p2] = queryRawUnsafeMock.mock.calls[0] as [string, Date, Date];
    expect(sqlTemplate).toContain('WHERE');
    expect(p1).toEqual(new Date(from));
    expect(p2).toEqual(new Date(to));

    expect(result.fromDate).toBe(from);
    expect(result.toDate).toBe(to);
    expect(result.totalFundsRaisedStroops).toBe('70000000');
  });

  // -------------------------------------------------------------------------
  // Edge-case: empty table (no funding events yet)
  // -------------------------------------------------------------------------
  it('handles zero results gracefully (empty FundingEvent table)', async () => {
    queryRawUnsafeMock.mockResolvedValue(makeAggRow(0n, 0n, 0n));

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
    queryRawUnsafeMock.mockResolvedValue([
      { total_stroops: null, event_count: 0n, org_count: 0n },
    ]);

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
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Caching: result is stored in cache with 5-minute TTL after DB fetch
  // -------------------------------------------------------------------------
  it('stores the result in the cache with a 5-minute TTL after fetching from DB', async () => {
    queryRawUnsafeMock.mockResolvedValue(makeAggRow(50_000_000n, 2n, 1n));

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
    queryRawUnsafeMock.mockResolvedValue(makeAggRow(10_000_000n, 1n, 1n));

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
    queryRawUnsafeMock.mockResolvedValue(makeAggRow(20_000_000n, 1n, 1n));

    const from = '2025-01-01T00:00:00.000Z';
    const result = await statsController.getTotalFundsRaised(from);

    expect(result.fromDate).toBe(from);
    expect(result.toDate).toBeUndefined();

    // Only one date param should be passed to the raw query (sql + 1 param)
    expect(queryRawUnsafeMock.mock.calls[0]).toHaveLength(2);
    const [sqlTemplate, p1] = queryRawUnsafeMock.mock.calls[0] as [string, Date];
    expect(p1).toEqual(new Date(from));
    expect(sqlTemplate).toContain('WHERE');
    expect(sqlTemplate).not.toContain('$2');
  });

  // -------------------------------------------------------------------------
  // Only toDate provided
  // -------------------------------------------------------------------------
  it('handles only toDate without fromDate', async () => {
    queryRawUnsafeMock.mockResolvedValue(makeAggRow(30_000_000n, 2n, 2n));

    const to = '2025-12-31T23:59:59.999Z';
    const result = await statsController.getTotalFundsRaised(undefined, to);

    expect(result.fromDate).toBeUndefined();
    expect(result.toDate).toBe(to);

    // Only one date param should be passed (sql + 1 param)
    expect(queryRawUnsafeMock.mock.calls[0]).toHaveLength(2);
    const [sqlTemplate, p1] = queryRawUnsafeMock.mock.calls[0] as [string, Date];
    expect(p1).toEqual(new Date(to));
    expect(sqlTemplate).toContain('WHERE');
  });

  // -------------------------------------------------------------------------
  // No WHERE clause when no date filters
  // -------------------------------------------------------------------------
  it('omits WHERE clause when no date filters are supplied', async () => {
    queryRawUnsafeMock.mockResolvedValue(makeAggRow(0n, 0n, 0n));

    await statsController.getTotalFundsRaised();

    const [sqlTemplate] = queryRawUnsafeMock.mock.calls[0] as [string];
    expect(sqlTemplate).not.toContain('WHERE');
  });

  // -------------------------------------------------------------------------
  // BigInt precision is preserved for very large amounts
  // -------------------------------------------------------------------------
  it('preserves BigInt precision for very large stroop values', async () => {
    // 1 billion XLM = 10^16 stroops — exceeds Number.MAX_SAFE_INTEGER
    const hugeStroops = 10_000_000_000_000_000n;
    queryRawUnsafeMock.mockResolvedValue(makeAggRow(hugeStroops, 100n, 50n));

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

    expect(findManyMock).toHaveBeenCalledWith({
      where: { orgId: 'stellar' },
      orderBy: { createdAt: 'asc' },
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

  it('serves results from cache and stores to cache', async () => {
    const cachedData = [
      {
        id: '1',
        orgId: 'stellar',
        from: 'GDX...',
        amountStroops: '10000000',
        amountXlm: '1.0000000',
        cumulativeStroops: '10000000',
        cumulativeXlm: '1.0000000',
        txHash: 'hash1',
        createdAt: '2026-07-17T08:00:00.000Z',
      },
    ];

    // Cache hit
    safeGetMock.mockResolvedValue(JSON.stringify(cachedData));
    let result = await statsController.getOrgFundingHistory('stellar');
    expect(result).toEqual(cachedData);
    expect(findManyMock).not.toHaveBeenCalled();

    // Cache miss & save
    safeGetMock.mockResolvedValue(null);
    findManyMock.mockResolvedValue([]);
    result = await statsController.getOrgFundingHistory('stellar');
    expect(result).toEqual([]);
    expect(findManyMock).toHaveBeenCalledOnce();
    expect(safeSetMock).toHaveBeenCalledWith('stats:funding-history:stellar', JSON.stringify([]), 60);
  });
});
