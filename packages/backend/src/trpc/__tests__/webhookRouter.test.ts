/**
 * @file webhookRouter.test.ts
 * @description Unit tests for the webhook ingestion tRPC router.
 * Tests cover schema validation, async processing, batch operations, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webhookRouter } from "../webhookRouter.js";
import { webhookService } from "../../services/webhookService.js";
import { logger } from "../../utils/logger.js";

// Mock dependencies
vi.mock("../../services/webhookService.js");
vi.mock("../../utils/logger.js");

describe("webhookRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(logger).debug = vi.fn();
    vi.mocked(logger).error = vi.fn();
    vi.mocked(logger).info = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("ingest", () => {
    it("should successfully ingest a valid webhook", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const validInput = {
        organizationId: "test-org-123",
        event: "payout_claimed",
        data: {
          blockNumber: 12345,
          blockHash: "0x" + "a".repeat(64),
          timestamp: "2024-01-01T00:00:00Z",
          network: "mainnet" as const,
          maintainer: "G" + "A".repeat(55),
          amountStroops: "10000000",
          txHash: "a".repeat(64),
        },
        metadata: {
          source: "stellar_horizon" as const,
          retryable: true,
          priority: "normal" as const,
        },
      };

      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const result = await mockCaller.ingest(validInput);

      expect(result.success).toBe(true);
      expect(result.queuedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.message).toContain("queued for non-blocking processing");
      expect(webhookService.queueWebhook).toHaveBeenCalledWith(
        validInput.organizationId,
        validInput.event,
        validInput.data
      );
    });

    it("should reject webhook with invalid blockchain metadata", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const invalidInput = {
        organizationId: "test-org-123",
        event: "payout_claimed",
        data: {
          blockNumber: "invalid", // Should be number
          blockHash: "0x" + "a".repeat(64),
          timestamp: "2024-01-01T00:00:00Z",
          network: "mainnet" as const,
        },
      };

      await expect(mockCaller.ingest(invalidInput)).rejects.toThrow();
    });

    it("should reject webhook with invalid block hash format", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const invalidInput = {
        organizationId: "test-org-123",
        event: "payout_claimed",
        data: {
          blockNumber: 12345,
          blockHash: "invalid-hash", // Should be 0x followed by 64 hex chars
          timestamp: "2024-01-01T00:00:00Z",
          network: "mainnet" as const,
        },
      };

      await expect(mockCaller.ingest(invalidInput)).rejects.toThrow();
    });

    it("should accept webhook with valid indexer metadata", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const validInput = {
        organizationId: "test-org-123",
        event: "block_processed",
        data: {
          indexerId: "stellar-indexer-1",
          sequence: 12345,
          eventType: "block" as const,
        },
        metadata: {
          source: "custom_indexer" as const,
          retryable: true,
          priority: "high" as const,
        },
      };

      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const result = await mockCaller.ingest(validInput);

      expect(result.success).toBe(true);
      expect(result.queuedCount).toBe(1);
      expect(webhookService.queueWebhook).toHaveBeenCalledWith(
        validInput.organizationId,
        validInput.event,
        validInput.data
      );
    });

    it("should handle webhook service errors gracefully", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const validInput = {
        organizationId: "test-org-123",
        event: "payout_claimed",
        data: {
          blockNumber: 12345,
          blockHash: "0x" + "a".repeat(64),
          timestamp: "2024-01-01T00:00:00Z",
          network: "mainnet" as const,
        },
      };

      vi.mocked(webhookService.queueWebhook).mockRejectedValue(
        new Error("Queue service unavailable")
      );

      await expect(mockCaller.ingest(validInput)).rejects.toThrow("Queue service unavailable");
      expect(logger.error).toHaveBeenCalled();
    });

    it("should process webhooks asynchronously without blocking", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const validInput = {
        organizationId: "test-org-123",
        event: "payout_claimed",
        data: {
          blockNumber: 12345,
          blockHash: "0x" + "a".repeat(64),
          timestamp: "2024-01-01T00:00:00Z",
          network: "mainnet" as const,
        },
      };

      let resolveQueue: (value: void) => void;
      const queuePromise = new Promise<void>((resolve) => {
        resolveQueue = resolve;
      });

      vi.mocked(webhookService.queueWebhook).mockImplementation(() => queuePromise);

      // This should return immediately without waiting for the queue operation
      const ingestPromise = mockCaller.ingest(validInput);
      
      // Verify the promise is still pending
      let isPending = true;
      ingestPromise.then(() => { isPending = false; });
      
      expect(isPending).toBe(true);
      
      // Resolve the queue operation
      resolveQueue!();
      
      const result = await ingestPromise;
      expect(result.success).toBe(true);
    });
  });

  describe("ingestBatch", () => {
    it("should successfully ingest a batch of webhooks in parallel mode", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
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
          {
            organizationId: "org-2",
            event: "funding_received",
            data: {
              blockNumber: 12346,
              blockHash: "0x" + "b".repeat(64),
              timestamp: "2024-01-01T00:01:00Z",
              network: "mainnet" as const,
            },
          },
        ],
        batchId: "550e8400-e29b-41d4-a716-446655440000",
        processingMode: "parallel" as const,
      };

      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const result = await mockCaller.ingestBatch(batchInput);

      expect(result.success).toBe(true);
      expect(result.queuedCount).toBe(2);
      expect(result.failedCount).toBe(0);
      expect(result.batchId).toBe(batchInput.batchId);
      expect(webhookService.queueWebhook).toHaveBeenCalledTimes(2);
    });

    it("should successfully ingest a batch in sequential mode", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
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
          {
            organizationId: "org-2",
            event: "funding_received",
            data: {
              blockNumber: 12346,
              blockHash: "0x" + "b".repeat(64),
              timestamp: "2024-01-01T00:01:00Z",
              network: "mainnet" as const,
            },
          },
        ],
        processingMode: "sequential" as const,
      };

      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const result = await mockCaller.ingestBatch(batchInput);

      expect(result.success).toBe(true);
      expect(result.queuedCount).toBe(2);
      expect(result.failedCount).toBe(0);
    });

    it("should handle fire-and-forget mode without waiting", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
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

      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      const result = await mockCaller.ingestBatch(batchInput);

      expect(result.success).toBe(true);
      expect(result.queuedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.message).toContain("fire-and-forget");
    });

    it("should handle partial failures in batch processing", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
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
          {
            organizationId: "org-2",
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

      vi.mocked(webhookService.queueWebhook)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Queue error"));

      const result = await mockCaller.ingestBatch(batchInput);

      expect(result.success).toBe(false);
      expect(result.queuedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors?.[0].webhookIndex).toBe(1);
    });

    it("should reject batch exceeding maximum size", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const tooManyWebhooks = Array.from({ length: 101 }, (_, i) => ({
        organizationId: `org-${i}`,
        event: "test_event",
        data: {
          blockNumber: 12345 + i,
          blockHash: "0x" + "a".repeat(64),
          timestamp: "2024-01-01T00:00:00Z",
          network: "mainnet" as const,
        },
      }));

      const batchInput = {
        webhooks: tooManyWebhooks,
        processingMode: "parallel" as const,
      };

      await expect(mockCaller.ingestBatch(batchInput)).rejects.toThrow();
    });

    it("should reject empty batch", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const batchInput = {
        webhooks: [],
        processingMode: "parallel" as const,
      };

      await expect(mockCaller.ingestBatch(batchInput)).rejects.toThrow();
    });
  });

  describe("validate", () => {
    it("should validate a correct webhook payload", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const validInput = {
        organizationId: "test-org-123",
        event: "payout_claimed",
        data: {
          blockNumber: 12345,
          blockHash: "0x" + "a".repeat(64),
          timestamp: "2024-01-01T00:00:00Z",
          network: "mainnet" as const,
        },
      };

      const result = await mockCaller.validate(validInput);

      expect(result.valid).toBe(true);
      expect(result.message).toContain("valid");
    });

    it("should reject an invalid webhook payload", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const invalidInput = {
        organizationId: "", // Invalid: empty string
        event: "payout_claimed",
        data: {
          blockNumber: "invalid", // Invalid: should be number
        },
      };

      const result = await mockCaller.validate(invalidInput);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it("should reject webhook without blockchain or indexer metadata", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const invalidInput = {
        organizationId: "test-org-123",
        event: "payout_claimed",
        data: {
          someField: "value", // Missing required blockchain or indexer metadata
        },
      };

      const result = await mockCaller.validate(invalidInput);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });

  describe("stats", () => {
    it("should return webhook statistics", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const result = await mockCaller.stats();

      expect(result).toHaveProperty("totalProcessed");
      expect(result).toHaveProperty("successRate");
      expect(result).toHaveProperty("averageProcessingTimeMs");
      expect(result).toHaveProperty("activeQueues");
      expect(result).toHaveProperty("lastIngestionTime");
    });
  });

  describe("concurrency tests", () => {
    it("should handle high concurrency without blocking", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const concurrentRequests = 50;
      const promises = [];

      vi.mocked(webhookService.queueWebhook).mockImplementation(async () => {
        // Simulate async processing
        await new Promise(resolve => setTimeout(resolve, 10));
      });

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

      const startTime = Date.now();
      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // All requests should succeed
      expect(results.every(r => r.success)).toBe(true);
      
      // With 50 concurrent requests, if they were truly parallel,
      // they should complete in roughly the time of the slowest single request
      // Allow some margin for overhead
      expect(duration).toBeLessThan(200); // Should be much faster than sequential (500ms)
    });

    it("should handle batch operations under high load", async () => {
      const mockCaller = webhookRouter.createCaller({});
      
      const batchCount = 10;
      const webhooksPerBatch = 20;
      const promises = [];

      vi.mocked(webhookService.queueWebhook).mockResolvedValue(undefined);

      for (let i = 0; i < batchCount; i++) {
        const batchInput = {
          webhooks: Array.from({ length: webhooksPerBatch }, (_, j) => ({
            organizationId: `org-${i}-${j}`,
            event: "payout_claimed",
            data: {
              blockNumber: 12345 + i * webhooksPerBatch + j,
              blockHash: "0x" + "a".repeat(64),
              timestamp: "2024-01-01T00:00:00Z",
              network: "mainnet" as const,
            },
          })),
          processingMode: "parallel" as const,
        };
        promises.push(mockCaller.ingestBatch(batchInput));
      }

      const results = await Promise.all(promises);

      expect(results.every(r => r.success)).toBe(true);
      expect(results.reduce((sum, r) => sum + r.queuedCount, 0)).toBe(
        batchCount * webhooksPerBatch
      );
    });
  });
});