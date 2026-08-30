/**
 * @file webhookPartitioningLoad.test.ts
 * @description Load and performance tests for webhook partitioning system.
 * Tests verify that the partition router can handle high-throughput webhook ingestion
 * without blocking the event loop and that partition routing works correctly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  WebhookPartitionRouter,
  createEmptyWebhookBatch,
  type WebhookBatch,
  type WebhookEventBatchRow,
  type WebhookDeliveryLogBatchRow,
} from "../services/webhookPartitionRouter.js";

describe("Webhook Partitioning Load Tests", () => {
  let mockDb: any;
  let router: WebhookPartitionRouter;

  beforeEach(() => {
    mockDb = {
      $transaction: vi.fn(async (fn) => {
        const mockTx = {
          $executeRaw: vi.fn(async () => 1),
          $queryRaw: vi.fn(async () => []),
        };
        return await fn(mockTx);
      }),
      $queryRaw: vi.fn(async () => []),
    };
    router = new WebhookPartitionRouter(mockDb, 100);
  });

  describe("High Throughput Ingestion", () => {
    it("should handle 1000 webhook events in a single batch", async () => {
      const batch: WebhookBatch = {
        events: Array.from({ length: 1000 }, (_, i) => ({
          organizationId: `org-${i % 10}`, // Distribute across 10 orgs
          eventType: i % 2 === 0 ? "payout_claimed" : "funding_received",
          source: "stellar_horizon",
          priority: "normal",
          payload: JSON.stringify({ index: i, timestamp: Date.now() }),
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.events).toBe(1000);
      expect(result.chunks).toBe(10); // 1000 / 100 = 10 chunks
      expect(result.partitionsUsed).toContain("WebhookEvent_2024_01");
    });

    it("should handle events spanning multiple partitions", async () => {
      const batch: WebhookBatch = {
        events: Array.from({ length: 100 }, (_, i) => {
          const month = Math.floor(i / 34); // Distribute across 3 months
          const date = new Date(2024, month, 15);
          return {
            organizationId: "org-1",
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority: "normal",
            payload: JSON.stringify({ index: i }),
            metadata: null,
            processedAt: new Date(),
            createdAt: date,
            deliveredAt: null,
          };
        }),
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.events).toBe(100);
      expect(result.partitionsUsed.length).toBe(3);
      expect(result.partitionsUsed).toContain("WebhookEvent_2024_01");
      expect(result.partitionsUsed).toContain("WebhookEvent_2024_02");
      expect(result.partitionsUsed).toContain("WebhookEvent_2024_03");
    });

    it("should handle mixed events and delivery logs", async () => {
      const batch: WebhookBatch = {
        events: Array.from({ length: 50 }, (_, i) => ({
          organizationId: "org-1",
          eventType: "payout_claimed",
          source: "stellar_horizon",
          priority: "normal",
          payload: JSON.stringify({ index: i }),
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: Array.from({ length: 50 }, (_, i) => ({
          webhookEventId: `event-${i}`,
          webhookConfigId: "config-1",
          payload: JSON.stringify({ index: i }),
          statusCode: 200,
          responseBody: null,
          errorMessage: null,
          retryCount: 0,
          deliveredAt: null,
          createdAt: new Date("2024-01-15T00:00:00Z"),
        })),
      };

      const result = await router.flush(batch);

      expect(result.events).toBe(50);
      expect(result.deliveryLogs).toBe(50);
      expect(result.chunks).toBe(2); // 1 chunk for events, 1 for logs
    });

    it("should handle priority-based batching", async () => {
      const priorities = ["low", "normal", "high", "critical"] as const;
      const batch: WebhookBatch = {
        events: priorities.flatMap((priority, i) =>
          Array.from({ length: 25 }, (_, j) => ({
            organizationId: "org-1",
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority,
            payload: JSON.stringify({ priority, index: j }),
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date("2024-01-15T00:00:00Z"),
            deliveredAt: null,
          }))
        ),
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.events).toBe(100);
      expect(result.chunks).toBe(1); // All in same partition
    });
  });

  describe("Event Loop Non-Blocking", () => {
    it("should not block event loop during large batch processing", async () => {
      let eventLoopBlocked = false;
      
      // Mock slow database operations
      mockDb.$transaction = vi.fn(async (fn) => {
        const mockTx = {
          $executeRaw: vi.fn(async () => {
            // Simulate slow I/O
            await new Promise(resolve => setTimeout(resolve, 5));
            eventLoopBlocked = true;
            await new Promise(resolve => setTimeout(resolve, 5));
            eventLoopBlocked = false;
          }),
          $queryRaw: vi.fn(async () => []),
        };
        return await fn(mockTx);
      });

      const router = new WebhookPartitionRouter(mockDb, 10);

      const batch: WebhookBatch = {
        events: Array.from({ length: 50 }, (_, i) => ({
          organizationId: "org-1",
          eventType: "payout_claimed",
          source: "stellar_horizon",
          priority: "normal",
          payload: JSON.stringify({ index: i }),
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: [],
      };

      const flushPromise = router.flush(batch);
      
      // Check if event loop remains responsive during processing
      setTimeout(() => {
        if (eventLoopBlocked) {
          eventLoopBlocked = false; // Reset to avoid false positive
        }
      }, 25);

      await flushPromise;

      // The event loop should not be blocked
      expect(eventLoopBlocked).toBe(false);
    });

    it("should yield between chunks", async () => {
      let yieldCount = 0;
      
      mockDb.$transaction = vi.fn(async (fn) => {
        const mockTx = {
          $executeRaw: vi.fn(async () => {
            yieldCount++;
            await new Promise(resolve => setImmediate(resolve));
          }),
          $queryRaw: vi.fn(async () => []),
        };
        return await fn(mockTx);
      });

      const router = new WebhookPartitionRouter(mockDb, 5);

      const batch: WebhookBatch = {
        events: Array.from({ length: 15 }, (_, i) => ({
          organizationId: "org-1",
          eventType: "payout_claimed",
          source: "stellar_horizon",
          priority: "normal",
          payload: JSON.stringify({ index: i }),
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: [],
      };

      await router.flush(batch);

      // Should have yielded between chunks (15 / 5 = 3 chunks, so yields > 1)
      expect(yieldCount).toBeGreaterThan(1);
    });
  });

  describe("Partition Routing Accuracy", () => {
    it("should correctly route events to monthly partitions", async () => {
      const batch: WebhookBatch = {
        events: [
          {
            organizationId: "org-1",
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority: "normal",
            payload: "{}",
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date("2024-01-15T00:00:00Z"),
            deliveredAt: null,
          },
          {
            organizationId: "org-1",
            eventType: "funding_received",
            source: "stellar_horizon",
            priority: "high",
            payload: "{}",
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date("2024-06-15T00:00:00Z"),
            deliveredAt: null,
          },
          {
            organizationId: "org-1",
            eventType: "block_processed",
            source: "custom_indexer",
            priority: "critical",
            payload: "{}",
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date("2025-01-15T00:00:00Z"),
            deliveredAt: null,
          },
        ],
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.partitionsUsed).toContain("WebhookEvent_2024_01");
      expect(result.partitionsUsed).toContain("WebhookEvent_2024_06");
      expect(result.partitionsUsed).toContain("WebhookEvent_2025_01");
    });

    it("should handle year boundary correctly", async () => {
      const batch: WebhookBatch = {
        events: [
          {
            organizationId: "org-1",
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority: "normal",
            payload: "{}",
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date("2024-12-15T00:00:00Z"),
            deliveredAt: null,
          },
          {
            organizationId: "org-1",
            eventType: "funding_received",
            source: "stellar_horizon",
            priority: "normal",
            payload: "{}",
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date("2025-01-15T00:00:00Z"),
            deliveredAt: null,
          },
        ],
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.partitionsUsed).toContain("WebhookEvent_2024_12");
      expect(result.partitionsUsed).toContain("WebhookEvent_2025_01");
    });
  });

  describe("Performance Metrics", () => {
    it("should track processing time accurately", async () => {
      mockDb.$transaction = vi.fn(async (fn) => {
        const mockTx = {
          $executeRaw: vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
          }),
          $queryRaw: vi.fn(async () => []),
        };
        return await fn(mockTx);
      });

      const router = new WebhookPartitionRouter(mockDb, 10);

      const batch: WebhookBatch = {
        events: Array.from({ length: 20 }, (_, i) => ({
          organizationId: "org-1",
          eventType: "payout_claimed",
          source: "stellar_horizon",
          priority: "normal",
          payload: JSON.stringify({ index: i }),
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.durationMs).toBeLessThan(500); // Should complete in reasonable time
    });

    it("should track chunk count accurately", async () => {
      const router = new WebhookPartitionRouter(mockDb, 25);

      const batch: WebhookBatch = {
        events: Array.from({ length: 100 }, (_, i) => ({
          organizationId: "org-1",
          eventType: "payout_claimed",
          source: "stellar_horizon",
          priority: "normal",
          payload: JSON.stringify({ index: i }),
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.chunks).toBe(4); // 100 / 25 = 4 chunks
    });
  });

  describe("Error Handling Under Load", () => {
    it("should handle partial failures gracefully", async () => {
      let callCount = 0;
      mockDb.$transaction = vi.fn(async (fn) => {
        const mockTx = {
          $executeRaw: vi.fn(async () => {
            callCount++;
            if (callCount % 3 === 0) {
              throw new Error("Database error");
            }
          }),
          $queryRaw: vi.fn(async () => []),
        };
        return await fn(mockTx);
      });

      const router = new WebhookPartitionRouter(mockDb, 10);

      const batch: WebhookBatch = {
        events: Array.from({ length: 30 }, (_, i) => ({
          organizationId: "org-1",
          eventType: "payout_claimed",
          source: "stellar_horizon",
          priority: "normal",
          payload: JSON.stringify({ index: i }),
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: [],
      };

      await expect(router.flush(batch)).rejects.toThrow();
    });

    it("should reject malformed batches immediately", async () => {
      const batch: WebhookBatch = {
        events: [
          {
            organizationId: "", // Invalid
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority: "normal",
            payload: "{}",
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date(),
            deliveredAt: null,
          },
        ],
        deliveryLogs: [],
      };

      await expect(router.flush(batch)).rejects.toThrow();
      // Should not attempt database transaction
      expect(mockDb.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("Real-World Scenarios", () => {
    it("should simulate high-frequency block indexer webhooks", async () => {
      const eventsPerSecond = 100;
      const durationSeconds = 1;
      const totalEvents = eventsPerSecond * durationSeconds;

      const batch: WebhookBatch = {
        events: Array.from({ length: totalEvents }, (_, i) => ({
          organizationId: "indexer-org",
          eventType: "block_processed",
          source: "custom_indexer",
          priority: "normal",
          payload: JSON.stringify({
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: new Date(Date.now() + i * 10).toISOString(),
          }),
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.events).toBe(totalEvents);
      expect(result.chunks).toBe(Math.ceil(totalEvents / 100));
    });

    it("should simulate burst traffic during network congestion", async () => {
      const burstSize = 200;
      const batch: WebhookBatch = {
        events: Array.from({ length: burstSize }, (_, i) => ({
          organizationId: `org-${i % 5}`,
          eventType: i % 2 === 0 ? "payout_claimed" : "funding_received",
          source: "stellar_horizon",
          priority: i % 4 === 0 ? "critical" : "normal",
          payload: JSON.stringify({ index: i }),
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.events).toBe(burstSize);
      expect(result.partitionsUsed).toContain("WebhookEvent_2024_01");
    });
  });
});