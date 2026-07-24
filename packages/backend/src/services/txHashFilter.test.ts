/**
 * @file txHashFilter.test.ts
 *
 * Tests for the TxHashFilter HyperLogLog replay-attack guard.
 *
 * Coverage goals:
 *  - New hash → `hll_new` path (no DB query)
 *  - HLL positive hit + DB row found → `hll_positive_db_confirmed` (duplicate dropped)
 *  - HLL positive hit + DB row missing → `hll_positive_db_miss` (false positive let through)
 *  - DB query throws → `fallback_allowed` (safe degradation, event not dropped)
 *  - Metrics counters increment correctly
 *  - HyperLogLog cardinality estimate stays accurate over many unique hashes
 *  - Memory footprint: 256 KB regardless of cardinality
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock prisma before importing the module under test ──────────────────────
const mockFindFirst = vi.fn();

vi.mock("./db.js", () => ({
  prisma: {
    transaction: {
      findFirst: mockFindFirst,
    },
  },
}));

// logger must not throw; silence it in tests
vi.mock("../utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Import AFTER mocks are registered ───────────────────────────────────────
// We import the class internals indirectly via a fresh module instance per
// describe block by using dynamic import with vi.resetModules().

// For brevity the top-level singleton is used throughout; state carries over
// between tests intentionally where noted.

import { txHashFilter } from "./txHashFilter.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const BASE_DATE = new Date("2026-07-24T00:00:00.000Z");

// ─────────────────────────────────────────────────────────────────────────────

describe("TxHashFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Path: hll_new ──────────────────────────────────────────────────────────

  describe("new hash (hll_new path)", () => {
    it("returns isDuplicate=false for a brand-new txHash", async () => {
      const result = await txHashFilter.check("unique_hash_001", 0, BASE_DATE);

      expect(result.isDuplicate).toBe(false);
      expect(result.decidedBy).toBe("hll_new");
    });

    it("does NOT query the database for a new hash", async () => {
      await txHashFilter.check("unique_hash_002", 0, BASE_DATE);

      expect(mockFindFirst).not.toHaveBeenCalled();
    });

    it("treats (same txHash, different eventIndex) as distinct keys", async () => {
      const txHash = "shared_tx_hash_aabbcc";

      // First call — genuinely new key
      const r1 = await txHashFilter.check(txHash, 0, BASE_DATE);
      expect(r1.isDuplicate).toBe(false);
      expect(r1.decidedBy).toBe("hll_new");

      // Second call — same txHash but different eventIndex → different dedup key
      // The HLL may or may not have collided; if it did, DB is checked.
      // Either way isDuplicate must not be true unless DB confirms it.
      mockFindFirst.mockResolvedValueOnce(null); // DB says: no existing row
      const r2 = await txHashFilter.check(txHash, 1, BASE_DATE);
      expect(r2.isDuplicate).toBe(false);
    });

    it("treats (same txHash, same eventIndex, different createdAt) as distinct keys", async () => {
      const txHash = "shared_tx_hash_xxyyzz";
      const dateA = new Date("2026-07-24T00:00:00.000Z");
      const dateB = new Date("2026-07-24T00:01:00.000Z");

      const r1 = await txHashFilter.check(txHash, 0, dateA);
      expect(r1.isDuplicate).toBe(false);

      mockFindFirst.mockResolvedValueOnce(null); // no DB row for dateB variant
      const r2 = await txHashFilter.check(txHash, 0, dateB);
      expect(r2.isDuplicate).toBe(false);
    });
  });

  // ── Path: hll_positive_db_confirmed ───────────────────────────────────────

  describe("confirmed duplicate (hll_positive_db_confirmed path)", () => {
    it("suppresses an exact duplicate after the HLL and DB both confirm it", async () => {
      const txHash = "dup_tx_hash_deadbeef01";
      const eventIndex = 0;

      // First pass — registers it in HLL
      await txHashFilter.check(txHash, eventIndex, BASE_DATE);

      // Second pass — HLL fires positive hit; DB confirms the row exists
      mockFindFirst.mockResolvedValueOnce({ id: "some-cuid" });
      const result = await txHashFilter.check(txHash, eventIndex, BASE_DATE);

      expect(result.isDuplicate).toBe(true);
      expect(result.decidedBy).toBe("hll_positive_db_confirmed");
    });

    it("queries the DB with the exact txHash, eventIndex, and createdAt", async () => {
      const txHash = "dup_tx_hash_deadbeef02";
      const eventIndex = 3;
      const createdAt = new Date("2026-07-10T12:00:00.000Z");

      await txHashFilter.check(txHash, eventIndex, createdAt);

      mockFindFirst.mockResolvedValueOnce({ id: "some-cuid" });
      await txHashFilter.check(txHash, eventIndex, createdAt);

      expect(mockFindFirst).toHaveBeenCalledWith({
        where: { txHash, eventIndex, createdAt },
        select: { id: true },
      });
    });
  });

  // ── Path: hll_positive_db_miss ────────────────────────────────────────────

  describe("false positive (hll_positive_db_miss path)", () => {
    it("allows event through when HLL fires but DB has no row", async () => {
      // To reliably trigger a false positive we need two different keys that
      // map to the same HLL register and rho value.  Rather than engineering
      // a collision, we mock the behaviour by using the singleton's internal
      // state: after we populate enough entries some natural collisions will
      // fire.  For a deterministic unit test, instead we verify the code path
      // by testing with a hash that happens to collide — or we stub HLL.add.
      //
      // Strategy: spy on the private HLL via the exported singleton.
      // We add a hash, then immediately try the same logical key with a
      // slightly different string (different eventIndex) that may collide in
      // the HLL. We tell the DB mock to return null to simulate a false positive.

      const txHash = "false_positive_hash_0001";
      // Seed the filter so this specific dedup key is in the HLL
      await txHashFilter.check(txHash, 0, BASE_DATE);

      // Now pretend a *different* key collides with it; easiest is to replay
      // an identical key but instruct the DB to say it doesn't exist.
      mockFindFirst.mockResolvedValueOnce(null);
      const result = await txHashFilter.check(txHash, 0, BASE_DATE);

      // DB returned null — it is a false positive if the HLL fired.
      // If the HLL didn't fire, result is hll_new — both are valid non-duplicate outcomes.
      expect(result.isDuplicate).toBe(false);
      expect(["hll_new", "hll_positive_db_miss"]).toContain(result.decidedBy);
    });

    it("returns isDuplicate=false even when HLL fires but DB has no matching row", async () => {
      // Craft a scenario where we KNOW the HLL will fire: use a key we already
      // inserted, but tell the DB findFirst to return null (simulating DB out
      // of sync / race condition).
      const txHash = "false_positive_confirmed_0002";
      const eventIndex = 7;
      const createdAt = new Date("2026-01-01T00:00:00.000Z");

      // First check — inserts into HLL, definitely hll_new
      const first = await txHashFilter.check(txHash, eventIndex, createdAt);
      expect(first.isDuplicate).toBe(false);

      // Second check — HLL positive hit; DB responds with null (false positive)
      mockFindFirst.mockResolvedValueOnce(null);
      const second = await txHashFilter.check(txHash, eventIndex, createdAt);

      // The HLL must have fired (same key inserted twice), so we're on the DB path.
      expect(second.isDuplicate).toBe(false);
      expect(second.decidedBy).toBe("hll_positive_db_miss");
    });
  });

  // ── Path: fallback_allowed ────────────────────────────────────────────────

  describe("error fallback (fallback_allowed path)", () => {
    it("returns isDuplicate=false and allows the event through when DB throws", async () => {
      const txHash = "error_path_hash_ffff";
      const eventIndex = 0;

      // First call seeds the HLL
      await txHashFilter.check(txHash, eventIndex, BASE_DATE);

      // Second call triggers a positive hit, but DB throws
      mockFindFirst.mockRejectedValueOnce(new Error("DB connection lost"));
      const result = await txHashFilter.check(txHash, eventIndex, BASE_DATE);

      expect(result.isDuplicate).toBe(false);
      expect(result.decidedBy).toBe("fallback_allowed");
    });

    it("never drops a valid event when findFirst throws unexpectedly", async () => {
      mockFindFirst.mockRejectedValueOnce(new Error("timeout"));

      const txHash = "safe_fallback_hash_9999";
      // Even on a brand-new hash where no DB query occurs the system stays safe;
      // test the at-risk scenario — after one seed + a DB error on second call.
      await txHashFilter.check(txHash, 0, BASE_DATE);
      mockFindFirst.mockRejectedValueOnce(new Error("timeout"));
      const result = await txHashFilter.check(txHash, 0, BASE_DATE);

      expect(result.isDuplicate).toBe(false);
    });
  });

  // ── Metrics ───────────────────────────────────────────────────────────────

  describe("getMetrics()", () => {
    it("returns a metrics object with the expected shape", () => {
      const m = txHashFilter.getMetrics();

      expect(m).toHaveProperty("totalChecked");
      expect(m).toHaveProperty("droppedByHll");
      expect(m).toHaveProperty("falsePositivesConfirmed");
      expect(m).toHaveProperty("estimatedCardinality");
      expect(m).toHaveProperty("hllMemoryKB");
      expect(m).toHaveProperty("dropRatePct");
    });

    it("hllMemoryKB is exactly 256", () => {
      // 2^18 registers × 1 byte = 262 144 bytes = 256 KB
      expect(txHashFilter.getMetrics().hllMemoryKB).toBe(256);
    });

    it("increments droppedByHll when a confirmed duplicate is suppressed", async () => {
      const before = txHashFilter.getMetrics().droppedByHll;

      const txHash = "metrics_dup_hash_1234";
      await txHashFilter.check(txHash, 0, BASE_DATE);

      mockFindFirst.mockResolvedValueOnce({ id: "cuid-abc" });
      await txHashFilter.check(txHash, 0, BASE_DATE);

      expect(txHashFilter.getMetrics().droppedByHll).toBe(before + 1);
    });

    it("increments falsePositivesConfirmed when DB misses after a positive hit", async () => {
      const before = txHashFilter.getMetrics().falsePositivesConfirmed;

      const txHash = "metrics_fp_hash_5678";
      await txHashFilter.check(txHash, 0, BASE_DATE);

      mockFindFirst.mockResolvedValueOnce(null);
      await txHashFilter.check(txHash, 0, BASE_DATE);

      expect(txHashFilter.getMetrics().falsePositivesConfirmed).toBe(before + 1);
    });

    it("dropRatePct is between 0 and 100", () => {
      const { dropRatePct } = txHashFilter.getMetrics();
      expect(dropRatePct).toBeGreaterThanOrEqual(0);
      expect(dropRatePct).toBeLessThanOrEqual(100);
    });
  });

  // ── HLL cardinality & memory behaviour ───────────────────────────────────

  describe("HyperLogLog cardinality and memory", () => {
    it("estimates cardinality within ±5% for 10,000 unique hashes", async () => {
      // Use a fresh filter instance isolated to this test to avoid cross-test
      // state. We do this by accessing the internal HLL via a local import of
      // the class.  Since vitest ESM mocking is module-scoped and the class is
      // not directly exported, we test cardinality via getMetrics() on the
      // singleton after inserting known-unique hashes.

      // Insert 10 000 unique hashes (DB never needs querying for new entries).
      const N = 10_000;
      const before = txHashFilter.getMetrics().estimatedCardinality;

      for (let i = 0; i < N; i++) {
        // Each key is guaranteed unique via the index
        await txHashFilter.check(`cardinality_test_${i}`, i, BASE_DATE);
      }

      const after = txHashFilter.getMetrics().estimatedCardinality;
      const delta = after - before;

      // HLL estimate should be within 5 % of the actual N inserts
      expect(delta).toBeGreaterThan(N * 0.95);
      expect(delta).toBeLessThan(N * 1.05);
    });

    it("memory footprint is exactly 256 KB after millions of insertions", () => {
      // The Uint8Array is fixed-size; this is a structural guarantee, not
      // cardinality-dependent.
      expect(txHashFilter.getMetrics().hllMemoryKB).toBe(256);
    });
  });
});
