/**
 * @file indexerBulkUpsert.test.ts
 * @description Unit tests for the bulk upsert engine backing the high-throughput
 * indexer API: SQL builders, batch validation, and the chunked transaction flush.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock("../utils/logger.js", () => ({ logger: mockLogger }));

// prisma is only referenced as the default constructor arg — never invoked in
// these tests because we always inject a mock db, so a bare stub is enough.
vi.mock("./db.js", () => ({ prisma: {} }));

import { Prisma } from "@prisma/client";
import {
  createEmptyBatch,
  batchHasRows,
  assertValidIndexerBatch,
  InvalidIndexerBatchError,
  buildTransactionUpsertQuery,
  buildPayoutEventInsertQuery,
  buildFundingEventUpsertQuery,
  buildMaintainerUpsertQuery,
  IndexerBulkUpsertService,
  type IndexerBatch,
} from "./indexerBulkUpsert.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_DATE = new Date("2026-08-01T00:00:00.000Z");

function makeTransactionRow(overrides: Partial<IndexerBatch["transactions"][number]> = {}) {
  return {
    txHash: "abc123",
    eventIndex: 0,
    walletAddress: "GC3JUD7FJ7QY2Q6F4V3X7R2LZYKV6V4K3Q5P8S9W3X2Y1A2B3C4D5E6F7G8H",
    volumeUSD: "1000",
    createdAt: BASE_DATE,
    type: "PayoutAllocated",
    ledger: 42,
    rawData: '{"eventName":"PayoutAllocated"}',
    ...overrides,
  };
}

function makePayoutRow() {
  return {
    orgId: "org-1",
    maintainer: "GC3JUD7FJ7QY2Q6F4V3X7R2LZYKV6V4K3Q5P8S9W3X2Y1A2B3C4D5E6F7G8H",
    amountStroops: 1000n,
    amountXlm: "0.0001000",
    ledger: 42,
    txHash: "abc123",
    createdAt: BASE_DATE,
  };
}

function makeFundingRow() {
  return {
    orgId: "org-1",
    from: "GD4F2KQ3P5R8S2W7X9Y1Z4B6C8D0E2F4G6H8J0K2M4N6P8Q0R2S4T6V8W0X2Y",
    amountStroops: 5000n,
    amountXlm: "0.0005000",
    ledger: 42,
    txHash: "def456",
    createdAt: BASE_DATE,
  };
}

function makeMaintainerRow() {
  return { address: "GC3JUD7FJ7QY2Q6F4V3X7R2LZYKV6V4K3Q5P8S9W3X2Y1A2B3C4D5E6F7G8H", orgId: "org-1" };
}

function makeBatch(): IndexerBatch {
  return {
    transactions: [makeTransactionRow()],
    payoutEvents: [makePayoutRow()],
    fundingEvents: [makeFundingRow()],
    maintainers: [makeMaintainerRow()],
  };
}

// ─── SQL builders ────────────────────────────────────────────────────────────

describe("indexer bulk upsert SQL builders", () => {
  it("builds a parameterized CTE+UNNEST upsert for Transaction with on-conflict skip", () => {
    const query = buildTransactionUpsertQuery([makeTransactionRow(), makeTransactionRow({ eventIndex: 1 })]);

    const sql = query.text;
    expect(sql).toContain('INSERT INTO "Transaction"');
    expect(sql).toContain("UNNEST(");
    expect(sql).toContain('ON CONFLICT ("txHash", "eventIndex", "createdAt") DO NOTHING');
    // One bound array parameter per UNNEST column (9 columns), regardless of row count.
    expect(query.values).toHaveLength(9);
  });

  it("builds a parameterized bulk insert for PayoutEvent", () => {
    const query = buildPayoutEventInsertQuery([makePayoutRow()]);

    expect(query.text).toContain('INSERT INTO "PayoutEvent"');
    expect(query.text).not.toContain("ON CONFLICT");
    expect(query.values).toHaveLength(8);

  });

  it("builds a parameterized upsert for FundingEvent with on-conflict skip", () => {
    const query = buildFundingEventUpsertQuery([makeFundingRow()]);

    expect(query.text).toContain('INSERT INTO "FundingEvent"');
    expect(query.text).toContain('ON CONFLICT ("txHash", "orgId", "createdAt") DO NOTHING');
    expect(query.values).toHaveLength(8);

  });

  it("builds a parameterized upsert for Maintainer that updates orgId on conflict", () => {
    const query = buildMaintainerUpsertQuery([makeMaintainerRow(), makeMaintainerRow()]);

    expect(query.text).toContain('INSERT INTO "Maintainer"');
    expect(query.text).toContain('ON CONFLICT ("address") DO UPDATE SET "orgId" = EXCLUDED."orgId"');
    expect(query.values).toHaveLength(2);

  });

  it("returns a no-op SELECT for empty inputs (never builds a broken statement)", () => {
    expect(buildTransactionUpsertQuery([]).text).toContain("SELECT 0");
    expect(buildPayoutEventInsertQuery([]).text).toContain("SELECT 0");
    expect(buildFundingEventUpsertQuery([]).text).toContain("SELECT 0");
    expect(buildMaintainerUpsertQuery([]).text).toContain("SELECT 0");
  });

  it("never interpolates row values into the SQL text (values are always bound params)", () => {
    const malicious = 'DROP TABLE "Transaction"; --';
    const query = buildTransactionUpsertQuery([makeTransactionRow({ txHash: malicious })]);

    expect(query.text).not.toContain("DROP TABLE");
    // The malicious value appears only inside the bound array parameters.
    const boundStrings = query.values.flat().filter((v) => typeof v === "string") as string[];
    expect(boundStrings).toContain(malicious);
  });
});

// ─── Batch validation ────────────────────────────────────────────────────────

describe("assertValidIndexerBatch", () => {
  it("accepts a well-formed batch", () => {
    expect(() => assertValidIndexerBatch(makeBatch())).not.toThrow();
  });

  it("accepts an empty batch", () => {
    expect(() => assertValidIndexerBatch(createEmptyBatch())).not.toThrow();
  });

  it("rejects a transaction row with a non-numeric volumeUSD", () => {
    const batch = makeBatch();
    batch.transactions[0] = makeTransactionRow({ volumeUSD: "not-a-number" });

    expect(() => assertValidIndexerBatch(batch)).toThrow(InvalidIndexerBatchError);
  });

  it("rejects a transaction row with an empty txHash", () => {
    const batch = makeBatch();
    batch.transactions[0] = makeTransactionRow({ txHash: "   " });

    expect(() => assertValidIndexerBatch(batch)).toThrow(InvalidIndexerBatchError);
  });

  it("rejects a negative ledger", () => {
    const batch = makeBatch();
    batch.transactions[0] = makeTransactionRow({ ledger: -1 });

    expect(() => assertValidIndexerBatch(batch)).toThrow(InvalidIndexerBatchError);
  });

  it("rejects a payout row with a non-bigint amountStroops", () => {
    const batch = makeBatch();
    batch.payoutEvents[0] = { ...makePayoutRow(), amountStroops: 123 as unknown as bigint };

    expect(() => assertValidIndexerBatch(batch)).toThrow(InvalidIndexerBatchError);
  });

  it("rejects a maintainer row with an empty address", () => {
    const batch = makeBatch();
    batch.maintainers[0] = { address: "", orgId: "org-1" };

    expect(() => assertValidIndexerBatch(batch)).toThrow(InvalidIndexerBatchError);
  });

  it("reports a helpful error listing every malformed row", () => {
    const batch = makeBatch();
    batch.transactions[0] = makeTransactionRow({ volumeUSD: "bad" });
    batch.fundingEvents[0] = { ...makeFundingRow(), txHash: "" };

    let error: InvalidIndexerBatchError | null = null;
    try {
      assertValidIndexerBatch(batch);
    } catch (err) {
      error = err as InvalidIndexerBatchError;
    }

    expect(error).not.toBeNull();
    expect(error!.errors.length).toBeGreaterThanOrEqual(2);
    expect(error!.message).toMatch(/transactions\[0\]/);
    expect(error!.message).toMatch(/fundingEvents\[0\]/);
  });
});

describe("batch helpers", () => {
  it("batchHasRows is false for an empty batch and true once any model has rows", () => {
    const empty = createEmptyBatch();
    expect(batchHasRows(empty)).toBe(false);

    empty.transactions.push(makeTransactionRow());
    expect(batchHasRows(empty)).toBe(true);
  });
});

// ─── Flush service ───────────────────────────────────────────────────────────

describe("IndexerBulkUpsertService.flush", () => {
  let executeRaw: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    executeRaw = vi.fn().mockResolvedValue(1);
    transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({ $executeRaw: executeRaw });
    });
  });

  function makeService(chunkSize = 1000) {
    return new IndexerBulkUpsertService({ $transaction: transaction } as never, chunkSize);
  }

  it("flushes every model inside a single transaction", async () => {
    const result = await makeService().flush(makeBatch());

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      transactions: 1,
      payoutEvents: 1,
      fundingEvents: 1,
      maintainers: 1,
      chunks: 4,
    });
  });

  it("skips DB work entirely for an empty batch", async () => {
    const result = await makeService().flush(createEmptyBatch());

    expect(transaction).not.toHaveBeenCalled();
    expect(result.chunks).toBe(0);
  });

  it("chunks large batches to stay under Postgres parameter limits", async () => {
    const transactions = Array.from({ length: 2500 }, (_, i) =>
      makeTransactionRow({ txHash: `tx-${i}`, eventIndex: i }),
    );

    const result = await makeService(1000).flush({ ...createEmptyBatch(), transactions });

    // 2500 rows / 1000 per chunk = 3 statements for transactions alone.
    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(result.transactions).toBe(2500);
    expect(result.chunks).toBe(3);
  });

  it("rejects a malformed batch before opening a transaction", async () => {
    const batch = makeBatch();
    batch.maintainers[0] = { address: "", orgId: "org-1" };

    await expect(makeService().flush(batch)).rejects.toThrow(InvalidIndexerBatchError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("propagates DB errors (transaction rolls back)", async () => {
    executeRaw.mockRejectedValueOnce(new Error("connection reset"));

    await expect(makeService().flush(makeBatch())).rejects.toThrow("connection reset");
  });
});
