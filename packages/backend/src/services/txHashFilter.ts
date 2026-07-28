/**
 * @file txHashFilter.ts
 * @description In-memory HyperLogLog filter for probabilistic deduplication of
 * Stellar transaction hashes before they reach the database.
 *
 * ## Strategy
 *
 * 1. **HLL fast path** – A native HyperLogLog (no external dependency) is kept
 *    in-process.  `add(key)` returns `true` when the hash was already seen
 *    (likely duplicate).  The implementation uses 2^18 = 262,144 registers
 *    which gives a standard error of ~0.051 % — comfortably under the 0.1 %
 *    requirement.  At 262,144 bytes (one byte per register) the structure uses
 *    exactly 256 KB; it stays well under 50 MB even after many warm-up cycles.
 *
 * 2. **DB confirmation on positive hit** – Because HLLs have false positives
 *    (they never produce false negatives), any `add()` that signals a duplicate
 *    triggers a cheap `prisma.transaction.findFirst` to confirm the hash really
 *    exists in the database before suppressing the event.  This guarantees zero
 *    valid payloads are dropped.
 *
 * 3. **Graceful degradation** – If Redis (used only for optional cross-process
 *    state synchronisation in the future) or any internal path fails, the filter
 *    returns `false` and lets normal DB upsert idempotency take over.
 *
 * ## Public API
 *
 * ```ts
 * const isDuplicate = await txHashFilter.check(txHash, eventIndex, createdAt);
 * if (isDuplicate) return; // drop — already processed
 * ```
 */

import { createHash } from 'node:crypto';
import { prisma } from './db.js';
import { logger } from '../utils/logger.js';

// ─── HyperLogLog constants ────────────────────────────────────────────────────

/**
 * Number of register bits (b).  With b = 18 we get m = 2^18 = 262,144
 * registers, a standard error of 1.04 / sqrt(m) ≈ 0.051 % and a fixed
 * 256 KB footprint.
 */
const HLL_B = 18;
const HLL_M = 1 << HLL_B; // 262 144
const HLL_ALPHA_MM = 0.7213 / (1 + 1.079 / HLL_M) * HLL_M * HLL_M;

// ─── MurmurHash3 (32-bit, seed 0) ────────────────────────────────────────────
// A pure-JS implementation used to map a string key to a 32-bit hash.
// MurmurHash3 has excellent avalanche properties and is faster than SHA-256
// for this hot path.

function murmur3(key: string): number {
  const bytes = Buffer.from(key, 'utf8');
  const len = bytes.length;
  let h = 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  const nblocks = (len >> 2);
  for (let i = 0; i < nblocks; i++) {
    let k = bytes.readUInt32LE(i * 4);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  let tail = 0;
  const offset = nblocks * 4;
  const rem = len & 3;
  if (rem >= 3) tail ^= bytes[offset + 2]! << 16;
  if (rem >= 2) tail ^= bytes[offset + 1]! << 8;
  if (rem >= 1) {
    tail ^= bytes[offset]!;
    tail = Math.imul(tail, c1);
    tail = (tail << 15) | (tail >>> 17);
    tail = Math.imul(tail, c2);
    h ^= tail;
  }

  h ^= len;
  // fmix32
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0; // coerce to unsigned
}

// ─── Native HyperLogLog ───────────────────────────────────────────────────────

/**
 * Minimal HyperLogLog implementation using 8-bit registers (max rho = 64).
 *
 * Memory: HLL_M bytes = 256 KB.  Stable at any cardinality — old registers are
 * overwritten only when a higher leading-zero count is found.
 */
class HyperLogLog {
  /** One Uint8Array register bank — 256 KB, never grows. */
  private readonly registers: Uint8Array;

  constructor() {
    this.registers = new Uint8Array(HLL_M);
  }

  /**
   * Add a string key.
   * @returns `true` if the key was already present (likely duplicate),
   *          `false` if it appears to be new.
   */
  add(key: string): boolean {
    const h = murmur3(key);
    // The top HLL_B bits select the register index.
    const idx = h >>> (32 - HLL_B);
    // The remaining 32 - HLL_B bits determine ρ (position of the leftmost 1-bit).
    const w = (h << HLL_B) | (1 << (HLL_B - 1)); // bring remainder to top; ensure non-zero
    const rho = Math.clz32(w) + 1;

    const current = this.registers[idx]!;
    if (rho <= current) {
      // Register was already at least this high — the key has been seen.
      return true;
    }
    this.registers[idx] = rho;
    return false;
  }

  /**
   * Estimate the current cardinality (number of distinct items seen).
   * Exposed for observability / metrics.
   */
  estimateCardinality(): number {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < HLL_M; i++) {
      sum += Math.pow(2, -(this.registers[i]!));
      if (this.registers[i] === 0) zeros++;
    }
    let estimate = HLL_ALPHA_MM / sum;
    // Small-range correction
    if (estimate <= 2.5 * HLL_M && zeros > 0) {
      estimate = HLL_M * Math.log(HLL_M / zeros);
    }
    return estimate;
  }

  /** Return raw memory footprint in bytes. */
  get byteLength(): number {
    return this.registers.byteLength;
  }
}

// ─── TxHashFilter ─────────────────────────────────────────────────────────────

export interface FilterResult {
  /** Whether the event should be dropped as a duplicate. */
  isDuplicate: boolean;
  /** Where the decision was made. */
  decidedBy: 'hll_new' | 'hll_positive_db_confirmed' | 'hll_positive_db_miss' | 'fallback_allowed';
}

/**
 * Builds the canonical dedup key for a transaction event.
 *
 * Mirrors the Prisma unique constraint: `@@unique([txHash, eventIndex, createdAt])`.
 * We hash it through SHA-256 so the HLL register slots are uniformly distributed
 * even when txHash values share a common prefix (as Stellar hashes do).
 */
function buildDedupKey(txHash: string, eventIndex: number, createdAt: Date): string {
  const raw = `${txHash}:${eventIndex}:${createdAt.toISOString()}`;
  return createHash('sha256').update(raw).digest('hex');
}

class TxHashFilter {
  private readonly hll: HyperLogLog;

  /** Total events evaluated since process start. */
  private totalChecked = 0;
  /** Events dropped by the HLL without hitting the DB. */
  private droppedByHll = 0;
  /** False positives confirmed as real events by the DB. */
  private falsePositivesConfirmed = 0;

  constructor() {
    this.hll = new HyperLogLog();
    logger.info(
      {
        registers: HLL_M,
        memoryKB: HLL_M / 1024,
        stdErrorPct: ((1.04 / Math.sqrt(HLL_M)) * 100).toFixed(3),
      },
      '[TxHashFilter] Initialised in-process HyperLogLog',
    );
  }

  /**
   * Check whether a transaction event is a duplicate and should be suppressed.
   *
   * Decision flow:
   *  1. Build a deterministic dedup key from (txHash, eventIndex, createdAt).
   *  2. Probe the in-process HLL.
   *     a. HLL says **new** → record in HLL and return `isDuplicate: false`.
   *     b. HLL says **seen** → confirm against the DB.
   *        - DB row found   → true duplicate, return `isDuplicate: true`.
   *        - DB row missing → false positive, return `isDuplicate: false`.
   *  3. On any unexpected error → return `isDuplicate: false` (safe fallback).
   */
  async check(txHash: string, eventIndex: number, createdAt: Date): Promise<FilterResult> {
    this.totalChecked++;
    const key = buildDedupKey(txHash, eventIndex, createdAt);

    try {
      const wasAlreadySeen = this.hll.add(key);

      if (!wasAlreadySeen) {
        // Fast path: the HLL register was updated — this is a new event.
        return { isDuplicate: false, decidedBy: 'hll_new' };
      }

      // ── Positive hit: confirm against the database ──────────────────────────
      // The HLL can report "seen" for a key it genuinely has not seen (false
      // positive).  We do a lightweight DB count query to guard against this.
      const existing = await prisma.transaction.findFirst({
        where: { txHash, eventIndex, createdAt },
        select: { id: true },
      });

      if (existing) {
        // Confirmed duplicate — safe to drop without any further DB work.
        this.droppedByHll++;
        logger.debug(
          { txHash, eventIndex, decidedBy: 'hll_positive_db_confirmed' },
          '[TxHashFilter] Duplicate suppressed',
        );
        return { isDuplicate: true, decidedBy: 'hll_positive_db_confirmed' };
      }

      // False positive — the HLL thought it had seen this key, but the DB
      // has no matching row.  Allow processing to continue normally.
      this.falsePositivesConfirmed++;
      logger.debug(
        { txHash, eventIndex, decidedBy: 'hll_positive_db_miss' },
        '[TxHashFilter] HLL false positive — allowing event through',
      );
      return { isDuplicate: false, decidedBy: 'hll_positive_db_miss' };

    } catch (err) {
      // Never drop a valid event due to a filter error — degrade gracefully.
      logger.error(
        { err, txHash, eventIndex },
        '[TxHashFilter] Error during dedup check — allowing event through (safe fallback)',
      );
      return { isDuplicate: false, decidedBy: 'fallback_allowed' };
    }
  }

  /**
   * Returns current operational metrics for observability / health endpoints.
   */
  getMetrics(): {
    totalChecked: number;
    droppedByHll: number;
    falsePositivesConfirmed: number;
    estimatedCardinality: number;
    hllMemoryKB: number;
    dropRatePct: number;
  } {
    const dropRatePct =
      this.totalChecked > 0
        ? (this.droppedByHll / this.totalChecked) * 100
        : 0;

    return {
      totalChecked: this.totalChecked,
      droppedByHll: this.droppedByHll,
      falsePositivesConfirmed: this.falsePositivesConfirmed,
      estimatedCardinality: Math.round(this.hll.estimateCardinality()),
      hllMemoryKB: this.hll.byteLength / 1024,
      dropRatePct: Math.round(dropRatePct * 100) / 100,
    };
  }
}

/** Singleton used by IndexerService. */
export const txHashFilter = new TxHashFilter();
