/**
 * @file probabilisticEviction.ts
 * @description Probabilistic cache-eviction engine powered by a Count‑Min Sketch.
 *
 * This engine tracks the frequency of every cache-key read and dynamically
 * adjusts the TTL of that key so that **hot** queries (those with a high
 * estimated access rate) are retained longer in the cache, while **cold**
 * queries are allowed to expire quickly.
 *
 * ## Design Rationale
 *
 * Traditional LRU / LFU caches require per‑key metadata (linked‑list nodes or
 * access counters) that grows linearly with the number of distinct keys.  For
 * a multi‑tenant database of maintainers this can easily exceed tens of MB.
 *
 * A Count‑Min Sketch replaces per‑key counters with a fixed‑size matrix of
 * probabilistic counters.  Hash collisions cause occasional over‑counts, but
 * the over‑count is bounded and almost never alters the *relative ordering* of
 * keys, which is all we need for eviction decisions.
 *
 * ## TTL Strategy
 *
 * Every key starts with a `baseTTL` (the caller‑provided minimum).  The engine
 * computes a *frequency score* in [0, 1] by normalising the Count‑Min estimate
 * against the global maximum estimate, then scales the TTL linearly:
 *
 *   adaptiveTTL = baseTTL * (1 + frequencyScore * (maxMultiplier - 1))
 *
 * With `maxMultiplier = 3`, a key that is in the hottest percentile gets 3×
 * the base TTL; a cold key gets exactly the base TTL.
 *
 * A **periodic decay** job (every 10 minutes by default) multiplies all
 * counters by 0.75 so that recent access patterns dominate old history.
 *
 * ## Memory
 *
 * Default sketch: depth=4, width=100_000 → **1.6 MB**.
 * The JS object overhead is < 1 KB.
 * Well within the 10 MB acceptance‑criteria ceiling.
 */

import { CountMinSketch } from "./countMinSketch.js";
import type { CountMinSketchConfig } from "./countMinSketch.js";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ProbabilisticEvictionConfig {
  /** Count‑Min Sketch dimensionality (passed through). */
  sketch?: CountMinSketchConfig;
  /**
   * Maximum TTL multiplier for the hottest keys.
   * E.g. 3 means a key in the top percentile gets baseTTL × 3.
   * Default: 3
   */
  maxMultiplier?: number;
  /**
   * Interval (ms) between automatic decay cycles.
   * Set to 0 to disable.  Default: 600_000 (10 min).
   */
  decayIntervalMs?: number;
  /**
   * Decay factor applied each cycle.  0.75 means counters drop to ¾.
   * Default: 0.75
   */
  decayFactor?: number;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class ProbabilisticEvictionEngine {
  private readonly sketch: CountMinSketch;
  private readonly maxMultiplier: number;
  private readonly decayFactor: number;
  private readonly decayIntervalMs: number;

  /** Running maximum estimate seen since last decay — used for normalisation. */
  private _maxEstimate = 0;

  private _decayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ProbabilisticEvictionConfig = {}) {
    this.sketch = new CountMinSketch(config.sketch);
    this.maxMultiplier = config.maxMultiplier ?? 3;
    this.decayFactor = config.decayFactor ?? 0.75;
    this.decayIntervalMs = config.decayIntervalMs ?? 600_000;

    if (this.decayIntervalMs > 0) {
      this._startDecayLoop();
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Record one read access for `cacheKey`.
   *
   * Call this **every time** a cache hit occurs, so the sketch learns which
   * keys are hot.
   */
  recordAccess(cacheKey: string): void {
    this.sketch.increment(cacheKey);
  }

  /**
   * Record one access and immediately return the adaptive TTL for a
   * fresh `safeSet` call (convenience wrapper).
   *
   * @param cacheKey  The cache key being written.
   * @param baseTTL   The minimum TTL (seconds) the caller would use.
   * @returns         Adjusted TTL in **seconds**.
   */
  recordAndGetTTL(cacheKey: string, baseTTL: number): number {
    const estimate = this.sketch.estimateAndIncrement(cacheKey);
    return this._computeTTL(estimate, baseTTL);
  }

  /**
   * Return the adaptive TTL for `cacheKey` **without** recording an access.
   *
   * Use this when you need to *set* a cache entry without double‑counting.
   */
  getAdaptiveTTL(cacheKey: string, baseTTL: number): number {
    const estimate = this.sketch.estimate(cacheKey);
    return this._computeTTL(estimate, baseTTL);
  }

  /**
   * Estimated frequency of `cacheKey`.
   */
  getFrequency(cacheKey: string): number {
    return this.sketch.estimate(cacheKey);
  }

  /**
   * Estimated memory footprint of the underlying sketch in bytes.
   */
  get memoryBytes(): number {
    return this.sketch.memoryBytes;
  }

  /**
   * Total number of access records across all keys.
   */
  get totalAccesses(): number {
    return this.sketch.totalIncrements;
  }

  /**
   * Immediately apply a decay cycle (useful for testing / manual intervention).
   */
  forceDecay(): void {
    this.sketch.decay(this.decayFactor);
    this._maxEstimate = Math.floor(this._maxEstimate * this.decayFactor);
  }

  /**
   * Shut down the periodic decay timer.  Call during graceful shutdown.
   */
  destroy(): void {
    if (this._decayTimer !== null) {
      clearInterval(this._decayTimer);
      this._decayTimer = null;
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Compute an adaptive TTL given the estimated access count.
   *
   *   frequencyScore = clamp(estimate / maxEstimate, 0, 1)
   *   adaptiveTTL    = baseTTL * (1 + frequencyScore * (maxMultiplier - 1))
   */
  private _computeTTL(estimate: number, baseTTL: number): number {
    // Update the running max (monotonically increasing between decays).
    if (estimate > this._maxEstimate) {
      this._maxEstimate = estimate;
    }

    if (this._maxEstimate === 0 || estimate === 0) {
      return baseTTL;
    }

    const frequencyScore = Math.min(estimate / this._maxEstimate, 1);
    const multiplier = 1 + frequencyScore * (this.maxMultiplier - 1);

    // Round to nearest integer second — sub‑second TTLs are not useful.
    return Math.round(baseTTL * multiplier);
  }

  private _startDecayLoop(): void {
    this._decayTimer = setInterval(() => {
      this.forceDecay();
    }, this.decayIntervalMs);
    // Allow the process to exit even if the timer is still pending.
    if (this._decayTimer && typeof this._decayTimer === "object" && "unref" in this._decayTimer) {
      (this._decayTimer as NodeJS.Timeout).unref();
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

/**
 * Global singleton for the probabilistic eviction engine.
 *
 * Import this in the tRPC router and/or cache‑wrapping code.
 * Configuration can be overridden via environment variables:
 *
 *   CMS_DEPTH  — Count‑Min Sketch depth (default 4)
 *   CMS_WIDTH  — Count‑Min Sketch width (default 100_000)
 *   EVICTION_MAX_MULTIPLIER  — Max TTL multiplier (default 3)
 */
export const evictionEngine = new ProbabilisticEvictionEngine({
  sketch: {
    depth: parseInt(process.env["CMS_DEPTH"] ?? "4", 10),
    width: parseInt(process.env["CMS_WIDTH"] ?? "100000", 10),
  },
  maxMultiplier: parseFloat(process.env["EVICTION_MAX_MULTIPLIER"] ?? "3"),
});
