/**
 * @file countMinSketch.test.ts
 * @description Unit tests for the Count‑Min Sketch and Probabilistic Eviction Engine.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CountMinSketch } from "../services/countMinSketch.js";
import { ProbabilisticEvictionEngine } from "../services/probabilisticEviction.js";

// ─── Count‑Min Sketch Tests ──────────────────────────────────────────────────

describe("CountMinSketch", () => {
  let sketch: CountMinSketch;

  beforeEach(() => {
    sketch = new CountMinSketch({ depth: 4, width: 1000 });
  });

  describe("construction", () => {
    it("uses default dimensions when no config is provided", () => {
      const s = new CountMinSketch();
      expect(s.depth).toBe(4);
      expect(s.width).toBe(100_000);
    });

    it("accepts custom depth and width", () => {
      const s = new CountMinSketch({ depth: 8, width: 512 });
      expect(s.depth).toBe(8);
      expect(s.width).toBe(512);
    });

    it("starts with zero total increments", () => {
      expect(sketch.totalIncrements).toBe(0);
    });

    it("reports correct memory footprint", () => {
      // 4 * 1000 * 4 = 16,000 bytes
      expect(sketch.memoryBytes).toBe(16_000);
    });
  });

  describe("increment & estimate", () => {
    it("estimates 0 for an unseen key", () => {
      expect(sketch.estimate("never-seen")).toBe(0);
    });

    it("estimates exact count for a single key with no collisions", () => {
      for (let i = 0; i < 100; i++) {
        sketch.increment("alice");
      }
      // Estimate should be ≥ 100 (one‑sided error guarantee).
      expect(sketch.estimate("alice")).toBeGreaterThanOrEqual(100);
      // With d=4, w=1000 and only one key, collisions are unlikely.
      expect(sketch.estimate("alice")).toBe(100);
    });

    it("never under‑estimates true frequency", () => {
      for (let i = 0; i < 50; i++) {
        sketch.increment("bob");
      }
      // The Count‑Min guarantee: estimate ≥ true count.
      expect(sketch.estimate("bob")).toBeGreaterThanOrEqual(50);
    });

    it("tracks total increment count correctly", () => {
      sketch.increment("a");
      sketch.increment("b");
      sketch.increment("c");
      expect(sketch.totalIncrements).toBe(3);
    });

    it("handles multiple distinct keys with reasonable accuracy", () => {
      // Insert 10 distinct keys, 100 times each.
      for (let k = 0; k < 10; k++) {
        for (let i = 0; i < 100; i++) {
          sketch.increment(`key-${k}`);
        }
      }
      // Each should be roughly 100 (may over‑count due to collisions).
      for (let k = 0; k < 10; k++) {
        const est = sketch.estimate(`key-${k}`);
        expect(est).toBeGreaterThanOrEqual(100);
        // With w=1000 and only 10 keys, over‑count should be modest.
        expect(est).toBeLessThanOrEqual(120);
      }
    });
  });

  describe("estimateAndIncrement", () => {
    it("returns previous estimate then increments", () => {
      // First call: estimate = 0, then increments to 1.
      const est1 = sketch.estimateAndIncrement("foo");
      expect(est1).toBe(0);

      // Second call: estimate should now be 1, then increments to 2.
      const est2 = sketch.estimateAndIncrement("foo");
      expect(est2).toBe(1);

      expect(sketch.estimate("foo")).toBe(2);
    });
  });

  describe("reset", () => {
    it("clears all counters and total", () => {
      sketch.increment("x");
      sketch.increment("x");
      sketch.increment("y");
      expect(sketch.totalIncrements).toBe(3);

      sketch.reset();
      expect(sketch.totalIncrements).toBe(0);
      expect(sketch.estimate("x")).toBe(0);
      expect(sketch.estimate("y")).toBe(0);
    });
  });

  describe("decay", () => {
    it("multiplies all counters by the factor", () => {
      for (let i = 0; i < 100; i++) {
        sketch.increment("hot");
      }
      sketch.decay(0.5);

      const est = sketch.estimate("hot");
      // Should be around 50 (floor of 100 * 0.5).
      expect(est).toBeGreaterThanOrEqual(50);
      expect(est).toBeLessThanOrEqual(60);
    });

    it("clamps totalIncrements to floor after decay", () => {
      sketch.increment("a");
      sketch.increment("b");
      sketch.increment("c");
      sketch.decay(0.5);
      // 3 * 0.5 = 1.5 → floor = 1
      expect(sketch.totalIncrements).toBe(1);
    });

    it("rejects out‑of‑range factors", () => {
      expect(() => sketch.decay(-0.1)).toThrow();
      expect(() => sketch.decay(1.5)).toThrow();
    });

    it("accepts boundary values 0 and 1", () => {
      sketch.increment("x");
      sketch.decay(1);
      expect(sketch.estimate("x")).toBeGreaterThanOrEqual(1);

      sketch.decay(0);
      expect(sketch.estimate("x")).toBe(0);
      expect(sketch.totalIncrements).toBe(0);
    });
  });

  describe("hash distribution", () => {
    it("produces different estimates for different keys (low collision rate)", () => {
      const insertCount = 500;
      // Insert many keys once each.
      for (let k = 0; k < insertCount; k++) {
        sketch.increment(`k-${k}`);
      }
      // A different set of keys should mostly show 0.
      let falsePositives = 0;
      const sampleSize = 200;
      for (let k = insertCount; k < insertCount + sampleSize; k++) {
        if (sketch.estimate(`k-${k}`) > 0) falsePositives++;
      }
      // With w=1000, d=4, and 500 distinct keys, false‑positive rate
      // should be low (around 1-3 %).  Allow up to 10 %.
      const fpr = falsePositives / sampleSize;
      expect(fpr).toBeLessThan(0.1);
    });
  });

  describe("determinism", () => {
    it("produces identical estimates for two sketches with same inserts", () => {
      const a = new CountMinSketch({ depth: 4, width: 1000 });
      const b = new CountMinSketch({ depth: 4, width: 1000 });
      const keys = ["alpha", "beta", "gamma", "delta"];
      for (const key of keys) {
        for (let i = 0; i < 10; i++) {
          a.increment(key);
          b.increment(key);
        }
      }
      for (const key of keys) {
        expect(a.estimate(key)).toBe(b.estimate(key));
      }
    });
  });
});

// ─── Probabilistic Eviction Engine Tests ─────────────────────────────────────

describe("ProbabilisticEvictionEngine", () => {
  let engine: ProbabilisticEvictionEngine;

  beforeEach(() => {
    engine = new ProbabilisticEvictionEngine({
      sketch: { depth: 4, width: 1000 },
      maxMultiplier: 3,
      decayIntervalMs: 0, // disable auto‑decay in tests
      decayFactor: 0.75,
    });
  });

  describe("construction", () => {
    it("creates engine with sensible defaults", () => {
      const e = new ProbabilisticEvictionEngine({ decayIntervalMs: 0 });
      expect(e.memoryBytes).toBeGreaterThan(0);
      expect(e.memoryBytes).toBeLessThan(10_000_000); // under 10 MB
      expect(e.totalAccesses).toBe(0);
      e.destroy();
    });

    it("respects custom sketch dimensions", () => {
      const e = new ProbabilisticEvictionEngine({
        sketch: { depth: 8, width: 500 },
        decayIntervalMs: 0,
      });
      // 8 × 500 × 4 = 16,000 bytes
      expect(e.memoryBytes).toBe(16_000);
      e.destroy();
    });
  });

  describe("recordAccess", () => {
    it("increases total access count", () => {
      engine.recordAccess("q:org.get");
      expect(engine.totalAccesses).toBe(1);

      engine.recordAccess("q:org.get");
      expect(engine.totalAccesses).toBe(2);
    });

    it("makes hot keys report higher frequency than cold keys", () => {
      for (let i = 0; i < 50; i++) {
        engine.recordAccess("hot-key");
      }
      engine.recordAccess("cold-key");

      expect(engine.getFrequency("hot-key")).toBeGreaterThan(engine.getFrequency("cold-key"));
    });
  });

  describe("getAdaptiveTTL", () => {
    it("returns base TTL for cold (never‑seen) keys", () => {
      expect(engine.getAdaptiveTTL("unknown", 5)).toBe(5);
    });

    it("returns higher TTL for frequently accessed keys", () => {
      // Warm up the key.
      for (let i = 0; i < 100; i++) {
        engine.recordAccess("popular");
      }

      const coldTTL = engine.getAdaptiveTTL("cold", 5);
      const hotTTL = engine.getAdaptiveTTL("popular", 5);

      expect(hotTTL).toBeGreaterThan(coldTTL);
      // Max multiplier is 3, so TTL should be ≤ 15.
      expect(hotTTL).toBeLessThanOrEqual(15);
    });

    it("does not exceed baseTTL * maxMultiplier", () => {
      for (let i = 0; i < 10000; i++) {
        engine.recordAccess("super-hot");
      }
      const ttl = engine.getAdaptiveTTL("super-hot", 10);
      expect(ttl).toBeLessThanOrEqual(30); // 10 * 3
    });
  });

  describe("recordAndGetTTL", () => {
    it("increments frequency AND returns adaptive TTL in one call", () => {
      const ttl1 = engine.recordAndGetTTL("key", 5);
      // First access → cold, estimate = 0 before increment.
      expect(ttl1).toBe(5);

      const ttl2 = engine.recordAndGetTTL("key", 5);
      // Second access → estimate ≥ 1 after first increment.
      expect(ttl2).toBeGreaterThanOrEqual(5);
    });
  });

  describe("forceDecay", () => {
    it("reduces all frequency estimates", () => {
      for (let i = 0; i < 100; i++) {
        engine.recordAccess("decay-test");
      }
      const before = engine.getFrequency("decay-test");

      engine.forceDecay(); // × 0.75

      const after = engine.getFrequency("decay-test");
      expect(after).toBeLessThan(before);
      expect(after).toBeGreaterThan(0);
    });
  });

  describe("destroy", () => {
    it("clears the decay timer without throwing", () => {
      const e = new ProbabilisticEvictionEngine({
        decayIntervalMs: 60_000, // 1 min — low overhead
      });
      expect(() => e.destroy()).not.toThrow();
    });
  });

  describe("memory bound", () => {
    it("stays under 10 MB for default configuration", () => {
      const e = new ProbabilisticEvictionEngine({ decayIntervalMs: 0 });
      expect(e.memoryBytes).toBeLessThan(10_000_000);
      e.destroy();
    });

    it("stays under 10 MB for a larger configuration", () => {
      const e = new ProbabilisticEvictionEngine({
        sketch: { depth: 6, width: 200_000 },
        decayIntervalMs: 0,
      });
      // 6 × 200,000 × 4 = 4,800,000 bytes ≈ 4.8 MB
      expect(e.memoryBytes).toBeLessThan(10_000_000);
      e.destroy();
    });
  });

  describe("relative ordering", () => {
    it("preserves relative frequency ordering despite collisions", () => {
      // Hot key gets 500 inserts, warm gets 100, cold gets 1.
      for (let i = 0; i < 500; i++) engine.recordAccess("hot");
      for (let i = 0; i < 100; i++) engine.recordAccess("warm");
      engine.recordAccess("cold");

      const hotFreq = engine.getFrequency("hot");
      const warmFreq = engine.getFrequency("warm");
      const coldFreq = engine.getFrequency("cold");

      // Relative ordering must be preserved.
      expect(hotFreq).toBeGreaterThan(warmFreq);
      expect(warmFreq).toBeGreaterThan(coldFreq);
    });
  });
});
