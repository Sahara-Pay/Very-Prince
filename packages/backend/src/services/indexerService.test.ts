/**
 * @file indexerService.test.ts
 * @description Tests for the batched indexer sync flow.
 *
 * Verifies the acceptance criteria of issue #596:
 *   - Events are accumulated and persisted with a SINGLE bulk upsert flush
 *     (instead of ~5N per-event Prisma round-trips).
 *   - Side effects (SSE, stream fan-out, webhook dispatch, cache invalidation)
 *     are non-blocking / fire-and-forget.
 *   - A heavy simulated load (10k events) completes through the batched path
 *     with a handful of DB statements, not tens of thousands.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContractEvent } from "../utils/xdrDecoder.js";

// ─── Mocks (hoisted so vi.mock factories can reference them) ─────────────────

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
  getEvents: vi.fn(),
  txHashCheck: vi.fn(),
  publishToStream: vi.fn(),
  emitSSEEvent: vi.fn(),
  invalidateOnFundingEvent: vi.fn(),
  invalidateOnTransactionEvent: vi.fn(),
  dispatchPayoutClaimed: vi.fn(),
  bulkFlush: vi.fn(),
  maintainerFindMany: vi.fn(),
  indexerStateFindUnique: vi.fn(),
  indexerStateUpsert: vi.fn(),
  cursorTxUpsert: vi.fn(),
  prismaTransaction: vi.fn(),
}));

vi.mock("../config/env.js", () => ({
  CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
  DEPLOYMENT_LEDGER: 100,
}));

vi.mock("./stellarService.js", () => ({
  stellarService: { getEvents: mocks.getEvents },
}));

vi.mock("./db.js", () => ({
  prisma: {
    maintainer: { findMany: mocks.maintainerFindMany },
    indexerState: {
      findUnique: mocks.indexerStateFindUnique,
      upsert: mocks.indexerStateUpsert,
    },
    $transaction: mocks.prismaTransaction,
  },
}));

vi.mock("./cacheInvalidation.js", () => ({
  invalidateOnFundingEvent: mocks.invalidateOnFundingEvent,
  invalidateOnTransactionEvent: mocks.invalidateOnTransactionEvent,
}));

vi.mock("./sse.js", () => ({ emitSSEEvent: mocks.emitSSEEvent }));

vi.mock("./webhookService.js", () => ({
  webhookService: { dispatchPayoutClaimed: mocks.dispatchPayoutClaimed },
}));

vi.mock("./txHashFilter.js", () => ({
  txHashFilter: { check: mocks.txHashCheck },
}));

vi.mock("./redisStreams.js", () => ({
  publishToStream: mocks.publishToStream,
}));

vi.mock("../utils/logger.js", () => ({ logger: mocks.logger }));

// Use the real accumulator helpers + SQL builders, but stub the flush singleton
// so we can assert on the exact batch shape it receives.
vi.mock("./indexerBulkUpsert.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./indexerBulkUpsert.js")>();
  return {
    ...actual,
    indexerBulkUpsertService: { flush: mocks.bulkFlush },
  };
});

// Decode/parse are stubbed to pass synthetic events through; stroopsToXlm stays real.
vi.mock("../utils/xdrDecoder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/xdrDecoder.js")>();
  return {
    ...actual,
    decodeSorobanEvent: vi.fn((raw: ContractEvent) => raw),
    parseContractEvent: vi.fn((decoded: ContractEvent) => decoded),
  };
});

import { IndexerService } from "./indexerService.js";

// ─── Synthetic event fixtures ────────────────────────────────────────────────

function makeEvents(count: number): ContractEvent[] {
  const events: ContractEvent[] = [];
  for (let i = 0; i < count; i++) {
    const base = {
      ledger: 1000 + i,
      ledgerClosedAt: "2026-08-01T00:00:00.000Z",
      txHash: `tx${i}`,
    };
    switch (i % 5) {
      case 0:
        events.push({
          ...base,
          eventName: "PayoutAllocated",
          orgId: "org-1",
          maintainer: `maintainer${i}`,
          amount: "1000",
        });
        break;
      case 1:
        events.push({
          ...base,
          eventName: "PayoutClaimed",
          maintainer: "claimed-maintainer",
          amount: "500",
        });
        break;
      case 2:
        events.push({
          ...base,
          eventName: "OrgFunded",
          orgId: "org-1",
          from: `funder${i}`,
          amount: "2500",
        });
        break;
      case 3:
        events.push({
          ...base,
          eventName: "MaintainerAdded",
          orgId: "org-2",
          maintainer: `new-maintainer-${i}`,
        });
        break;
      default:
        events.push({ ...base, eventName: "OrgRegistered", orgId: `org-${i}` });
    }
  }
  return events;
}

describe("IndexerService batched sync", () => {
  let service: IndexerService;

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.txHashCheck.mockResolvedValue({ isDuplicate: false });
    mocks.dispatchPayoutClaimed.mockResolvedValue(undefined);
    mocks.getEvents.mockResolvedValue({ events: [] });
    mocks.indexerStateFindUnique.mockResolvedValue({ lastProcessedLedger: 999 });
    mocks.prismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ indexerState: { upsert: mocks.indexerStateUpsert } }));
    mocks.maintainerFindMany.mockResolvedValue([]);
    mocks.bulkFlush.mockResolvedValue({
      transactions: 0, payoutEvents: 0, fundingEvents: 0, maintainers: 0, chunks: 0, durationMs: 1,
    });

    service = new IndexerService();
  });

  it("accumulates a batch and flushes exactly once for a full page of events", async () => {
    const events = makeEvents(25);
    mocks.getEvents.mockResolvedValue({ events });

    await service.triggerSync();

    // One bulk flush for the whole page — not 25 × 5 per-event queries.
    expect(mocks.bulkFlush).toHaveBeenCalledTimes(1);
    const batch = mocks.bulkFlush.mock.calls[0]![0];

    // Every event maps to exactly one transaction row.
    expect(batch.transactions).toHaveLength(events.length);
    // 5 payout-allocated, 5 org-funded, 5 maintainer-added events (i % 5).
    expect(batch.payoutEvents).toHaveLength(5);
    expect(batch.fundingEvents).toHaveLength(5);
    expect(batch.maintainers).toHaveLength(5);

    // Transaction rows preserve the dedup key contract (txHash, eventIndex, createdAt).
    const firstTx = batch.transactions[0];
    expect(firstTx).toMatchObject({
      txHash: "tx0",
      eventIndex: 0,
      type: "PayoutAllocated",
      volumeUSD: "1000",
    });
    expect(firstTx.createdAt).toBeInstanceOf(Date);
  });

  it("updates the indexer cursor only after the batch flush succeeds", async () => {
    mocks.getEvents.mockResolvedValue({ events: makeEvents(5) });

    await service.triggerSync();

    // flush happened, then cursor advanced to the latest ledger in the page.
    const flushOrder = mocks.bulkFlush.mock.invocationCallOrder[0];
    const cursorOrder = mocks.indexerStateUpsert.mock.invocationCallOrder[0];
    expect(flushOrder).toBeLessThan(cursorOrder);
    expect(mocks.indexerStateUpsert).toHaveBeenCalledWith({
      where: { id: "default" },
      update: { lastProcessedLedger: 1004 },
      create: { id: "default", lastProcessedLedger: 1004 },
    });
  });

  it("dispatches payout webhooks with one bulk maintainer lookup after flush", async () => {
    mocks.getEvents.mockResolvedValue({ events: makeEvents(25) });
    mocks.maintainerFindMany.mockResolvedValue([
      { address: "claimed-maintainer", orgId: "org-42" },
    ]);

    await service.triggerSync();
    // Dispatch is fire-and-forget; let the async chain settle before asserting.
    await vi.waitFor(() => {
      expect(mocks.dispatchPayoutClaimed).toHaveBeenCalledTimes(5);
    });

    expect(mocks.maintainerFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.maintainerFindMany).toHaveBeenCalledWith({
      where: { address: { in: ["claimed-maintainer"] } },
      select: { address: true, orgId: true },
    });
    expect(mocks.dispatchPayoutClaimed).toHaveBeenCalledWith(
      "org-42", "claimed-maintainer", "500", expect.stringMatching(/^tx/), expect.any(Number),
    );
  });

  it("deduplicates cache invalidation per org and fires it once per sync", async () => {
    mocks.getEvents.mockResolvedValue({ events: makeEvents(25) });

    await service.triggerSync();

    // 5 OrgFunded events, all for org-1 → exactly one invalidation.
    expect(mocks.invalidateOnFundingEvent).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateOnFundingEvent).toHaveBeenCalledWith("org-1");
    expect(mocks.invalidateOnTransactionEvent).toHaveBeenCalledTimes(1);
  });

  it("skips flush + cursor writes entirely when the page has no new events", async () => {
    mocks.getEvents.mockResolvedValue({ events: [] });

    await service.triggerSync();

    expect(mocks.bulkFlush).not.toHaveBeenCalled();
    expect(mocks.indexerStateUpsert).not.toHaveBeenCalled();
  });

  it("suppresses duplicates via the HLL filter before they reach the batch", async () => {
    mocks.getEvents.mockResolvedValue({ events: makeEvents(10) });
    mocks.txHashCheck.mockImplementation(async (txHash: string) => ({
      isDuplicate: txHash === "tx2",
      decidedBy: "hll_positive_db_confirmed",
    }));

    await service.triggerSync();

    expect(mocks.bulkFlush).toHaveBeenCalledTimes(1);
    const batch = mocks.bulkFlush.mock.calls[0]![0];
    expect(batch.transactions).toHaveLength(9); // tx2 dropped
  });

  it("tolerates a malformed event in the page without losing the rest", async () => {
    const events = makeEvents(5);
    events[2] = { ...events[2]!, eventName: "UnknownEvent" } as unknown as ContractEvent;
    mocks.getEvents.mockResolvedValue({ events });

    await service.triggerSync();

    expect(mocks.bulkFlush).toHaveBeenCalledTimes(1);
    expect(mocks.bulkFlush.mock.calls[0]![0].transactions).toHaveLength(4);
  });

  // ── Heavy simulated load (acceptance criteria: optimal under load) ─────────

  it("persists 10,000 simulated events with a single flush (not 50k queries)", async () => {
    const events = makeEvents(10_000);
    mocks.getEvents.mockResolvedValue({ events });
    mocks.maintainerFindMany.mockResolvedValue([
      { address: "claimed-maintainer", orgId: "org-42" },
    ]);

    const startedAt = Date.now();
    await service.triggerSync();
    const durationMs = Date.now() - startedAt;

    // Exactly ONE transaction-scoped flush for the entire page.
    expect(mocks.bulkFlush).toHaveBeenCalledTimes(1);
    const batch = mocks.bulkFlush.mock.calls[0]![0];
    expect(batch.transactions).toHaveLength(10_000);
    expect(batch.payoutEvents).toHaveLength(2_000);
    expect(batch.fundingEvents).toHaveLength(2_000);
    expect(batch.maintainers).toHaveLength(2_000);

    // The accumulation pass stays well inside a reasonable budget for 10k rows.
    expect(durationMs).toBeLessThan(10_000);
  });
});
