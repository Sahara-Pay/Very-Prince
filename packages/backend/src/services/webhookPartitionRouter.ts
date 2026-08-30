/**
 * @file webhookPartitionRouter.ts
 * @description Partition-aware router for high-throughput webhook ingestion.
 * 
 * This service manages routing webhook events to appropriate time-based partitions
 * and provides batch insertion capabilities to prevent event loop blocking during
 * heavy Web3 webhook ingestion.
 * 
 * Key Features:
 * - Automatic partition detection based on createdAt timestamp
 * - Batch insertion with chunking to prevent parameter limit overflow
 * - Non-blocking async operations
 * - Partition-aware query routing
 */

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db.js";
import { logger } from "../utils/logger.js";

// ─── Partition Management ─────────────────────────────────────────────────────

/**
 * Extracts partition name from a timestamp based on monthly partitioning strategy.
 * Format: {TableName}_{YYYY}_{MM}
 */
export function getPartitionName(tableName: string, date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${tableName}_${year}_${month}`;
}

/**
 * Extracts the month and year from a partition name.
 * Returns null if the partition name doesn't match expected format.
 */
export function parsePartitionName(partitionName: string): { year: number; month: number } | null {
  const match = partitionName.match(/_(\d{4})_(\d{2})$/);
  if (!match || !match[1] || !match[2]) return null;
  
  return {
    year: parseInt(match[1], 10),
    month: parseInt(match[2], 10),
  };
}

/**
 * Determines if a given date falls within a partition's range.
 */
export function isDateInPartition(date: Date, partitionStart: Date, partitionEnd: Date): boolean {
  return date >= partitionStart && date < partitionEnd;
}

// ─── Batch Types ─────────────────────────────────────────────────────────────

export interface WebhookEventBatchRow {
  organizationId: string;
  eventType: string;
  source: string;
  priority: string;
  payload: string;
  metadata: string | null;
  processedAt: Date;
  createdAt: Date;
  deliveredAt: Date | null;
}

export interface WebhookDeliveryLogBatchRow {
  webhookEventId: string;
  webhookConfigId: string;
  payload: string;
  statusCode: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  retryCount: number;
  deliveredAt: Date | null;
  createdAt: Date;
}

export interface WebhookBatch {
  events: WebhookEventBatchRow[];
  deliveryLogs: WebhookDeliveryLogBatchRow[];
}

export function createEmptyWebhookBatch(): WebhookBatch {
  return {
    events: [],
    deliveryLogs: [],
  };
}

export function webhookBatchHasRows(batch: WebhookBatch): boolean {
  return batch.events.length > 0 || batch.deliveryLogs.length > 0;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const webhookEventRowSchema = z.object({
  organizationId: z.string().trim().min(1).max(191),
  eventType: z.string().trim().min(1).max(128),
  source: z.string().trim().min(1).max(64),
  priority: z.enum(["low", "normal", "high", "critical"]),
  payload: z.string(),
  metadata: z.string().nullable(),
  processedAt: z.date(),
  createdAt: z.date(),
  deliveredAt: z.date().nullable(),
});

const webhookDeliveryLogRowSchema = z.object({
  webhookEventId: z.string().min(1),
  webhookConfigId: z.string().min(1),
  payload: z.string(),
  statusCode: z.number().int().nullable(),
  responseBody: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
  deliveredAt: z.date().nullable(),
  createdAt: z.date(),
});

export class InvalidWebhookBatchError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid webhook batch: ${errors.join("; ")}`);
    this.name = "InvalidWebhookBatchError";
    this.errors = errors;
  }
}

export function assertValidWebhookBatch(batch: WebhookBatch): void {
  const errors: string[] = [];

  const check = <T>(label: string, rows: T[], schema: z.ZodType<T>): void => {
    rows.forEach((row, i) => {
      const parsed = schema.safeParse(row);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join(", ");
        errors.push(`${label}[${i}] ${detail}`);
      }
    });
  };

  check("events", batch.events, webhookEventRowSchema);
  check("deliveryLogs", batch.deliveryLogs, webhookDeliveryLogRowSchema);

  if (errors.length > 0) {
    throw new InvalidWebhookBatchError(errors);
  }
}

// ─── SQL Builders ─────────────────────────────────────────────────────────────

/**
 * Bulk insert for WebhookEvent (partition-aware).
 * Automatically routes to the correct partition based on createdAt timestamp.
 */
export function buildWebhookEventInsertQuery(rows: WebhookEventBatchRow[]): Prisma.Sql {
  if (rows.length === 0) return Prisma.sql`SELECT 0;`;

  const ids: string[] = [];
  const organizationIds: string[] = [];
  const eventTypes: string[] = [];
  const sources: string[] = [];
  const priorities: string[] = [];
  const payloads: string[] = [];
  const metadatas: (string | null)[] = [];
  const processedAts: Date[] = [];
  const createdAts: Date[] = [];
  const deliveredAts: (Date | null)[] = [];

  for (const row of rows) {
    ids.push(generateId());
    organizationIds.push(row.organizationId);
    eventTypes.push(row.eventType);
    sources.push(row.source);
    priorities.push(row.priority);
    payloads.push(row.payload);
    metadatas.push(row.metadata || null);
    processedAts.push(row.processedAt);
    createdAts.push(row.createdAt);
    deliveredAts.push(row.deliveredAt || null);
  }

  return Prisma.sql`
    WITH incoming_data AS (
      SELECT * FROM UNNEST(
        ${ids}::text[],
        ${organizationIds}::text[],
        ${eventTypes}::text[],
        ${sources}::text[],
        ${priorities}::text[],
        ${payloads}::text[],
        ${metadatas}::text[],
        ${processedAts}::timestamptz[],
        ${createdAts}::timestamptz[],
        ${deliveredAts}::timestamptz[]
      ) AS t("id", "organizationId", "eventType", "source", "priority", "payload", "metadata", "processedAt", "createdAt", "deliveredAt")
    )
    INSERT INTO "WebhookEvent" (
      "id", "organizationId", "eventType", "source", "priority", "payload",
      "metadata", "processedAt", "createdAt", "deliveredAt"
    )
    SELECT "id", "organizationId", "eventType", "source", "priority", "payload",
           "metadata", "processedAt", "createdAt", "deliveredAt"
    FROM incoming_data;
  `;
}

/**
 * Bulk insert for WebhookDeliveryLog (partition-aware).
 */
export function buildWebhookDeliveryLogInsertQuery(rows: WebhookDeliveryLogBatchRow[]): Prisma.Sql {
  if (rows.length === 0) return Prisma.sql`SELECT 0;`;

  const ids: string[] = [];
  const webhookEventIds: string[] = [];
  const webhookConfigIds: string[] = [];
  const payloads: string[] = [];
  const statusCodes: (number | null)[] = [];
  const responseBodies: (string | null)[] = [];
  const errorMessages: (string | null)[] = [];
  const retryCounts: number[] = [];
  const deliveredAts: (Date | null)[] = [];
  const createdAts: Date[] = [];

  for (const row of rows) {
    ids.push(generateId());
    webhookEventIds.push(row.webhookEventId);
    webhookConfigIds.push(row.webhookConfigId);
    payloads.push(row.payload);
    statusCodes.push(row.statusCode || null);
    responseBodies.push(row.responseBody || null);
    errorMessages.push(row.errorMessage || null);
    retryCounts.push(row.retryCount);
    deliveredAts.push(row.deliveredAt || null);
    createdAts.push(row.createdAt);
  }

  return Prisma.sql`
    WITH incoming_data AS (
      SELECT * FROM UNNEST(
        ${ids}::text[],
        ${webhookEventIds}::text[],
        ${webhookConfigIds}::text[],
        ${payloads}::text[],
        ${statusCodes}::int[],
        ${responseBodies}::text[],
        ${errorMessages}::text[],
        ${retryCounts}::int[],
        ${deliveredAts}::timestamptz[],
        ${createdAts}::timestamptz[]
      ) AS t("id", "webhookEventId", "webhookConfigId", "payload", "statusCode", "responseBody", "errorMessage", "retryCount", "deliveredAt", "createdAt")
    )
    INSERT INTO "WebhookDeliveryLog" (
      "id", "webhookEventId", "webhookConfigId", "payload", "statusCode",
      "responseBody", "errorMessage", "retryCount", "deliveredAt", "createdAt"
    )
    SELECT "id", "webhookEventId", "webhookConfigId", "payload", "statusCode",
           "responseBody", "errorMessage", "retryCount", "deliveredAt", "createdAt"
    FROM incoming_data;
  `;
}

// ─── Partition Router Service ─────────────────────────────────────────────────

export interface WebhookPartitionFlushResult {
  events: number;
  deliveryLogs: number;
  chunks: number;
  durationMs: number;
  partitionsUsed: string[];
}

export interface WebhookPartitionDb {
  $transaction<T>(fn: (tx: WebhookPartitionTx) => Promise<T>, opts?: { timeout?: number }): Promise<T>;
  $queryRaw<T = unknown>(query: Prisma.Sql, values?: any[]): Promise<T>;
}

export interface WebhookPartitionTx {
  $executeRaw(query: Prisma.Sql): Promise<number>;
  $queryRaw<T = unknown>(query: Prisma.Sql, values?: any[]): Promise<T>;
}

/**
 * Service for partition-aware webhook batch ingestion.
 * 
 * This service handles routing webhook events to appropriate time-based partitions
 * and provides non-blocking batch insertion capabilities.
 */
export class WebhookPartitionRouter {
  constructor(
    private readonly db: WebhookPartitionDb = prisma,
    private readonly chunkSize = 500, // Smaller chunks for webhook data
  ) {}

  /**
   * Validates and flushes a webhook batch to appropriate partitions.
   * Automatically routes events to partitions based on their createdAt timestamp.
   */
  async flush(batch: WebhookBatch): Promise<WebhookPartitionFlushResult> {
    assertValidWebhookBatch(batch);

    if (!webhookBatchHasRows(batch)) {
      return { events: 0, deliveryLogs: 0, chunks: 0, durationMs: 0, partitionsUsed: [] };
    }

    const startedAt = Date.now();
    let chunks = 0;
    const partitionsUsed = new Set<string>();

    // Group events by partition for optimized insertion
    const eventsByPartition = this.groupEventsByPartition(batch.events);
    const deliveryLogsByPartition = this.groupDeliveryLogsByPartition(batch.deliveryLogs);

    await this.db.$transaction(
      async (tx) => {
        // Insert events grouped by partition
        for (const [partitionName, events] of eventsByPartition) {
          partitionsUsed.add(partitionName);
          for (let offset = 0; offset < events.length; offset += this.chunkSize) {
            await tx.$executeRaw(buildWebhookEventInsertQuery(events.slice(offset, offset + this.chunkSize)));
            chunks++;
          }
        }

        // Insert delivery logs grouped by partition
        for (const [partitionName, logs] of deliveryLogsByPartition) {
          partitionsUsed.add(partitionName);
          for (let offset = 0; offset < logs.length; offset += this.chunkSize) {
            await tx.$executeRaw(buildWebhookDeliveryLogInsertQuery(logs.slice(offset, offset + this.chunkSize)));
            chunks++;
          }
        }

        // Yield between chunks to prevent event loop blocking
        if (chunks > 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      },
      { timeout: 60_000 },
    );

    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        events: batch.events.length,
        deliveryLogs: batch.deliveryLogs.length,
        chunks,
        durationMs,
        partitionsUsed: Array.from(partitionsUsed),
      },
      "[WebhookPartitionRouter] batch flushed to partitions",
    );

    return {
      events: batch.events.length,
      deliveryLogs: batch.deliveryLogs.length,
      chunks,
      durationMs,
      partitionsUsed: Array.from(partitionsUsed),
    };
  }

  /**
   * Groups webhook events by their target partition based on createdAt timestamp.
   */
  private groupEventsByPartition(events: WebhookEventBatchRow[]): Map<string, WebhookEventBatchRow[]> {
    const grouped = new Map<string, WebhookEventBatchRow[]>();
    
    for (const event of events) {
      const partitionName = getPartitionName("WebhookEvent", event.createdAt);
      if (!grouped.has(partitionName)) {
        grouped.set(partitionName, []);
      }
      grouped.get(partitionName)!.push(event);
    }
    
    return grouped;
  }

  /**
   * Groups webhook delivery logs by their target partition based on createdAt timestamp.
   */
  private groupDeliveryLogsByPartition(logs: WebhookDeliveryLogBatchRow[]): Map<string, WebhookDeliveryLogBatchRow[]> {
    const grouped = new Map<string, WebhookDeliveryLogBatchRow[]>();
    
    for (const log of logs) {
      const partitionName = getPartitionName("WebhookDeliveryLog", log.createdAt);
      if (!grouped.has(partitionName)) {
        grouped.set(partitionName, []);
      }
      grouped.get(partitionName)!.push(log);
    }
    
    return grouped;
  }

  /**
   * Queries webhook events from a specific time range, automatically routing to correct partitions.
   */
  async queryEventsByTimeRange(
    organizationId: string,
    startDate: Date,
    endDate: Date,
    eventType?: string
  ): Promise<any[]> {
    // Build a query that spans multiple partitions if the time range crosses month boundaries
    const partitions = this.getPartitionsInRange(startDate, endDate, "WebhookEvent");
    
    const allResults = [];
    for (const partition of partitions) {
      let query: Prisma.Sql;
      
      if (eventType) {
        query = Prisma.sql`
          SELECT * FROM ${Prisma.raw(partition)}
          WHERE "organizationId" = ${organizationId}
            AND "createdAt" >= ${startDate}
            AND "createdAt" < ${endDate}
            AND "eventType" = ${eventType}
          ORDER BY "createdAt" DESC
        `;
      } else {
        query = Prisma.sql`
          SELECT * FROM ${Prisma.raw(partition)}
          WHERE "organizationId" = ${organizationId}
            AND "createdAt" >= ${startDate}
            AND "createdAt" < ${endDate}
          ORDER BY "createdAt" DESC
        `;
      }
      
      const results = await this.db.$queryRaw(query);
      allResults.push(...(results as any[]));
    }
    
    return allResults;
  }

  /**
   * Gets the list of partition names that should be queried for a given time range.
   */
  private getPartitionsInRange(startDate: Date, endDate: Date, tableName: string): string[] {
    const partitions: string[] = [];
    const current = new Date(startDate);
    
    while (current < endDate) {
      partitions.push(getPartitionName(tableName, current));
      current.setMonth(current.getMonth() + 1);
    }
    
    return partitions;
  }
}

/** Default singleton bound to the shared Prisma client. */
export const webhookPartitionRouter = new WebhookPartitionRouter();

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Generates a collision-resistant row id for raw inserts.
 * Similar to the approach used in indexerBulkUpsert.ts for consistency.
 */
function generateId(): string {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `webhook_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}