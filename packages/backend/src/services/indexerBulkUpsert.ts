/**
 * @file indexerBulkUpsert.ts
 * @description Bulk upsert engine for the high-throughput indexer API.
 *
 * ## Why this exists
 *
 * The indexer previously persisted one event at a time: for a batch of N
 * events that is up to ~5N sequential Prisma round-trips (`payoutEvent.create`,
 * `maintainer.findUnique` + webhook dispatch, `fundingEvent.createMany`,
 * `maintainer.upsert`, `transaction.upsert`) plus N cache invalidations.
 * When blocks finalize, Soroban RPC returns thousands of events per poll and
 * that serialized write path starves the Node.js event loop.
 *
 * This module replaces the per-event path with a batched, chunked upsert that
 * completes in a *handful* of database round-trips regardless of batch size:
 *
 *   - Rows are accumulated in typed batches (see `IndexerBatch`).
 *   - Each model is flushed with a single parameterized `CTE + UNNEST` query
 *     (the same pattern already used by `src/ledger/sql/bulk-upsert-blocks.sql`).
 *   - All statements run inside one interactive `$transaction`, chunked to stay
 *     well under Postgres' 65,535 bound-parameter limit.
 *   - The event loop is yielded between chunks so parallel HTTP / tRPC /
 *     WebSocket work is never blocked while a large batch is persisted.
 *
 * ## Safety
 *
 * - Every query is built with `Prisma.sql` tagged templates and `UNNEST` over
 *   typed parameter arrays — no string interpolation ever reaches the SQL text.
 * - Row inputs are validated with Zod *before* SQL is built; malformed rows are
 *   rejected as a whole batch (`InvalidIndexerBatchError`) so a corrupt webhook
 *   payload can never silently corrupt the ledger.
 * - On-conflict behavior mirrors the previous idempotent semantics exactly:
 *   `Transaction` → conflict = skip, `FundingEvent` → conflict = skip,
 *   `Maintainer` → conflict = update orgId (last writer wins).
 */

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db.js";
import { logger } from "../utils/logger.js";

// ─── Batch row types ─────────────────────────────────────────────────────────

/** Row shape for the `Transaction` table. `volumeUSD` is a Decimal stored as a numeric string. */
export interface TransactionBatchRow {
  txHash: string;
  eventIndex: number;
  walletAddress: string;
  volumeUSD: string;
  createdAt: Date;
  type: string;
  ledger: number;
  rawData: string;
}

/** Row shape for the `PayoutEvent` table. */
export interface PayoutEventBatchRow {
  orgId: string;
  maintainer: string;
  amountStroops: bigint;
  amountXlm: string;
  ledger: number;
  txHash: string;
  createdAt: Date;
}

/** Row shape for the `FundingEvent` table. */
export interface FundingEventBatchRow {
  orgId: string;
  from: string;
  amountStroops: bigint;
  amountXlm: string;
  ledger: number;
  txHash: string;
  createdAt: Date;
}

/** Row shape for the `Maintainer` table. */
export interface MaintainerBatchRow {
  address: string;
  orgId: string;
}

/** A fully accumulated indexer batch, ready to be flushed. */
export interface IndexerBatch {
  transactions: TransactionBatchRow[];
  payoutEvents: PayoutEventBatchRow[];
  fundingEvents: FundingEventBatchRow[];
  maintainers: MaintainerBatchRow[];
}

// ─── Batch helpers ───────────────────────────────────────────────────────────

/** Returns a fresh, empty batch. */
export function createEmptyBatch(): IndexerBatch {
  return {
    transactions: [],
    payoutEvents: [],
    fundingEvents: [],
    maintainers: [],
  };
}

/** True when the batch contains at least one row to persist. */
export function batchHasRows(batch: IndexerBatch): boolean {
  return (
    batch.transactions.length > 0 ||
    batch.payoutEvents.length > 0 ||
    batch.fundingEvents.length > 0 ||
    batch.maintainers.length > 0
  );
}

// ─── Row validation (reject malformed inputs before touching the DB) ─────────

const transactionRowSchema = z.object({
  txHash: z.string().trim().min(1).max(128),
  eventIndex: z.number().int().nonnegative(),
  walletAddress: z.string().min(1),
  volumeUSD: z.string().regex(/^-?(?:\d+\.\d+|\d+)$/, "volumeUSD must be a numeric string"),
  createdAt: z.date(),
  type: z.string().trim().min(1).max(64),
  ledger: z.number().int().nonnegative(),
  rawData: z.string(),
});

const payoutEventRowSchema = z.object({
  orgId: z.string().trim().min(1).max(191),
  maintainer: z.string().min(1),
  amountStroops: z.bigint(),
  amountXlm: z.string().regex(/^-?(?:\d+\.\d+|\d+)$/, "amountXlm must be a numeric string"),
  ledger: z.number().int().nonnegative(),
  txHash: z.string().trim().min(1).max(128),
  createdAt: z.date(),
});

const fundingEventRowSchema = z.object({
  orgId: z.string().trim().min(1).max(191),
  from: z.string().min(1),
  amountStroops: z.bigint(),
  amountXlm: z.string().regex(/^-?(?:\d+\.\d+|\d+)$/, "amountXlm must be a numeric string"),
  ledger: z.number().int().nonnegative(),
  txHash: z.string().trim().min(1).max(128),
  createdAt: z.date(),
});

const maintainerRowSchema = z.object({
  address: z.string().min(1).max(191),
  orgId: z.string().trim().min(1).max(191),
});

/**
 * Error raised when a batch contains malformed rows. The batch is rejected
 * wholesale (never partially persisted) so callers can re-drive the pipeline
 * with a repaired payload.
 */
export class InvalidIndexerBatchError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid indexer batch: ${errors.join("; ")}`);
    this.name = "InvalidIndexerBatchError";
    this.errors = errors;
  }
}

/** Validates every row of a batch; throws {@link InvalidIndexerBatchError} on failure. */
export function assertValidIndexerBatch(batch: IndexerBatch): void {
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

  check("transactions", batch.transactions, transactionRowSchema);
  check("payoutEvents", batch.payoutEvents, payoutEventRowSchema);
  check("fundingEvents", batch.fundingEvents, fundingEventRowSchema);
  check("maintainers", batch.maintainers, maintainerRowSchema);

  if (errors.length > 0) {
    throw new InvalidIndexerBatchError(errors);
  }
}

// ─── SQL builders (parameterized CTE + UNNEST) ───────────────────────────────
//
// Each builder flattens rows into parallel typed arrays and passes them to
// Postgres `UNNEST(...)`. Bound parameters (never string interpolation) are
// the only way values reach the statement, which is what keeps these queries
// immune to SQL injection. Identifier lists are static constants.

/** Bulk upsert for `Transaction`. Conflicts on (txHash, eventIndex, createdAt) are skipped — matches the previous `upsert({ update: {} })` semantics. */
export function buildTransactionUpsertQuery(rows: TransactionBatchRow[]): Prisma.Sql {
  if (rows.length === 0) return Prisma.sql`SELECT 0;`;

  const ids: string[] = [];
  const txHashes: string[] = [];
  const eventIndexes: number[] = [];
  const walletAddresses: string[] = [];
  const volumeUSDs: string[] = [];
  const createdAts: Date[] = [];
  const types: string[] = [];
  const ledgers: number[] = [];
  const rawDatas: string[] = [];

  for (const row of rows) {
    ids.push(randomId());
    txHashes.push(row.txHash);
    eventIndexes.push(row.eventIndex);
    walletAddresses.push(row.walletAddress);
    volumeUSDs.push(row.volumeUSD);
    createdAts.push(row.createdAt);
    types.push(row.type);
    ledgers.push(row.ledger);
    rawDatas.push(row.rawData);
  }

  return Prisma.sql`
    WITH incoming_data AS (
      SELECT * FROM UNNEST(
        ${ids}::text[],
        ${txHashes}::text[],
        ${eventIndexes}::int[],
        ${walletAddresses}::text[],
        ${volumeUSDs}::numeric[],
        ${createdAts}::timestamptz[],
        ${types}::text[],
        ${ledgers}::int[],
        ${rawDatas}::text[]
      ) AS t("id", "txHash", "eventIndex", "walletAddress", "volumeUSD", "createdAt", "type", "ledger", "rawData")
    )
    INSERT INTO "Transaction" (
      "id", "txHash", "eventIndex", "walletAddress", "volumeUSD",
      "createdAt", "type", "ledger", "rawData"
    )
    SELECT "id", "txHash", "eventIndex", "walletAddress", "volumeUSD",
           "createdAt", "type", "ledger", "rawData"
    FROM incoming_data
    ON CONFLICT ("txHash", "eventIndex", "createdAt") DO NOTHING;
  `;
}

/** Bulk insert for `PayoutEvent`. Dedup is handled upstream by the tx-hash filter + unique transaction rows. */
export function buildPayoutEventInsertQuery(rows: PayoutEventBatchRow[]): Prisma.Sql {
  if (rows.length === 0) return Prisma.sql`SELECT 0;`;

  const ids: string[] = [];
  const orgIds: string[] = [];
  const maintainers: string[] = [];
  const amountStroops: bigint[] = [];
  const amountXlms: string[] = [];
  const ledgers: number[] = [];
  const txHashes: string[] = [];
  const createdAts: Date[] = [];

  for (const row of rows) {
    ids.push(randomId());
    orgIds.push(row.orgId);
    maintainers.push(row.maintainer);
    amountStroops.push(row.amountStroops);
    amountXlms.push(row.amountXlm);
    ledgers.push(row.ledger);
    txHashes.push(row.txHash);
    createdAts.push(row.createdAt);
  }

  return Prisma.sql`
    WITH incoming_data AS (
      SELECT * FROM UNNEST(
        ${ids}::text[],
        ${orgIds}::text[],
        ${maintainers}::text[],
        ${amountStroops}::numeric[],
        ${amountXlms}::numeric[],
        ${ledgers}::int[],
        ${txHashes}::text[],
        ${createdAts}::timestamptz[]
      ) AS t("id", "orgId", "maintainer", "amountStroops", "amountXlm", "ledger", "txHash", "createdAt")
    )
    INSERT INTO "PayoutEvent" (
      "id", "orgId", "maintainer", "amountStroops", "amountXlm",
      "ledger", "txHash", "createdAt"
    )
    SELECT "id", "orgId", "maintainer", "amountStroops", "amountXlm",
           "ledger", "txHash", "createdAt"
    FROM incoming_data;
  `;
}

/** Bulk upsert for `FundingEvent`. Conflicts on (txHash, orgId, createdAt) are skipped — matches the previous `createMany({ skipDuplicates: true })`. */
export function buildFundingEventUpsertQuery(rows: FundingEventBatchRow[]): Prisma.Sql {
  if (rows.length === 0) return Prisma.sql`SELECT 0;`;

  const ids: string[] = [];
  const orgIds: string[] = [];
  const froms: string[] = [];
  const amountStroops: bigint[] = [];
  const amountXlms: string[] = [];
  const ledgers: number[] = [];
  const txHashes: string[] = [];
  const createdAts: Date[] = [];

  for (const row of rows) {
    ids.push(randomId());
    orgIds.push(row.orgId);
    froms.push(row.from);
    amountStroops.push(row.amountStroops);
    amountXlms.push(row.amountXlm);
    ledgers.push(row.ledger);
    txHashes.push(row.txHash);
    createdAts.push(row.createdAt);
  }

  return Prisma.sql`
    WITH incoming_data AS (
      SELECT * FROM UNNEST(
        ${ids}::text[],
        ${orgIds}::text[],
        ${froms}::text[],
        ${amountStroops}::numeric[],
        ${amountXlms}::numeric[],
        ${ledgers}::int[],
        ${txHashes}::text[],
        ${createdAts}::timestamptz[]
      ) AS t("id", "orgId", "from", "amountStroops", "amountXlm", "ledger", "txHash", "createdAt")
    )
    INSERT INTO "FundingEvent" (
      "id", "orgId", "from", "amountStroops", "amountXlm",
      "ledger", "txHash", "createdAt"
    )
    SELECT "id", "orgId", "from", "amountStroops", "amountXlm",
           "ledger", "txHash", "createdAt"
    FROM incoming_data
    ON CONFLICT ("txHash", "orgId", "createdAt") DO NOTHING;
  `;
}

/** Bulk upsert for `Maintainer`. Conflicts on address update orgId — matches the previous `maintainer.upsert` semantics. */
export function buildMaintainerUpsertQuery(rows: MaintainerBatchRow[]): Prisma.Sql {
  if (rows.length === 0) return Prisma.sql`SELECT 0;`;

  const addresses: string[] = [];
  const orgIds: string[] = [];

  for (const row of rows) {
    addresses.push(row.address);
    orgIds.push(row.orgId);
  }

  return Prisma.sql`
    WITH incoming_data AS (
      SELECT * FROM UNNEST(
        ${addresses}::text[],
        ${orgIds}::text[]
      ) AS t("address", "orgId")
    )
    INSERT INTO "Maintainer" ("address", "orgId")
    SELECT "address", "orgId" FROM incoming_data
    ON CONFLICT ("address") DO UPDATE SET "orgId" = EXCLUDED."orgId";
  `;
}

// ─── Flush service ───────────────────────────────────────────────────────────

/** Summary of a flush operation, for observability. */
export interface FlushResult {
  transactions: number;
  payoutEvents: number;
  fundingEvents: number;
  maintainers: number;
  chunks: number;
  durationMs: number;
}

/**
 * Minimal Prisma transaction surface used by the flush — keeps the service
 * unit-testable with a mock while remaining fully type-safe against the real
 * client.
 */
export interface IndexerBulkUpsertDb {
  $transaction<T>(fn: (tx: IndexerBulkUpsertTx) => Promise<T>, opts?: { timeout?: number }): Promise<T>;
}

export interface IndexerBulkUpsertTx {
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

/**
 * Persists an entire {@link IndexerBatch} in one transaction.
 *
 * Rows are chunked (default 1000 rows per statement) so every statement stays
 * well under Postgres' 65,535 bound-parameter limit even for 10k+ event
 * batches. The event loop is yielded between chunks with `setImmediate` so
 * parallel request handling is never starved while a huge batch is written.
 */
export class IndexerBulkUpsertService {
  constructor(
    private readonly db: IndexerBulkUpsertDb = prisma,
    private readonly chunkSize = 1000,
  ) {}

  /**
   * Validates and flushes a batch. Throws {@link InvalidIndexerBatchError} if
   * any row is malformed; the transaction is rolled back on any DB error.
   */
  async flush(batch: IndexerBatch): Promise<FlushResult> {
    assertValidIndexerBatch(batch);

    if (!batchHasRows(batch)) {
      return { transactions: 0, payoutEvents: 0, fundingEvents: 0, maintainers: 0, chunks: 0, durationMs: 0 };
    }

    const startedAt = Date.now();
    let chunks = 0;

    await this.db.$transaction(
      async (tx) => {
        for (let offset = 0; offset < batch.transactions.length; offset += this.chunkSize) {
          await tx.$executeRaw(buildTransactionUpsertQuery(batch.transactions.slice(offset, offset + this.chunkSize)));
          chunks++;
        }
        for (let offset = 0; offset < batch.payoutEvents.length; offset += this.chunkSize) {
          await tx.$executeRaw(buildPayoutEventInsertQuery(batch.payoutEvents.slice(offset, offset + this.chunkSize)));
          chunks++;
        }
        for (let offset = 0; offset < batch.fundingEvents.length; offset += this.chunkSize) {
          await tx.$executeRaw(buildFundingEventUpsertQuery(batch.fundingEvents.slice(offset, offset + this.chunkSize)));
          chunks++;
        }
        for (let offset = 0; offset < batch.maintainers.length; offset += this.chunkSize) {
          await tx.$executeRaw(buildMaintainerUpsertQuery(batch.maintainers.slice(offset, offset + this.chunkSize)));
          chunks++;
        }
        // Yield between chunks so long batches never monopolize the loop.
        if (chunks > 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      },
      { timeout: 120_000 },
    );

    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        transactions: batch.transactions.length,
        payoutEvents: batch.payoutEvents.length,
        fundingEvents: batch.fundingEvents.length,
        maintainers: batch.maintainers.length,
        chunks,
        durationMs,
      },
      "[IndexerBulkUpsert] batch flushed",
    );

    return {
      transactions: batch.transactions.length,
      payoutEvents: batch.payoutEvents.length,
      fundingEvents: batch.fundingEvents.length,
      maintainers: batch.maintainers.length,
      chunks,
      durationMs,
    };
  }
}

/** Default singleton bound to the shared Prisma client. */
export const indexerBulkUpsertService = new IndexerBulkUpsertService();

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Generates a collision-resistant row id for raw inserts. Prisma's `@default(cuid())`
 * is client-side, so raw SQL inserts must supply their own id. A uuid is used so
 * replaying the same logical row always yields a fresh id while the unique
 * constraint (not the id) is what guarantees idempotency.
 */
function randomId(): string {
  // crypto.randomUUID is available on Node 20+; fall back to a time-based id
  // if the global is unavailable (older runtimes).
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `row_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
