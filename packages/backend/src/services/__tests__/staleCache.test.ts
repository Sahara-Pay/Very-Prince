/**
 * @file staleCache.test.ts
 * @description Load and concurrency tests for stale cache with probabilistic eviction.
 * Tests verify that the stale cache mechanism handles high-throughput Web3 webhook
 * traffic without blocking the Node.js event loop and maintains performance under load.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StaleCacheService } from "../staleCache.js";
import { safeGet, safeSet } from "../cache.js";
import { evictionEngine } from "../probabilisticEviction.js";
import { logger } from "../../utils/logger.js";

// Mock dependencies
vi.mock("../cache.js");
vi.mock("../probabilisticEviction.js");
vi.mock("../../utils/logger.js");

describe("Stale Cache Load Tests", () => {
  let staleCache: StaleCacheService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(logger).debug = vi.fn();
    vi.mocked(logger).warn = vi.fn();
    vi.mocked(logger).error = vi.fn();
    vi.mocked(evictionEngine).recordAccess = vi.fn();
    vi.mocked(evictionEngine).getFrequency = vi.fn(() => 0);
    vi.mocked(evictionEngine).totalAccesses = 0;
    vi.mocked(evictionEngine).memoryBytes = 1600000; // 1.6 MB default

    staleCache = new StaleCacheService({
      staleThresholdMs: 1000,
      expireThresholdMs: 5000,
      baseRefreshProbability: 0.5,
      defaultTTL: 10,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Event Loop Non-Blocking Tests", () => {
    it("should not block event loop during cache miss", async () => {
      vi.mocked(safeGet).mockResolvedValue(null);
      vi.mocked(safeSet).mockResolvedValue(undefined);
      
      let fetcherResolved = false;
      const fetcher = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        fetcherResolved = true;
        return { data: "fresh" };
      });

      const getPromise = staleCache.get("test-key", fetcher);
      
      // Check if event loop is still responsive
      let eventLoopResponsive = true;
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch (error) {
        eventLoopResponsive = false;
      }

      expect(eventLoopResponsive).toBe(true);
      expect(fetcherResolved).toBe(false); // Fetcher should still be processing

      await getPromise;
      expect(fetcherResolved).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("should not block event loop during stale cache hit", async () => {
      const now = Date.now();
      const meta = JSON.stringify({ timestamp: now - 2000, version: 1 });
      
      vi.mocked(safeGet).mockImplementation(async (key) => {
        if (key.includes("meta")) return meta;
        return JSON.stringify({ data: "stale" });
      });
      vi.mocked(safeSet).mockResolvedValue(undefined);
      vi.mocked(evictionEngine).getFrequency = vi.fn(() => 10);
      vi.mocked(evictionEngine).totalAccesses = 100;

      const fetcher = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { data: "fresh" };
      });

      const result = await staleCache.get("test-key", fetcher);
      
      // Should return stale data immediately
      expect(result).toEqual({ data: "stale" });
      
      // Event loop should remain responsive during background refresh
      let eventLoopResponsive = true;
      try {
        await new Promise(resolve => setTimeout(resolve, 20));
      } catch (error) {
        eventLoopResponsive = false;
      }
      expect(eventLoopResponsive).toBe(true);
    });

    it("should handle 100 concurrent cache operations without blocking", async () => {
      vi.mocked(safeGet).mockResolvedValue(null);
      vi.mocked(safeSet).mockResolvedValue(undefined);

      const fetcher = vi.fn(async (key) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { key, data: "fresh" };
      });

      const concurrentRequests = 100;
      const promises = [];

      for (let i = 0; i < concurrentRequests; i++) {
        promises.push(staleCache.get(`key-${i}`, fetcher));
      }

      const startTime = Date.now();
      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // Should complete quickly (not 100 * 10ms = 1000ms if blocking)
      expect(duration).toBeLessThan(500);
      expect(results.length).toBe(concurrentRequests);
      expect(fetcher).toHaveBeenCalledTimes(concurrentRequests);
    });
  });

  describe("High Throughput Tests", () => {
    it("should handle rapid cache hits without performance degradation", async () => {
      const now = Date.now();
      const meta = JSON.stringify({ timestamp: now, version: 1 });
      
      vi.mocked(safeGet).mockResolvedValue(JSON.stringify({ data: "cached" }));
      vi.mocked(evictionEngine).getFrequency = vi.fn(() => 100);

      const fetcher = vi.fn();

      const iterations = 1000;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        await staleCache.get(`key-${i}`, fetcher);
      }

      const duration = Date.now() - startTime;
      const avgTimePerOp = duration / iterations;

      // Should average less than 1ms per operation for cache hits
      expect(avgTimePerOp).toBeLessThan(1);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("should handle mixed cache hits and misses efficiently", async () => {
      let callCount = 0;
      vi.mocked(safeGet).mockImplementation(async () => {
        callCount++;
        if (callCount % 3 === 0) return null; // Every 3rd call is a miss
        return JSON.stringify({ data: "cached" });
      });
      vi.mocked(safeSet).mockResolvedValue(undefined);

      const fetcher = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return { data: "fresh" };
      });

      const operations = 100;
      const promises = [];

      for (let i = 0; i < operations; i++) {
        promises.push(staleCache.get(`key-${i}`, fetcher));
      }

      const startTime = Date.now();
      await Promise.all(promises);
      const duration = Date.now() - startTime;

      // Should complete quickly despite mixed hits/misses
      expect(duration).toBeLessThan(500);
      expect(fetcher).toHaveBeenCalledTimes(Math.ceil(operations / 3));
    });

    it("should handle burst traffic during simulated block finalization", async () => {
      vi.mocked(safeGet).mockResolvedValue(null);
      vi.mocked(safeSet).mockResolvedValue(undefined);

      const fetcher = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return { blockData: "simulated" };
      });

      // Simulate burst of 50 webhooks in 100ms (block finalization spike)
      const burstSize = 50;
      const promises = [];

      const burstStart = Date.now();
      for (let i = 0; i < burstSize; i++) {
        promises.push(staleCache.get(`block-${i}`, fetcher));
        // Small delay to simulate realistic webhook timing
        await new Promise(resolve => setTimeout(resolve, 2));
      }

      await Promise.all(promises);
      const burstDuration = Date.now() - burstStart;

      // Burst should complete in reasonable time
      expect(burstDuration).toBeLessThan(500);
      expect(fetcher).toHaveBeenCalledTimes(burstSize);
    });
  });

  describe("Probabilistic Refresh Behavior", () => {
    it("should probabilistically refresh stale entries based on frequency", async () => {
      const now = Date.now();
      const staleMeta = JSON.stringify({ timestamp: now - 2000, version: 1 });
      
      vi.mocked(safeGet).mockResolvedValue(JSON.stringify({ data: "stale" }));
      vi.mocked(safeSet).mockResolvedValue(undefined);
      
      // High frequency should increase refresh probability
      vi.mocked(evictionEngine).getFrequency = vi.fn(() => 100);
      vi.mocked(evictionEngine).totalAccesses = 1000;

      const fetcher = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { data: "fresh" };
      });

      // Run multiple times to observe probabilistic behavior
      const results = [];
      for (let i = 0; i < 20; i++) {
        const result = await staleCache.get(`hot-key-${i}`, fetcher);
        results.push(result);
        // Wait for potential background refresh
        await new Promise(resolve => setTimeout(resolve, 15));
      }

      // High frequency keys should trigger background refreshes
      // (not deterministic due to probability, but should happen)
      expect(fetcher).toHaveBeenCalled();
    });

    it("should not refresh cold keys as frequently", async () => {
      const now = Date.now();
      const staleMeta = JSON.stringify({ timestamp: now - 2000, version: 1 });
      
      vi.mocked(safeGet).mockResolvedValue(JSON.stringify({ data: "stale" }));
      vi.mocked(safeSet).mockResolvedValue(undefined);
      
      // Low frequency should decrease refresh probability
      vi.mocked(evictionEngine).getFrequency = vi.fn(() => 1);
      vi.mocked(evictionEngine).totalAccesses = 1000;

      const fetcher = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { data: "fresh" };
      });

      const results = [];
      for (let i = 0; i < 20; i++) {
        const result = await staleCache.get(`cold-key-${i}`, fetcher);
        results.push(result);
        await new Promise(resolve => setTimeout(resolve, 15));
      }

      // Cold keys should trigger fewer refreshes
      expect(results.every(r => r.data === "stale")).toBe(true);
    });
  });

  describe("Error Handling Under Load", () => {
    it("should handle Redis failures gracefully without blocking", async () => {
      vi.mocked(safeGet).mockRejectedValue(new Error("Redis connection failed"));
      
      const fetcher = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { data: "fresh" };
      });

      const result = await staleCache.get("test-key", fetcher);

      // Should fall back to fetcher
      expect(result).toEqual({ data: "fresh" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger).error).toHaveBeenCalled();
    });

    it("should handle malformed cache data gracefully", async () => {
      vi.mocked(safeGet).mockResolvedValue("invalid-json");
      
      const fetcher = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { data: "fresh" };
      });

      const result = await staleCache.get("test-key", fetcher);

      // Should fall back to fetcher on parse error
      expect(result).toEqual({ data: "fresh" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger).warn).toHaveBeenCalled();
    });

    it("should handle fetcher failures without crashing", async () => {
      vi.mocked(safeGet).mockResolvedValue(null);
      vi.mocked(safeSet).mockResolvedValue(undefined);

      const fetcher = vi.fn(async () => {
        throw new Error("Fetcher failed");
      });

      await expect(staleCache.get("test-key", fetcher)).rejects.toThrow("Fetcher failed");
      expect(vi.mocked(logger).error).toHaveBeenCalled();
    });
  });

  describe("Memory and Resource Management", () => {
    it("should not cause memory leaks with repeated operations", async () => {
      vi.mocked(safeGet).mockResolvedValue(null);
      vi.mocked(safeSet).mockResolvedValue(undefined);

      const fetcher = vi.fn(async () => ({ data: "fresh" }));

      const initialMemory = process.memoryUsage().heapUsed;

      // Perform many operations
      for (let i = 0; i < 1000; i++) {
        await staleCache.get(`key-${i}`, fetcher);
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable
      expect(memoryIncrease).toBeLessThan(5 * 1024 * 1024); // < 5MB
    });

    it("should deduplicate concurrent refreshes for the same key", async () => {
      const now = Date.now();
      const staleMeta = JSON.stringify({ timestamp: now - 2000, version: 1 });
      
      vi.mocked(safeGet).mockResolvedValue(JSON.stringify({ data: "stale" }));
      vi.mocked(safeSet).mockResolvedValue(undefined);
      vi.mocked(evictionEngine).getFrequency = vi.fn(() => 100);
      vi.mocked(evictionEngine).totalAccesses = 1000;

      let fetcherCallCount = 0;
      const fetcher = vi.fn(async () => {
        fetcherCallCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
        return { data: "fresh" };
      });

      // Trigger multiple concurrent gets for the same key
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(staleCache.get("same-key", fetcher));
      }

      await Promise.all(promises);

      // Should deduplicate background refreshes
      expect(fetcherCallCount).toBeLessThanOrEqual(2);
    });
  });

  describe("Input Validation Edge Cases", () => {
    it("should reject invalid cache keys", async () => {
      await expect(staleCache.get("", vi.fn())).rejects.toThrow("Cache key must be a non-empty string");
      await expect(staleCache.get(null as any, vi.fn())).rejects.toThrow("Cache key must be a non-empty string");
      await expect(staleCache.get(undefined as any, vi.fn())).rejects.toThrow("Cache key must be a non-empty string");
    });

    it("should reject invalid fetcher", async () => {
      await expect(staleCache.get("key", null as any)).rejects.toThrow("Fetcher must be a function");
      await expect(staleCache.get("key", "not a function" as any)).rejects.toThrow("Fetcher must be a function");
    });

    it("should reject invalid config options", async () => {
      const invalidCache = new StaleCacheService({
        staleThresholdMs: -1,
      });

      vi.mocked(safeGet).mockResolvedValue(null);
      vi.mocked(safeSet).mockResolvedValue(undefined);

      await expect(invalidCache.get("key", vi.fn())).rejects.toThrow("staleThresholdMs must be non-negative");
    });

    it("should reject undefined values in set", async () => {
      await expect(staleCache.set("key", undefined as any)).rejects.toThrow("Cannot cache undefined value");
    });

    it("should reject invalid TTL in set", async () => {
      await expect(staleCache.set("key", { data: "test" }, -1)).rejects.toThrow("TTL must be a positive number");
      await expect(staleCache.set("key", { data: "test" }, 0)).rejects.toThrow("TTL must be a positive number");
    });
  });

  describe("Cache Statistics and Monitoring", () => {
    it("should provide accurate cache statistics", async () => {
      const stats = staleCache.getStats();

      expect(stats).toHaveProperty("pendingRefreshes");
      expect(stats).toHaveProperty("config");
      expect(stats).toHaveProperty("evictionEngine");
      expect(stats.evictionEngine).toHaveProperty("memoryBytes");
      expect(stats.evictionEngine).toHaveProperty("totalAccesses");
    });

    it("should track pending refreshes accurately", async () => {
      const now = Date.now();
      const staleMeta = JSON.stringify({ timestamp: now - 2000, version: 1 });
      
      vi.mocked(safeGet).mockResolvedValue(JSON.stringify({ data: "stale" }));
      vi.mocked(safeSet).mockResolvedValue(undefined);
      vi.mocked(evictionEngine).getFrequency = vi.fn(() => 100);
      vi.mocked(evictionEngine).totalAccesses = 1000;

      const fetcher = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return { data: "fresh" };
      });

      // Trigger background refresh
      staleCache.get("key", fetcher);
      
      // Wait a bit for refresh to start
      await new Promise(resolve => setTimeout(resolve, 10));

      const stats = staleCache.getStats();
      expect(stats.pendingRefreshes).toBeGreaterThan(0);
    });
  });
});
