/**
 * @file streamingJsonLoad.test.ts
 * @description Load and performance tests for streaming JSON serialization.
 * Tests verify that streaming JSON serialization performs optimally under heavy load
 * and maintains non-blocking behavior during high-concurrency scenarios.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  streamWebhookPayload,
  nonBlockingStringify,
  safeStringify,
  streamWebhookBatchResults,
} from "../utils/streamingJson.js";
import type { ServerResponse } from "node:http";

describe("Streaming JSON Load Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Performance Under Heavy Load", () => {
    it("should handle large payloads without blocking event loop", async () => {
      // Create a large webhook payload (~1MB)
      const largePayload = {
        organizationId: "test-org",
        event: "payout_claimed",
        data: {
          blockNumber: 12345,
          blockHash: "0x" + "a".repeat(64),
          timestamp: "2024-01-01T00:00:00Z",
          network: "mainnet",
          // Add large array to create significant payload size
          transactions: Array.from({ length: 10000 }, (_, i) => ({
            id: `tx-${i}`,
            amount: Math.random() * 1000,
            maintainer: "G" + "A".repeat(55),
            timestamp: new Date(Date.now() + i * 1000).toISOString(),
          })),
        },
      };

      const startTime = Date.now();
      let eventLoopBlocked = false;

      // Start streaming the payload
      const streamPromise = (async () => {
        const chunks: string[] = [];
        for await (const chunk of streamWebhookPayload(largePayload)) {
          chunks.push(chunk);
          // Check if event loop is still responsive
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        return chunks.join('');
      })();

      // Check event loop responsiveness during streaming
      const checkInterval = setInterval(() => {
        const checkStart = Date.now();
        Promise.resolve().then(() => {
          if (Date.now() - checkStart > 50) {
            eventLoopBlocked = true;
          }
        });
      }, 10);

      await streamPromise;
      clearInterval(checkInterval);

      const duration = Date.now() - startTime;

      expect(eventLoopBlocked).toBe(false);
      expect(duration).toBeLessThan(1000); // Should complete quickly
    });

    it("should handle concurrent streaming operations efficiently", async () => {
      const concurrentStreams = 50;
      const payloads = Array.from({ length: concurrentStreams }, (_, i) => ({
        organizationId: `org-${i}`,
        event: "test_event",
        data: {
          index: i,
          largeArray: Array.from({ length: 1000 }, (_, j) => ({
            id: `item-${j}`,
            value: Math.random(),
          })),
        },
      }));

      const startTime = Date.now();
      const promises = payloads.map(payload =>
        (async () => {
          const chunks: string[] = [];
          for await (const chunk of streamWebhookPayload(payload)) {
            chunks.push(chunk);
          }
          return chunks.join('');
        })()
      );

      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      expect(results.length).toBe(concurrentStreams);
      expect(results.every(r => r.length > 0)).toBe(true);
      
      // With concurrent operations, should still complete reasonably fast
      expect(duration).toBeLessThan(2000);
    });

    it("should maintain consistent performance with increasing payload sizes", async () => {
      const sizes = [1000, 10000, 100000]; // Different payload sizes
      const durations: number[] = [];

      for (const size of sizes) {
        const payload = {
          organizationId: "test-org",
          event: "test_event",
          data: {
            items: Array.from({ length: size }, (_, i) => ({
              id: `item-${i}`,
              value: Math.random(),
            })),
          },
        };

        const startTime = Date.now();
        const chunks: string[] = [];
        for await (const chunk of streamWebhookPayload(payload)) {
          chunks.push(chunk);
        }
        chunks.join('');
        durations.push(Date.now() - startTime);
      }

      // Performance should scale reasonably with size
      // Larger payloads should not cause exponential time increase
      expect(durations[1]).toBeLessThan(durations[0] * 20); // 10x size, <20x time
      expect(durations[2]).toBeLessThan(durations[1] * 20); // 10x size, <20x time
    });
  });

  describe("Non-Blocking Stringify Performance", () => {
    it("should yield control to event loop for large objects", async () => {
      const largeObject = {
        data: Array.from({ length: 50000 }, (_, i) => ({
          id: i,
          value: Math.random(),
          nested: {
            field1: "value",
            field2: Array.from({ length: 10 }, (_, j) => j),
          },
        })),
      };

      let yieldCount = 0;
      const originalPromiseResolve = Promise.resolve.bind(Promise);
      
      // Track Promise.resolve calls to measure yielding
      vi.spyOn(Promise, 'resolve').mockImplementation(() => {
        yieldCount++;
        return originalPromiseResolve();
      });

      const chunks: string[] = [];
      for await (const chunk of nonBlockingStringify(largeObject, 1024)) {
        chunks.push(chunk);
      }

      const result = chunks.join('');

      expect(result.length).toBeGreaterThan(0);
      expect(yieldCount).toBeGreaterThan(10); // Should yield multiple times
    });

    it("should use direct stringify for small objects", async () => {
      const smallObject = { test: "value", number: 123 };

      let yieldCount = 0;
      vi.spyOn(Promise, 'resolve').mockImplementation(() => {
        yieldCount++;
        return Promise.resolve();
      });

      const chunks: string[] = [];
      for await (const chunk of nonBlockingStringify(smallObject, 1024)) {
        chunks.push(chunk);
      }

      const result = chunks.join('');

      expect(result).toBe(JSON.stringify(smallObject));
      expect(yieldCount).toBe(0); // Should not yield for small objects
    });

    it("should handle complex nested structures efficiently", async () => {
      const complexObject = {
        level1: {
          level2: {
            level3: {
              data: Array.from({ length: 1000 }, (_, i) => ({
                id: i,
                nested: {
                  deeply: {
                    nested: {
                      value: Math.random(),
                    },
                  },
                },
              })),
            },
          },
        },
      };

      const startTime = Date.now();
      const chunks: string[] = [];
      for await (const chunk of nonBlockingStringify(complexObject, 4096)) {
        chunks.push(chunk);
      }
      const result = chunks.join('');
      const duration = Date.now() - startTime;

      expect(result).toBe(JSON.stringify(complexObject));
      expect(duration).toBeLessThan(500); // Should complete quickly
    });
  });

  describe("Memory Efficiency Tests", () => {
    it("should not cause memory leaks with repeated streaming operations", async () => {
      const initialMemory = process.memoryUsage().heapUsed;

      // Perform multiple streaming operations
      for (let i = 0; i < 100; i++) {
        const payload = {
          organizationId: `org-${i}`,
          event: "test_event",
          data: {
            items: Array.from({ length: 1000 }, (_, j) => ({
              id: `item-${j}`,
              value: Math.random(),
            })),
          },
        };

        const chunks: string[] = [];
        for await (const chunk of streamWebhookPayload(payload)) {
          chunks.push(chunk);
        }
        chunks.join('');
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable (< 20MB for this test)
      expect(memoryIncrease).toBeLessThan(20 * 1024 * 1024);
    });

    it("should handle memory spikes gracefully", async () => {
      const operations = [];
      
      // Create many large streaming operations simultaneously
      for (let i = 0; i < 20; i++) {
        const payload = {
          organizationId: `org-${i}`,
          event: "test_event",
          data: {
            items: Array.from({ length: 5000 }, (_, j) => ({
              id: `item-${j}`,
              value: Math.random(),
              largeString: "x".repeat(100),
            })),
          },
        };

        operations.push(
          (async () => {
            const chunks: string[] = [];
            for await (const chunk of streamWebhookPayload(payload)) {
              chunks.push(chunk);
            }
            return chunks.join('');
          })()
        );
      }

      const initialMemory = process.memoryUsage().heapUsed;
      await Promise.all(operations);
      
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory should be cleaned up after operations complete
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024); // < 50MB increase
    });
  });

  describe("Type-Safe Serialization Performance", () => {
    it("should validate efficiently with Zod schemas", async () => {
      const schema = {
        safeParse: vi.fn((data: unknown) => ({
          success: true,
          data: data as { test: string },
        })),
      };

      const testData = { test: "value", number: 123 };

      const startTime = Date.now();
      const result = await safeStringify(testData, schema);
      const duration = Date.now() - startTime;

      expect(result).toBe(JSON.stringify(testData));
      expect(schema.safeParse).toHaveBeenCalled();
      expect(duration).toBeLessThan(100); // Validation should be fast
    });

    it("should handle validation errors gracefully", async () => {
      const schema = {
        safeParse: vi.fn((data: unknown) => ({
          success: false,
          error: { issues: [{ path: ["test"], message: "Invalid" }] },
        })),
      };

      const testData = { test: "value" };

      await expect(safeStringify(testData, schema)).rejects.toThrow("Type validation failed");
      expect(schema.safeParse).toHaveBeenCalled();
    });

    it("should skip validation when schema not provided", async () => {
      const testData = { test: "value", number: 123 };

      const startTime = Date.now();
      const result = await safeStringify(testData);
      const duration = Date.now() - startTime;

      expect(result).toBe(JSON.stringify(testData));
      expect(duration).toBeLessThan(50); // Should be very fast without validation
    });
  });

  describe("Real-World Scenario Simulations", () => {
    it("should simulate high-frequency block indexer webhooks", async () => {
      const totalBlocks = 100;
      const operations = [];

      for (let i = 0; i < totalBlocks; i++) {
        const webhookPayload = {
          organizationId: "indexer-org",
          event: "block_processed",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: new Date(Date.now() + i * 100).toISOString(),
            network: "mainnet",
            indexerId: "stellar-indexer-1",
            sequence: i,
            eventType: "block",
            transactions: Array.from({ length: 100 }, (_, j) => ({
              hash: "0x" + "b".repeat(64),
              index: j,
            })),
          },
        };

        operations.push(
          (async () => {
            const chunks: string[] = [];
            for await (const chunk of streamWebhookPayload(webhookPayload)) {
              chunks.push(chunk);
            }
            return chunks.join('');
          })()
        );
      }

      const startTime = Date.now();
      const results = await Promise.all(operations);
      const duration = Date.now() - startTime;

      expect(results.length).toBe(totalBlocks);
      expect(results.every(r => r.length > 0)).toBe(true);
      expect(duration).toBeLessThan(5000); // Should process 100 blocks quickly
    });

    it("should simulate burst traffic during network congestion", async () => {
      const burstSize = 200;
      const operations = [];

      for (let i = 0; i < burstSize; i++) {
        const webhookPayload = {
          organizationId: `org-${i % 10}`, // 10 different orgs
          event: "payout_claimed",
          data: {
            blockNumber: 12345 + i,
            blockHash: "0x" + "a".repeat(64),
            timestamp: "2024-01-01T00:00:00Z",
            network: "mainnet",
            maintainer: "G" + "A".repeat(55),
            amountStroops: "10000000",
            txHash: "a".repeat(64),
          },
        };

        operations.push(
          (async () => {
            const chunks: string[] = [];
            for await (const chunk of streamWebhookPayload(webhookPayload)) {
              chunks.push(chunk);
            }
            return chunks.join('');
          })()
        );
      }

      const startTime = Date.now();
      const results = await Promise.all(operations);
      const duration = Date.now() - startTime;

      expect(results.length).toBe(burstSize);
      expect(results.every(r => r.length > 0)).toBe(true);
      expect(duration).toBeLessThan(3000); // Should handle burst efficiently
    });

    it("should simulate mixed payload sizes realistically", async () => {
      const operations = [];
      
      // Mix of small, medium, and large payloads
      for (let i = 0; i < 50; i++) {
        const size = i % 3 === 0 ? 100 : i % 3 === 1 ? 1000 : 10000;
        const webhookPayload = {
          organizationId: `org-${i}`,
          event: "test_event",
          data: {
            items: Array.from({ length: size }, (_, j) => ({
              id: `item-${j}`,
              value: Math.random(),
            })),
          },
        };

        operations.push(
          (async () => {
            const chunks: string[] = [];
            for await (const chunk of streamWebhookPayload(webhookPayload)) {
              chunks.push(chunk);
            }
            return chunks.join('');
          })()
        );
      }

      const startTime = Date.now();
      const results = await Promise.all(operations);
      const duration = Date.now() - startTime;

      expect(results.length).toBe(50);
      expect(results.every(r => r.length > 0)).toBe(true);
      expect(duration).toBeLessThan(2000); // Should handle mixed sizes efficiently
    });
  });

  describe("Batch Results Streaming Performance", () => {
    it("should stream large batch results efficiently", async () => {
      const mockReply = {
        raw: {
          setHeader: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
          headersSent: false,
        },
      } as unknown as ServerResponse;

      const largeResults = Array.from({ length: 1000 }, (_, i) => ({
        organizationId: `org-${i}`,
        event: "test_event",
        success: true,
        processingTimeMs: Math.random() * 100,
      }));

      const asyncResults = (async function* gen() {
        for (const result of largeResults) {
          yield result;
          await new Promise(resolve => setTimeout(resolve, 0)); // Simulate async
        }
      })();

      const startTime = Date.now();
      await streamWebhookBatchResults(mockReply.raw, asyncResults, {});
      const duration = Date.now() - startTime;

      expect(mockReply.raw.setHeader).toHaveBeenCalled();
      expect(duration).toBeLessThan(1000); // Should stream quickly
    });

    it("should handle concurrent batch streaming", async () => {
      const mockReply = {
        raw: {
          setHeader: vi.fn(),
          write: vi.fn(),
          end: vi.fn(),
          headersSent: false,
        },
      } as unknown as ServerResponse;

      const concurrentBatches = 10;
      const operations = [];

      for (let i = 0; i < concurrentBatches; i++) {
        const results = Array.from({ length: 100 }, (_, j) => ({
          id: `${i}-${j}`,
          success: true,
        }));

        const asyncResults = (async function* gen() {
          for (const result of results) {
            yield result;
          }
        })();

        operations.push(
          streamWebhookBatchResults(mockReply.raw, asyncResults, {})
        );
      }

      const startTime = Date.now();
      await Promise.all(operations);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(2000); // Should handle concurrent batches
    });
  });

  describe("Edge Cases and Error Handling Under Load", () => {
    it("should handle circular references gracefully", async () => {
      const circularObj: any = { test: "value" };
      circularObj.self = circularObj;

      await expect(nonBlockingStringify(circularObj)).rejects.toThrow();
    });

    it("should handle undefined values safely", async () => {
      const objWithUndefined = { test: undefined, value: "defined" };

      const result = await nonBlockingStringify(objWithUndefined);
      expect(result).toBe(JSON.stringify(objWithUndefined));
    });

    it("should handle very large strings efficiently", async () => {
      const largeStringObj = {
        text: "x".repeat(1000000), // 1MB string
      };

      const startTime = Date.now();
      const chunks: string[] = [];
      for await (const chunk of nonBlockingStringify(largeStringObj, 65536)) {
        chunks.push(chunk);
      }
      const result = chunks.join('');
      const duration = Date.now() - startTime;

      expect(result).toBe(JSON.stringify(largeStringObj));
      expect(duration).toBeLessThan(500); // Should handle large strings efficiently
    });

    it("should handle special characters correctly", async () => {
      const specialCharsObj = {
        unicode: "你好世界 🌍",
        emoji: "😀🎉",
        escape: "line1\nline2\ttab",
        quotes: 'text with "quotes" and \'apostrophes\'',
      };

      const result = await nonBlockingStringify(specialCharsObj);
      expect(result).toBe(JSON.stringify(specialCharsObj));
    });
  });
});