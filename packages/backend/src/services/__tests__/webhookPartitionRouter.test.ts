/**
 * @file webhookPartitionRouter.test.ts
 * @description Unit tests for the webhook partition router service.
 * Tests cover partition management, batch validation, SQL building, and routing logic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getPartitionName,
  parsePartitionName,
  isDateInPartition,
  createEmptyWebhookBatch,
  webhookBatchHasRows,
  assertValidWebhookBatch,
  InvalidWebhookBatchError,
  buildWebhookEventInsertQuery,
  buildWebhookDeliveryLogInsertQuery,
  WebhookPartitionRouter,
  type WebhookBatch,
  type WebhookEventBatchRow,
  type WebhookDeliveryLogBatchRow,
} from "../webhookPartitionRouter.js";

describe("webhookPartitionRouter", () => {
  describe("Partition name utilities", () => {
    it("should generate correct partition names", () => {
      const date1 = new Date("2024-01-15T00:00:00Z");
      const date2 = new Date("2024-12-01T00:00:00Z");
      const date3 = new Date("2025-06-30T23:59:59Z");

      expect(getPartitionName("WebhookEvent", date1)).toBe("WebhookEvent_2024_01");
      expect(getPartitionName("WebhookEvent", date2)).toBe("WebhookEvent_2024_12");
      expect(getPartitionName("WebhookEvent", date3)).toBe("WebhookEvent_2025_07");
    });

    it("should parse partition names correctly", () => {
      expect(parsePartitionName("WebhookEvent_2024_01")).toEqual({ year: 2024, month: 1 });
      expect(parsePartitionName("WebhookEvent_2024_12")).toEqual({ year: 2024, month: 12 });
      expect(parsePartitionName("WebhookEvent_2025_06")).toEqual({ year: 2025, month: 6 });
      expect(parsePartitionName("Invalid_Name")).toBeNull();
      expect(parsePartitionName("WebhookEvent_24_01")).toBeNull();
    });

    it("should correctly determine if date is in partition range", () => {
      const date = new Date("2024-01-15T00:00:00Z");
      const partitionStart = new Date("2024-01-01T00:00:00Z");
      const partitionEnd = new Date("2024-02-01T00:00:00Z");

      expect(isDateInPartition(date, partitionStart, partitionEnd)).toBe(true);
      
      const dateOutside = new Date("2024-02-15T00:00:00Z");
      expect(isDateInPartition(dateOutside, partitionStart, partitionEnd)).toBe(false);
      
      const dateBefore = new Date("2023-12-31T23:59:59Z");
      expect(isDateInPartition(dateBefore, partitionStart, partitionEnd)).toBe(false);
    });
  });

  describe("Batch management", () => {
    it("should create empty batch", () => {
      const batch = createEmptyWebhookBatch();
      expect(batch.events).toEqual([]);
      expect(batch.deliveryLogs).toEqual([]);
    });

    it("should detect when batch has rows", () => {
      const emptyBatch = createEmptyWebhookBatch();
      expect(webhookBatchHasRows(emptyBatch)).toBe(false);

      const batchWithEvents = createEmptyWebhookBatch();
      batchWithEvents.events.push({
        organizationId: "org-1",
        eventType: "test",
        source: "test",
        priority: "normal",
        payload: "{}",
        metadata: null,
        processedAt: new Date(),
        createdAt: new Date(),
        deliveredAt: null,
      });
      expect(webhookBatchHasRows(batchWithEvents)).toBe(true);

      const batchWithLogs = createEmptyWebhookBatch();
      batchWithLogs.deliveryLogs.push({
        webhookEventId: "event-1",
        webhookConfigId: "config-1",
        payload: "{}",
        statusCode: null,
        responseBody: null,
        errorMessage: null,
        retryCount: 0,
        deliveredAt: null,
        createdAt: new Date(),
      });
      expect(webhookBatchHasRows(batchWithLogs)).toBe(true);
    });
  });

  describe("Batch validation", () => {
    it("should validate valid webhook event rows", () => {
      const batch: WebhookBatch = {
        events: [
          {
            organizationId: "org-1",
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority: "normal",
            payload: '{"test": "data"}',
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date(),
            deliveredAt: null,
          },
        ],
        deliveryLogs: [],
      };

      expect(() => assertValidWebhookBatch(batch)).not.toThrow();
    });

    it("should reject invalid webhook event rows", () => {
      const batch: WebhookBatch = {
        events: [
          {
            organizationId: "", // Invalid: empty string
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority: "normal",
            payload: '{"test": "data"}',
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date(),
            deliveredAt: null,
          },
        ],
        deliveryLogs: [],
      };

      expect(() => assertValidWebhookBatch(batch)).toThrow(InvalidWebhookBatchError);
    });

    it("should reject invalid priority values", () => {
      const batch: WebhookBatch = {
        events: [
          {
            organizationId: "org-1",
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority: "invalid" as any, // Invalid priority
            payload: '{"test": "data"}',
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date(),
            deliveredAt: null,
          },
        ],
        deliveryLogs: [],
      };

      expect(() => assertValidWebhookBatch(batch)).toThrow(InvalidWebhookBatchError);
    });

    it("should validate valid webhook delivery log rows", () => {
      const batch: WebhookBatch = {
        events: [],
        deliveryLogs: [
          {
            webhookEventId: "event-1",
            webhookConfigId: "config-1",
            payload: '{"test": "data"}',
            statusCode: 200,
            responseBody: null,
            errorMessage: null,
            retryCount: 0,
            deliveredAt: null,
            createdAt: new Date(),
          },
        ],
      };

      expect(() => assertValidWebhookBatch(batch)).not.toThrow();
    });

    it("should reject invalid delivery log rows", () => {
      const batch: WebhookBatch = {
        events: [],
        deliveryLogs: [
          {
            webhookEventId: "", // Invalid: empty string
            webhookConfigId: "config-1",
            payload: '{"test": "data"}',
            statusCode: null,
            responseBody: null,
            errorMessage: null,
            retryCount: 0,
            deliveredAt: null,
            createdAt: new Date(),
          },
        ],
      };

      expect(() => assertValidWebhookBatch(batch)).toThrow(InvalidWebhookBatchError);
    });

    it("should reject negative retry counts", () => {
      const batch: WebhookBatch = {
        events: [],
        deliveryLogs: [
          {
            webhookEventId: "event-1",
            webhookConfigId: "config-1",
            payload: '{"test": "data"}',
            statusCode: null,
            responseBody: null,
            errorMessage: null,
            retryCount: -1, // Invalid: negative
            deliveredAt: null,
            createdAt: new Date(),
          },
        ],
      };

      expect(() => assertValidWebhookBatch(batch)).toThrow(InvalidWebhookBatchError);
    });
  });

  describe("SQL query building", () => {
    it("should build empty query for empty event rows", () => {
      const query = buildWebhookEventInsertQuery([]);
      expect(query.sql).toContain("SELECT 0");
    });

    it("should build insert query for webhook events", () => {
      const rows: WebhookEventBatchRow[] = [
        {
          organizationId: "org-1",
          eventType: "payout_claimed",
          source: "stellar_horizon",
          priority: "normal",
          payload: '{"test": "data"}',
          metadata: null,
          processedAt: new Date("2024-01-15T00:00:00Z"),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        },
      ];

      const query = buildWebhookEventInsertQuery(rows);
      expect(query.sql).toContain("INSERT INTO \"WebhookEvent\"");
      expect(query.sql).toContain("UNNEST");
      expect(query.sql).toContain("organizationId");
      expect(query.sql).toContain("eventType");
    });

    it("should build empty query for empty delivery log rows", () => {
      const query = buildWebhookDeliveryLogInsertQuery([]);
      expect(query.sql).toContain("SELECT 0");
    });

    it("should build insert query for delivery logs", () => {
      const rows: WebhookDeliveryLogBatchRow[] = [
        {
          webhookEventId: "event-1",
          webhookConfigId: "config-1",
          payload: '{"test": "data"}',
          statusCode: 200,
          responseBody: null,
          errorMessage: null,
          retryCount: 0,
          deliveredAt: null,
          createdAt: new Date("2024-01-15T00:00:00Z"),
        },
      ];

      const query = buildWebhookDeliveryLogInsertQuery(rows);
      expect(query.sql).toContain("INSERT INTO \"WebhookDeliveryLog\"");
      expect(query.sql).toContain("UNNEST");
      expect(query.sql).toContain("webhookEventId");
      expect(query.sql).toContain("webhookConfigId");
    });

    it("should handle optional fields correctly", () => {
      const rows: WebhookEventBatchRow[] = [
        {
          organizationId: "org-1",
          eventType: "payout_claimed",
          source: "stellar_horizon",
          priority: "high",
          payload: '{"test": "data"}',
          metadata: "some metadata",
          processedAt: new Date(),
          createdAt: new Date(),
          deliveredAt: new Date(),
        },
      ];

      const query = buildWebhookEventInsertQuery(rows);
      expect(query.sql).toContain("metadata");
      expect(query.sql).toContain("deliveredAt");
    });
  });

  describe("PartitionRouter service", () => {
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
      router = new WebhookPartitionRouter(mockDb, 10);
    });

    it("should flush empty batch without errors", async () => {
      const batch = createEmptyWebhookBatch();
      const result = await router.flush(batch);

      expect(result.events).toBe(0);
      expect(result.deliveryLogs).toBe(0);
      expect(result.chunks).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.partitionsUsed).toEqual([]);
    });

    it("should flush batch with events", async () => {
      const batch: WebhookBatch = {
        events: [
          {
            organizationId: "org-1",
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority: "normal",
            payload: '{"test": "data"}',
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date("2024-01-15T00:00:00Z"),
            deliveredAt: null,
          },
        ],
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.events).toBe(1);
      expect(result.deliveryLogs).toBe(0);
      expect(result.chunks).toBe(1);
      expect(result.partitionsUsed).toContain("WebhookEvent_2024_01");
    });

    it("should group events by partition", async () => {
      const batch: WebhookBatch = {
        events: [
          {
            organizationId: "org-1",
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority: "normal",
            payload: '{"test": "data"}',
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
            payload: '{"test": "data"}',
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date("2024-02-15T00:00:00Z"),
            deliveredAt: null,
          },
        ],
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.events).toBe(2);
      expect(result.partitionsUsed).toContain("WebhookEvent_2024_01");
      expect(result.partitionsUsed).toContain("WebhookEvent_2024_02");
    });

    it("should chunk large batches", async () => {
      const batch: WebhookBatch = {
        events: Array.from({ length: 25 }, (_, i) => ({
          organizationId: "org-1",
          eventType: "payout_claimed",
          source: "stellar_horizon",
          priority: "normal",
          payload: `{"index": ${i}}`,
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: [],
      };

      const result = await router.flush(batch);

      expect(result.events).toBe(25);
      expect(result.chunks).toBe(3); // 25 / 10 = 3 chunks
    });

    it("should handle delivery logs", async () => {
      const batch: WebhookBatch = {
        events: [],
        deliveryLogs: [
          {
            webhookEventId: "event-1",
            webhookConfigId: "config-1",
            payload: '{"test": "data"}',
            statusCode: 200,
            responseBody: null,
            errorMessage: null,
            retryCount: 0,
            deliveredAt: null,
            createdAt: new Date("2024-01-15T00:00:00Z"),
          },
        ],
      };

      const result = await router.flush(batch);

      expect(result.events).toBe(0);
      expect(result.deliveryLogs).toBe(1);
      expect(result.partitionsUsed).toContain("WebhookDeliveryLog_2024_01");
    });

    it("should throw on invalid batch", async () => {
      const batch: WebhookBatch = {
        events: [
          {
            organizationId: "", // Invalid
            eventType: "payout_claimed",
            source: "stellar_horizon",
            priority: "normal",
            payload: '{"test": "data"}',
            metadata: null,
            processedAt: new Date(),
            createdAt: new Date(),
            deliveredAt: null,
          },
        ],
        deliveryLogs: [],
      };

      await expect(router.flush(batch)).rejects.toThrow(InvalidWebhookBatchError);
    });

    it("should query events by time range across partitions", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-03-01T00:00:00Z");

      await router.queryEventsByTimeRange("org-1", startDate, endDate);

      expect(mockDb.$queryRaw).toHaveBeenCalled();
    });

    it("should query events by time range with event type filter", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-02-01T00:00:00Z");

      await router.queryEventsByTimeRange("org-1", startDate, endDate, "payout_claimed");

      expect(mockDb.$queryRaw).toHaveBeenCalled();
    });
  });

  describe("Non-blocking behavior", () => {
    it("should yield event loop between chunks", async () => {
      const mockDb = {
        $transaction: vi.fn(async (fn) => {
          const mockTx = {
            $executeRaw: vi.fn(async () => {
              // Simulate async operation
              await new Promise(resolve => setTimeout(resolve, 1));
            }),
            $queryRaw: vi.fn(async () => []),
          };
          return await fn(mockTx);
        }),
        $queryRaw: vi.fn(async () => []),
      };

      const router = new WebhookPartitionRouter(mockDb, 5);

      const batch: WebhookBatch = {
        events: Array.from({ length: 15 }, (_, i) => ({
          organizationId: "org-1",
          eventType: "payout_claimed",
          source: "stellar_horizon",
          priority: "normal",
          payload: `{"index": ${i}}`,
          metadata: null,
          processedAt: new Date(),
          createdAt: new Date("2024-01-15T00:00:00Z"),
          deliveredAt: null,
        })),
        deliveryLogs: [],
      };

      const startTime = Date.now();
      await router.flush(batch);
      const duration = Date.now() - startTime;

      // Should complete reasonably fast despite 3 chunks with simulated delays
      expect(duration).toBeLessThan(100);
    });
  });
});