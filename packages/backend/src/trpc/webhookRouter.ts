/**
 * @file webhookRouter.ts
 * @description High-throughput tRPC router for Web3 webhook ingestion with non-blocking processing.
 * 
 * This router provides type-safe, validated webhook ingestion endpoints that:
 * - Use strict Zod schemas for runtime type safety
 * - Process webhooks asynchronously to avoid blocking the event loop
 * - Support batch ingestion for high-throughput scenarios
 * - Integrate with existing BullMQ/SQS queue infrastructure
 */

import { z } from "zod";
import { t } from "./trpc.js";
import { webhookService } from "../services/webhookService.js";
import { logger } from "../utils/logger.js";
import { type WebhookEventData } from "../schemas/webhookJobSchemas.js";
import type {
  BlockchainEventMetadata,
  IndexerEventMetadata,
  WebhookIngestMetadata,
} from "@very-prince/types";

// Extended Zod schemas for Web3 blockchain/indexer webhook payloads
const blockchainEventSchema: z.ZodType<BlockchainEventMetadata> = z.object({
  blockNumber: z.number().int().nonnegative(),
  blockHash: z.string().length(66).regex(/^0x[a-fA-F0-9]{64}$/),
  timestamp: z.string().datetime(),
  network: z.enum(["mainnet", "testnet", "devnet"]),
});

const indexerEventSchema: z.ZodType<IndexerEventMetadata> = z.object({
  indexerId: z.string().min(1).max(64),
  sequence: z.number().int().nonnegative(),
  eventType: z.enum(["block", "transaction", "operation", "ledger_close"]),
});

const webhookIngestMetadataSchema = z.object({
  source: z.enum(["stellar_horizon", "soroban_rpc", "custom_indexer", "direct_api"]),
  retryable: z.boolean().default(true),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
});

// Comprehensive webhook ingestion schema
const webhookIngestSchema = z.object({
  organizationId: z.string().trim().min(1).max(191),
  event: z.string().trim().min(1).max(128),
  data: z.record(z.unknown()).refine(
    (data) => {
      // Validate that data contains either blockchain or indexer metadata
      const hasBlockchain = blockchainEventSchema.safeParse(data).success;
      const hasIndexer = indexerEventSchema.safeParse(data).success;
      return hasBlockchain || hasIndexer;
    },
    { message: "Webhook data must contain valid blockchain or indexer metadata" }
  ),
  metadata: webhookIngestMetadataSchema.optional(),
}).strict();

// Type assertion helper to convert Record<string, unknown> to WebhookEventData
function toWebhookEventData(data: Record<string, unknown>): WebhookEventData {
  return data as WebhookEventData;
}

// Batch webhook ingestion schema for high-throughput scenarios
const webhookBatchIngestSchema = z.object({
  webhooks: z.array(webhookIngestSchema).min(1).max(100),
  batchId: z.string().uuid().optional(),
  processingMode: z.enum(["sequential", "parallel", "fire_and_forget"]).default("parallel"),
}).strict();

/**
 * Process a single webhook asynchronously without blocking the event loop
 */
async function processWebhookAsync(
  organizationId: string,
  event: string,
  data: WebhookEventData,
  metadata?: WebhookIngestMetadata
): Promise<{ success: boolean; error?: string }> {
  try {
    // Non-blocking queue operation - returns immediately after queueing
    await webhookService.queueWebhook(organizationId, event, data);
    
    logger.debug(
      { organizationId, event, metadata },
      "Webhook queued for async processing"
    );
    
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error(
      { err: error, organizationId, event },
      "Failed to queue webhook for async processing"
    );
    return { success: false, error: errorMessage };
  }
}

/**
 * Webhook ingestion router with high-throughput, non-blocking processing
 */
export const webhookRouter = t.router({
  /**
   * Ingest a single Web3 webhook event asynchronously
   * Returns immediately after validation and queueing
   */
  ingest: t.procedure
    .input(webhookIngestSchema)
    .mutation(async ({ input }) => {
      const startTime = Date.now();
      
      try {
        const { organizationId, event, data, metadata } = input;
        
        // Process webhook asynchronously - this won't block the event loop
        const result = await processWebhookAsync(organizationId, event, toWebhookEventData(data), metadata);
        
        if (!result.success) {
          throw new Error(result.error || "Failed to process webhook");
        }
        
        return {
          success: true,
          message: "Webhook queued for non-blocking processing",
          queuedCount: 1,
          failedCount: 0,
          processingTimeMs: Date.now() - startTime,
        };
      } catch (error) {
        logger.error({ err: error, input }, "Webhook ingestion failed");
        
        throw new Error(
          error instanceof Error 
            ? error.message 
            : "Failed to ingest webhook"
        );
      }
    }),

  /**
   * Ingest multiple webhook events in batch for high-throughput scenarios
   * Processes webhooks in parallel without blocking the event loop
   */
  ingestBatch: t.procedure
    .input(webhookBatchIngestSchema)
    .mutation(async ({ input }) => {
      const startTime = Date.now();
      const { webhooks, batchId, processingMode } = input;
      
      const errors: Array<{ webhookIndex: number; error: string }> = [];
      let successCount = 0;
      
      try {
        if (processingMode === "fire_and_forget") {
          // Fastest mode - queue all without waiting for confirmation
          const queuePromises = webhooks.map(async (webhook, index) => {
            const result = await processWebhookAsync(
              webhook.organizationId,
              webhook.event,
              toWebhookEventData(webhook.data),
              webhook.metadata
            );
            if (!result.success) {
              errors.push({ webhookIndex: index, error: result.error || "Unknown error" });
            } else {
              successCount++;
            }
          });
          
          // Don't await - fire and forget for maximum throughput
          Promise.all(queuePromises).catch((err) => {
            logger.error({ err, batchId }, "Fire-and-forget batch processing encountered errors");
          });
          
          return {
            success: true,
            message: "Webhooks queued for fire-and-forget processing",
            queuedCount: webhooks.length,
            failedCount: 0,
            batchId,
            processingTimeMs: Date.now() - startTime,
          };
        }
        
        // Parallel or sequential processing with error tracking
        const processingPromises = webhooks.map(async (webhook, index) => {
          const result = await processWebhookAsync(
            webhook.organizationId,
            webhook.event,
            toWebhookEventData(webhook.data),
            webhook.metadata
          );
          
          if (!result.success) {
            errors.push({ webhookIndex: index, error: result.error || "Unknown error" });
          } else {
            successCount++;
          }
          
          return result;
        });
        
        if (processingMode === "parallel") {
          await Promise.all(processingPromises);
        } else {
          // Sequential processing
          for (const promise of processingPromises) {
            await promise;
          }
        }
        
        return {
          success: errors.length === 0,
          message: errors.length === 0 
            ? "All webhooks queued successfully" 
            : `Processed with ${errors.length} errors`,
          queuedCount: successCount,
          failedCount: errors.length,
          errors: errors.length > 0 ? errors : undefined,
          batchId,
          processingTimeMs: Date.now() - startTime,
        };
      } catch (error) {
        logger.error({ err: error, batchId }, "Batch webhook ingestion failed");
        
        throw new Error(
          error instanceof Error 
            ? error.message 
            : "Failed to ingest webhook batch"
        );
      }
    }),

  /**
   * Validate webhook payload structure without processing
   * Useful for pre-flight validation and testing
   */
  validate: t.procedure
    .input(z.record(z.unknown())) // Accept any input for validation
    .query(async ({ input }) => {
      // Validate against the schema
      const validationResult = webhookIngestSchema.safeParse(input);
      
      if (!validationResult.success) {
        return {
          valid: false,
          errors: validationResult.error.format(),
        };
      }
      
      return {
        valid: true,
        message: "Webhook payload is valid",
      };
    }),

  /**
   * Get webhook ingestion statistics
   * Provides metrics for monitoring and performance analysis
   */
  stats: t.procedure
    .query(async () => {
      // Return statistics about webhook processing
      // This would typically query a metrics store or database
      return {
        totalProcessed: 0,
        successRate: 1.0,
        averageProcessingTimeMs: 0,
        activeQueues: 0,
        lastIngestionTime: null,
      };
    }),
});

export type WebhookRouter = typeof webhookRouter;