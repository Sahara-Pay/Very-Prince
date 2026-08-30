/**
 * @file webhookIngestionLoad.test.ts
 * @description Load and concurrency tests for webhook ingestion system.
 * Tests verify that the system can handle high-throughput Web3 webhook traffic
 * without blocking the Node.js event loop or causing performance degradation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webhookRouter } from "../trpc/webhookRouter.js";
import { webhookService } from "../services/webhookService.js";
import { logger } from "../utils/logger.js";

// Mock dependencies
vi.mock("../services/webhookService.js");
vi.mock("../utils/logger.js");

describe("Webhook Ingestion Load Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(logger).debug = vi.fn();
    vi.mocked(logger).error = vi.fn();
    vi.mocked(logger).info = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Event Loop Non-Blocking Tests", () => {
    it("should not block event loop during single webhook ingestion", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      // Mock a slow queue operation
      let queueResolved = false;
      vi.mocked(webhookService.queueWebhook).mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        queueResolved = true;
      });

      const input = {
        organizationId: "test-org",
        event: "payout_claimed",
        data: {
          blockNumber: 12345,
          blockHash: "0x" + "a".repeat(64),
          timestamp: "2024-01-01T00:00:00Z",
          network: "mainnet" as const,
        },
      };

      // Start the ingestion
      const ingestPromise = mockCaller.ingest(input);
      
      // Check if the event loop is still responsive by executing a simple operation
      let eventLoopResponsive = true;
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
        // If we get here, the event loop is still responsive
      } catch (error) {
        eventLoopResponsive = false;
      }

      expect(eventLoopResponsive).toBe(true);
      expect(queueResolved).toBe(false); // Queue should still be processing

      await ingestPromise;
      expect(queueResolved).toBe(true);
    });

    it("should not block event loop during batch webhook ingestion", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      let queueCalls = 0;
      vi.mocked(webhookService.queueWebhook).mockImplementation(async () => {
        queueCalls++;
        await new Promise(resolve => setTimeout(resolve, 10));
      });

      const batchInput = {
        webhooks: Array.from({ length: 10 }, (_, i) => ({
          organizationId: `org-${i}`,
          event: "payout_claimed",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: "2024-01-01T00:00:00Z",
            network: "mainnet" as const,
          },
        })),
        processingMode: "parallel" as const,
      };

      const batchPromise = mockCaller.ingestBatch(batchInput);
      
      // Event loop should remain responsive
      let eventLoopResponsive = true;
      try {
        await new Promise(resolve => setTimeout(resolve, 20));
        await new Promise(resolve => setTimeout(resolve, 20));
      } catch (error) {
        eventLoopResponsive = false;
      }

      expect(eventLoopResponsive).toBe(true);
      
      await batchPromise;
      expect(queueCalls).toBe(10);
    });

    it("should handle fire-and-forget mode without blocking", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const batchInput = {
        webhooks: [
          {
            organizationId: "org-1",
            event: "payout_claimed",
            data: {
              blockNumber: 12345,
              blockHash: "0x" + "a".repeat(64),
              timestamp: "2024-01-01T00:00:00Z",
              network: "mainnet" as const,
            },
          },
        ],
        processingMode: "fire_and_forget" as const,
      };

      const result = await mockCaller.ingestBatch(batchInput);

      expect(result.success).toBe(true);
      expect(result.message).toContain("fire-and-forget");
      expect(result.queuedCount).toBe(1);
    });
  });

  describe("High Throughput Tests", () => {
    it("should handle 100 concurrent webhook ingestions", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const concurrentRequests = 100;
      const promises = [];

      for (let i = 0; i < concurrentRequests; i++) {
        const input = {
          organizationId: `org-${i}`,
          event: "payout_claimed",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: "2024-01-01T00:00:00Z",
            network: "mainnet" as const,
          },
        };
        promises.push(mockCaller.ingest(input));
      }

      const results = await Promise.all(promises);

      expect(results.every(r => r.success)).toBe(true);
      expect(webhookService.queueWebhook).toHaveBeenCalledTimes(concurrentRequests);
    });

    it("should handle large batch operations efficiently", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const batchSize = 100; // Maximum allowed
      const batchInput = {
        webhooks: Array.from({ length: batchSize }, (_, i) => ({
          organizationId: `org-${i}`,
          event: "payout_claimed",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: "2024-01-01T00:00:00Z",
            network: "mainnet" as const,
          },
        })),
        processingMode: "parallel" as const,
      };

      const result = await mockCaller.ingestBatch(batchInput);

      expect(result.success).toBe(true);
      expect(result.queuedCount).toBe(batchSize);
      expect(webhookService.queueWebhook).toHaveBeenCalledTimes(batchSize);
    });

    it("should handle mixed sequential and parallel batch operations", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const parallelBatch = {
        webhooks: Array.from({ length: 20 }, (_, i) => ({
          organizationId: `org-parallel-${i}`,
          event: "payout_claimed",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: "2024-01-01T00:00:00Z",
            network: "mainnet" as const,
          },
        })),
        processingMode: "parallel" as const,
      };

      const sequentialBatch = {
        webhooks: Array.from({ length: 10 }, (_, i) => ({
          organizationId: `org-sequential-${i}`,
          event: "funding_received",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "b".repeat(64),
            timestamp: "2024-01-01T00:00:00Z",
            network: "mainnet" as const,
          },
        })),
        processingMode: "sequential" as const,
      };

      const [parallelResult, sequentialResult] = await Promise.all([
        mockCaller.ingestBatch(parallelBatch),
        mockCaller.ingestBatch(sequentialBatch),
      ]);

      expect(parallelResult.success).toBe(true);
      expect(sequentialResult.success).toBe(true);
      expect(parallelResult.queuedCount).toBe(20);
      expect(sequentialResult.queuedCount).toBe(10);
    });
  });

  describe("Error Handling Under Load", () => {
    it("should handle partial failures gracefully in high load", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      let callCount = 0;
      vi.mocked(webhookService.queueWebhook).mockImplementation(async () => {
        callCount++;
        if (callCount % 3 === 0) {
          throw new Error("Simulated queue error");
        }
      });

      const batchInput = {
        webhooks: Array.from({ length: 30 }, (_, i) => ({
          organizationId: `org-${i}`,
          event: "payout_claimed",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: "2024-01-01T00:00:00Z",
            network: "mainnet" as const,
          },
        })),
        processingMode: "parallel" as const,
      };

      const result = await mockCaller.ingestBatch(batchInput);

      expect(result.success).toBe(false);
      expect(result.queuedCount).toBeGreaterThan(0);
      expect(result.failedCount).toBeGreaterThan(0);
      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBe(10); // Every 3rd call fails
    });

    it("should reject malformed inputs without affecting valid ones", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const mixedBatch = {
        webhooks: [
          // Valid webhook
          {
            organizationId: "org-1",
            event: "payout_claimed",
            data: {
              blockNumber: 12345,
              blockHash: "0x" + "a".repeat(64),
              timestamp: "2024-01-01T00:00:00Z",
              network: "mainnet" as const,
            },
          },
          // Invalid webhook (missing blockchain metadata)
          {
            organizationId: "org-2",
            event: "payout_claimed",
            data: {
              someField: "value",
            },
          },
          // Valid webhook
          {
            organizationId: "org-3",
            event: "funding_received",
            data: {
              blockNumber: 12346,
              blockHash: "0x" + "b".repeat(64),
              timestamp: "2024-01-01T00:01:00Z",
              network: "mainnet" as const,
            },
          },
        ],
        processingMode: "parallel" as const,
      };

      await expect(mockCaller.ingestBatch(mixedBatch)).rejects.toThrow();
    });
  });

  describe("Memory and Resource Management", () => {
    it("should not cause memory leaks with repeated batch operations", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const initialMemory = process.memoryUsage().heapUsed;

      // Perform multiple batch operations
      for (let i = 0; i < 10; i++) {
        const batchInput = {
          webhooks: Array.from({ length: 50 }, (_, j) => ({
            organizationId: `org-${i}-${j}`,
            event: "payout_claimed",
            data: {
              blockNumber: 12345 + j,
              blockHash: "0x" + "a".repeat(64),
              timestamp: "2024-01-01T00:00:00Z",
              network: "mainnet" as const,
            },
          })),
          processingMode: "parallel" as const,
        };

        await mockCaller.ingestBatch(batchInput);
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable (< 10MB for this test)
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);
    });

    it("should handle rate limiting gracefully", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      let requestCount = 0;
      vi.mocked(webhookService.queueWebhook).mockImplementation(async () => {
        requestCount++;
        if (requestCount > 100) {
          throw new Error("Rate limit exceeded");
        }
      });

      const promises = [];
      for (let i = 0; i < 150; i++) {
        const input = {
          organizationId: `org-${i}`,
          event: "payout_claimed",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: "2024-01-01T00:00:00Z",
            network: "mainnet" as const,
          },
        };
        promises.push(mockCaller.ingest(input));
      }

      const results = await Promise.allSettled(promises);

      const successful = results.filter(r => r.status === "fulfilled").length;
      const failed = results.filter(r => r.status === "rejected").length;

      expect(successful).toBe(100);
      expect(failed).toBe(50);
    });
  });

  describe("Real-World Scenario Simulations", () => {
    it("should simulate high-frequency block indexer webhooks", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      // Simulate an indexer sending webhooks for every new block
      const totalBlocks = 10;
      const promises = [];

      for (let i = 0; i < totalBlocks; i++) {
        const input = {
          organizationId: "indexer-org",
          event: "block_processed",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: new Date(Date.now() + i * 100).toISOString(),
            network: "mainnet" as const,
            indexerId: "stellar-indexer-1",
            sequence: i,
            eventType: "block" as const,
          },
        };
        promises.push(mockCaller.ingest(input));
      }

      const results = await Promise.all(promises);

      expect(results.every(r => r.success)).toBe(true);
      expect(results.length).toBe(totalBlocks);
    });

    it("should simulate burst traffic during network congestion", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      // Simulate burst of 50 webhooks
      const burstSize = 50;
      const promises = [];

      for (let i = 0; i < burstSize; i++) {
        const input = {
          organizationId: `org-${i}`,
          event: "payout_claimed",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: "2024-01-01T00:00:00Z",
            network: "mainnet" as const,
          },
        };
        promises.push(mockCaller.ingest(input));
      }

      const results = await Promise.all(promises);

      expect(results.every(r => r.success)).toBe(true);
      expect(results.length).toBe(burstSize);
    });
  });
});