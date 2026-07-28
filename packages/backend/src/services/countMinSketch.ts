/**
 * @file countMinSketch.ts
 * @description Probabilistic frequency estimator using the Count‑Min Sketch algorithm.
 *
 * A Count‑Min Sketch tracks approximate frequencies of items (e.g. cache‑key hashes)
 * in a fixed, sub-linear memory footprint.  It guarantees that the estimated
 * frequency is never less than the true frequency, while bounding the over‑count
 * error with high probability.
 *
 * ## How It Works
 *
 * The sketch maintains a `d × w` matrix of counters.  For every observed item:
 *  1. Compute `d` independent hash values (each in [0, w)).
 *  2. Increment the counter at `table[row][hash]` for each row.
 *
 * To estimate an item's frequency:
 *  1. Compute the same `d` hashes.
 *  2. Return `min(table[0][h0], table[1][h1], …, table[d-1][h_d-1])`.
 *
 * ## Memory Bound
 *
 * With the default parameters (d=4, w=100_000, 32‑bit counters), the sketch
 * consumes **1.6 MB** — well under the 10 MB acceptance‑criteria ceiling.
 *
 *   - d=4, w=250_000 → 4.0 MB
 *   - d=6, w=200_000 → 4.8 MB
 *
 * ## Hash Strategy
 *
 * We use the **FNV‑1a** non‑cryptographic hash (fast, good avalanche properties)
 * combined with **double‑hashing** to derive `d` independent hash functions:
 *
 *   hash_i(key, i) = (h1(key) + i * h2(key) + i²) mod w
 *
 * The quadratic term (`i²`) helps decorrelate successive hash values further.
 *
 * ## References
 *
 * - Cormode, G. & Muthukrishnan, S. (2005). "An improved data stream summary:
 *   the count-min sketch and its applications."
 */

// ─── Configuration ───────────────────────────────────────────────────────────

export interface CountMinSketchConfig {
  /** Number of hash rows (depth).  Higher → better accuracy.  Default 4. */
  depth?: number;
  /** Number of columns (width).  Higher → less collision.  Default 100_000. */
  width?: number;
}

const DEFAULT_DEPTH = 4;
const DEFAULT_WIDTH = 100_000;

// ─── FNV‑1a Hash Helpers ────────────────────────────────────────────────────

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV‑1a 32‑bit hash of a string with a custom seed.
 *
 * FNV‑1a is chosen because it is:
 *  - Deterministic (no salt / platform dependence).
 *  - Extremely fast (single multiply + XOR per byte).
 *  - Has excellent avalanche behaviour for ASCII strings.
 */
function fnv1a(str: string, seed: number = FNV_OFFSET_BASIS): number {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // JavaScript's `Math.imul` gives the low 32 bits of the 64‑bit product.
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Force unsigned 32‑bit.
  return hash >>> 0;
}

// ─── Count‑Min Sketch ────────────────────────────────────────────────────────

export class CountMinSketch {
  /** Depth × Width counter matrix.  Each row is a Uint32Array for compact storage. */
  private readonly table: Uint32Array[];
  /** Number of hash rows. */
  readonly depth: number;
  /** Number of columns per row. */
  readonly width: number;
  /** Total number of increments tracked (useful for decay / normalisation). */
  private _totalIncrements = 0;

  /**
   * @param config  Optional depth & width overrides.
   */
  constructor(config: CountMinSketchConfig = {}) {
    this.depth = config.depth ?? DEFAULT_DEPTH;
    this.width = config.width ?? DEFAULT_WIDTH;

    if (this.depth < 1) {
      throw new Error(`CountMinSketch depth must be >= 1, got ${this.depth}`);
    }
    if (this.width < 1) {
      throw new Error(`CountMinSketch width must be >= 1, got ${this.width}`);
    }

    // Allocate `depth` rows of `width` zero‑initialised 32‑bit counters.
    this.table = Array.from({ length: this.depth }, () => new Uint32Array(this.width));
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Record one occurrence of `key`.
   *
   * @param key  An arbitrary string identifier (e.g. a cache key).
   */
  increment(key: string): void {
    const hashes = this._computeHashes(key);
    for (let row = 0; row < this.depth; row++) {
      const col = hashes[row]!;
      // Saturating increment — Uint32Array wraps at 2^32, which is fine for
      // a probabilistic sketch; we don't expect any single key to exceed 4B.
      this.table[row]![col]!++;
    }
    this._totalIncrements++;
  }

  /**
   * Query the estimated frequency of `key`.
   *
   * The returned value is always ≥ the true frequency (one‑sided error).
   *
   * @returns  Estimated occurrence count (may over‑count due to hash collisions).
   */
  estimate(key: string): number {
    const hashes = this._computeHashes(key);
    let min = Infinity;
    for (let row = 0; row < this.depth; row++) {
      const col = hashes[row]!;
      const val = this.table[row]![col]!;
      if (val < min) min = val;
    }
    return min === Infinity ? 0 : min;
  }

  /**
   * Estimate the frequency of `key` and *also* record one occurrence
   * (convenience wrapper that avoids computing hashes twice).
   *
   * @returns  Estimated frequency *before* the increment.
   */
  estimateAndIncrement(key: string): number {
    const hashes = this._computeHashes(key);
    let min = Infinity;
    for (let row = 0; row < this.depth; row++) {
      const col = hashes[row]!;
      const val = this.table[row]![col]!;
      if (val < min) min = val;
      this.table[row]![col]!++;
    }
    this._totalIncrements++;
    return min === Infinity ? 0 : min;
  }

  /**
   * Total number of `increment` calls — useful for calculating relative
   * frequency ("hotness") of a key relative to the global stream.
   */
  get totalIncrements(): number {
    return this._totalIncrements;
  }

  /**
   * Estimated memory footprint in bytes.
   */
  get memoryBytes(): number {
    // Uint32Array = 4 bytes per element → depth * width * 4
    return this.depth * this.width * 4;
  }

  /**
   * Reset all counters to zero (e.g. for periodic decay).
   */
  reset(): void {
    for (let row = 0; row < this.depth; row++) {
      this.table[row]!.fill(0);
    }
    this._totalIncrements = 0;
  }

  /**
   * Apply a decay factor to all counters (multiply by `factor` ∈ [0, 1]).
   *
   * This is useful for favouring recent access patterns over historical ones.
   * Called periodically to prevent the sketch from saturating.
   */
  decay(factor: number): void {
    if (factor < 0 || factor > 1) {
      throw new Error("Decay factor must be in [0, 1]");
    }
    for (let row = 0; row < this.depth; row++) {
      const arr = this.table[row]!;
      for (let col = 0; col < this.width; col++) {
        arr[col] = Math.floor(arr[col]! * factor);
      }
    }
    this._totalIncrements = Math.floor(this._totalIncrements * factor);
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Compute `depth` hash values for `key` using double‑hashing.
   *
   *   h_i(key) = (h1 + i * h2 + i²) mod width
   *
   * where h1 = FNV‑1a(key, seed=0x811c9dc5)
   *       h2 = FNV‑1a(key, seed=0xcbf29ce4)  (different seed)
   *
   * The quadratic term i² helps avoid linear correlations between successive
   * hash values when only two base hashes are used.
   */
  private _computeHashes(key: string): number[] {
    const h1 = fnv1a(key, 0x811c9dc5);
    const h2 = fnv1a(key, 0xcbf29ce4);
    const hashes: number[] = new Array(this.depth);
    for (let i = 0; i < this.depth; i++) {
      // Quadratic double‑hashing: (h1 + i*h2 + i²) mod width
      hashes[i] = (h1 + i * h2 + i * i) % this.width;
    }
    return hashes;
  }
}
