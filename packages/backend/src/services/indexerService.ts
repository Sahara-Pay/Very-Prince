import * as cron from 'node-cron';
import { CONTRACT_ID, DEPLOYMENT_LEDGER } from '../config/env.js';
import { stellarService } from './stellarService.js';
import { prisma } from './db.js';
import { invalidateOnFundingEvent, invalidateOnTransactionEvent } from './cacheInvalidation.js';
import { emitSSEEvent } from './sse.js';
import { webhookService } from './webhookService.js';
import { txHashFilter } from './txHashFilter.js';
import { publishToStream } from './redisStreams.js';
import { logger } from '../utils/logger.js';
import {
  decodeSorobanEvent,
  parseContractEvent,
  stroopsToXlm,
  type ContractEvent,
  type PayoutAllocatedEvent,
  type OrgFundedEvent,
  type PayoutClaimedEvent,
  type MaintainerAddedEvent,
} from '../utils/xdrDecoder.js';
import {
  createEmptyBatch,
  batchHasRows,
  indexerBulkUpsertService,
  type IndexerBatch,
  type TransactionBatchRow,
} from './indexerBulkUpsert.js';
import { chainReorgHandler } from './chainReorgHandler.js';

/**
 * How many events are decoded/accumulated before yielding to the event loop.
 * Prevents a large RPC page (thousands of events) from starving parallel
 * HTTP / tRPC / WebSocket work during the CPU-bound decode + row-mapping pass.
 */
const EVENT_LOOP_YIELD_INTERVAL = 500;

/** Yields to the event loop so parallel operations are never starved. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class IndexerService {
  private isRunning = false;
  private cronJob: cron.ScheduledTask | null = null;
  private readonly CURSOR_ID = 'default';
  private consecutiveFailures = 0;
  private readonly MAX_BACKOFF_MS = 5 * 60 * 1000;
  private readonly BASE_BACKOFF_MS = 5000;

  private getBackoffDelay(): number {
    const delay = this.BASE_BACKOFF_MS * Math.pow(2, this.consecutiveFailures);
    return Math.min(delay, this.MAX_BACKOFF_MS);
  }

  private resetBackoff(): void {
    this.consecutiveFailures = 0;
  }

  private incrementBackoff(): void {
    this.consecutiveFailures++;
  }

  start(): void {
    if (this.isRunning) {
      logger.info('Indexer is already running');
      return;
    }

    const cronExpression = process.env.INDEXER_CRON_EXPRESSION || '*/5 * * * *';

    logger.info({ cronExpression }, 'Starting indexer');
    logger.info('Syncing Blockchain Data...');

    this.cronJob = cron.schedule(cronExpression, async () => {
      await this.syncWithBackoff();
    }, { timezone: 'UTC' });

    this.isRunning = true;
    logger.info('Indexer started successfully');
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.isRunning = false;
    logger.info('Indexer stopped');
  }

  private async syncWithBackoff(): Promise<void> {
    try {
      await this.syncBlockchainData();
      this.resetBackoff();
    } catch (error) {
      this.incrementBackoff();
      const delay = this.getBackoffDelay();
      logger.error({ err: error, consecutiveFailures: this.consecutiveFailures, retryInSecs: delay / 1000 }, 'Sync failed');
      setTimeout(() => this.syncWithBackoff(), delay);
    }
  }

  private async getCursor(): Promise<number> {
    const state = await prisma.indexerState.findUnique({ where: { id: this.CURSOR_ID } });
    if (!state) {
      logger.info({ deploymentLedger: DEPLOYMENT_LEDGER }, 'No existing cursor found, initializing with DEPLOYMENT_LEDGER');
      return DEPLOYMENT_LEDGER;
    }
    return state.lastProcessedLedger;
  }

  private async syncBlockchainData(): Promise<void> {
    logger.info('Starting blockchain data sync...');

    if (!CONTRACT_ID) {
      logger.warn('No CONTRACT_ID configured, skipping sync');
      return;
    }

    const lastProcessedLedger = await this.getCursor();
    logger.info({ fromLedger: lastProcessedLedger + 1 }, 'Indexing from ledger');

    // ── Chain re-org detection ────────────────────────────────────────────
    // Check the current ledger sequence to detect potential re-orgs before
    // processing new events. This is non-blocking and uses the singleton
    // chainReorgHandler which maintains checkpoint state in memory.
    try {
      const latestLedgerSequence = await stellarService.getLatestLedger();
      if (latestLedgerSequence) {
        const reorgResult = await chainReorgHandler.detectReorg(latestLedgerSequence);
        if (reorgResult.isReorg && reorgResult.orphanedLedgers && reorgResult.orphanedLedgers.length > 0) {
          logger.warn(
            {
              currentLedger: latestLedgerSequence,
              lastProcessed: lastProcessedLedger,
              orphanedLedgers: reorgResult.orphanedLedgers,
            },
            'Chain reorganization detected, rolling back orphaned state',
          );
          await chainReorgHandler.rollback(reorgResult.orphanedLedgers);
          // Re-read cursor after rollback
          const rolledBackCursor = await this.getCursor();
          logger.info({ cursor: rolledBackCursor }, 'Cursor after re-org rollback');
        }
      }
    } catch (err) {
      // Re-org detection is best-effort; don't fail the sync cycle if it errors.
      // The indexer will continue processing and may encounter inconsistencies
      // that trigger a manual investigation.
      logger.debug({ err }, 'Re-org detection skipped (best-effort)');
    }

    const eventsResponse = await stellarService.getEvents(lastProcessedLedger + 1);

    if (eventsResponse.events && eventsResponse.events.length > 0) {
      logger.info({ count: eventsResponse.events.length }, 'Processing new events');

      // ── Pass 1: decode, validate, dedupe, accumulate ──────────────────────
      // All DB writes are accumulated into typed batches instead of being
      // issued per-event, so a finalization burst (thousands of events) is
      // persisted in a handful of bulk upsert statements below.
      const batch: IndexerBatch = createEmptyBatch();
      const claimedEvents: PayoutClaimedEvent[] = [];
      const fundedOrgIds = new Set<string>();
      let processedCount = 0;

      for (let i = 0; i < eventsResponse.events.length; i++) {
        const rawEvent = eventsResponse.events[i];
        if (!rawEvent) continue;
        try {
          const decodedEvent = decodeSorobanEvent(rawEvent);
          const contractEvent = parseContractEvent(decodedEvent);
          if (!contractEvent) {
            logger.warn({ eventName: decodedEvent.eventName }, 'Unknown event type, skipping');
            continue;
          }
          const eventIndex = i;
          const createdAt = new Date(contractEvent.ledgerClosedAt);

          // HLL replay-attack filter (probabilistic; DB-confirmed on positives).
          const { isDuplicate } = await txHashFilter.check(contractEvent.txHash, eventIndex, createdAt);
          if (isDuplicate) {
            logger.debug(
              { txHash: contractEvent.txHash, eventIndex, eventName: contractEvent.eventName },
              '[IndexerService] Duplicate event suppressed by HLL filter',
            );
            continue;
          }

          // Non-blocking side effects: live fan-out + SSE are fire-and-forget so
          // the event loop is never held hostage by Redis or socket backpressure.
          void publishToStream(contractEvent, eventIndex);
          this.emitSSE(contractEvent);

          // Accumulate DB rows (batch upsert happens once per sync).
          this.accumulate(batch, contractEvent, eventIndex, createdAt);
          processedCount++;

          if (contractEvent.eventName === 'PayoutClaimed') {
            claimedEvents.push(contractEvent as PayoutClaimedEvent);
          } else if (contractEvent.eventName === 'OrgFunded') {
            fundedOrgIds.add((contractEvent as OrgFundedEvent).orgId);
          }

          if (i > 0 && i % EVENT_LOOP_YIELD_INTERVAL === 0) {
            await yieldToEventLoop();
          }
        } catch (error) {
          logger.error({ err: error }, 'Error processing event');
        }
      }

      logger.info({ processedCount }, 'Events accumulated, flushing batch');

      // ── Pass 2: single bulk upsert transaction ────────────────────────────
      if (batchHasRows(batch)) {
        await indexerBulkUpsertService.flush(batch);
      }

      // Non-blocking invalidation + webhook dispatch after the durable write,
      // so cache hits and external HTTP never delay the sync.
      for (const orgId of fundedOrgIds) {
        void invalidateOnFundingEvent(orgId);
      }
      if (processedCount > 0) {
        void invalidateOnTransactionEvent();
      }
      void this.dispatchClaimedWebhooks(claimedEvents);

      const latestLedger = Math.max(...eventsResponse.events.map(e => e.ledger));

      await prisma.$transaction(async (tx) => {
        await tx.indexerState.upsert({
          where: { id: this.CURSOR_ID },
          update: { lastProcessedLedger: latestLedger },
          create: { id: this.CURSOR_ID, lastProcessedLedger: latestLedger },
        });
      });

      // Record checkpoint for re-org detection so future rollbacks can
      // efficiently identify and remove affected rows.
      await chainReorgHandler.recordCheckpoint(latestLedger, {
        transactions: batch.transactions.map((r) => r.txHash),
        fundingEvents: batch.fundingEvents.map((r) => r.orgId),
        payoutEvents: batch.payoutEvents.map((r) => r.orgId),
      });

      logger.info({ latestLedger }, 'Successfully processed events up to ledger');
    } else {
      logger.info('No new events found');
    }

    logger.info('Blockchain data sync completed successfully');
  }

  /**
   * Accumulates a decoded contract event into the batch. Pure row-mapping —
   * no I/O — so it is cheap and testable in isolation.
   */
  private accumulate(
    batch: IndexerBatch,
    event: ContractEvent,
    eventIndex: number,
    createdAt: Date,
  ): void {
    switch (event.eventName) {
      case 'PayoutAllocated': {
        const payoutEvent = event as PayoutAllocatedEvent;
        batch.payoutEvents.push({
          orgId: payoutEvent.orgId,
          maintainer: payoutEvent.maintainer,
          amountStroops: BigInt(payoutEvent.amount),
          amountXlm: stroopsToXlm(payoutEvent.amount),
          ledger: payoutEvent.ledger,
          txHash: payoutEvent.txHash,
          createdAt,
        });
        batch.transactions.push(this.toTransactionRow(event, eventIndex, createdAt, payoutEvent.maintainer, payoutEvent.amount));
        break;
      }
      case 'PayoutClaimed': {
        const claimEvent = event as PayoutClaimedEvent;
        batch.transactions.push(this.toTransactionRow(event, eventIndex, createdAt, claimEvent.maintainer, claimEvent.amount));
        break;
      }
      case 'OrgFunded': {
        const fundEvent = event as OrgFundedEvent;
        batch.fundingEvents.push({
          orgId: fundEvent.orgId,
          from: fundEvent.from,
          amountStroops: BigInt(fundEvent.amount),
          amountXlm: stroopsToXlm(fundEvent.amount),
          ledger: fundEvent.ledger,
          txHash: fundEvent.txHash,
          createdAt,
        });
        batch.transactions.push(this.toTransactionRow(event, eventIndex, createdAt, fundEvent.from, fundEvent.amount));
        break;
      }
      case 'MaintainerAdded': {
        const maintainerEvent = event as MaintainerAddedEvent;
        batch.maintainers.push({
          address: maintainerEvent.maintainer,
          orgId: maintainerEvent.orgId,
        });
        batch.transactions.push(this.toTransactionRow(event, eventIndex, createdAt, maintainerEvent.maintainer, '0'));
        break;
      }
      case 'OrgRegistered':
        batch.transactions.push(this.toTransactionRow(event, eventIndex, createdAt, event.orgId, '0'));
        break;
      case 'ProtocolPaused':
      case 'ProtocolUnpaused':
      case 'Initialized':
      case 'ContractUpgraded':
        batch.transactions.push(this.toTransactionRow(event, eventIndex, createdAt, event.protocolAdmin, '0'));
        break;
    }
  }

  /** Maps an event to a `Transaction` row, preserving the previous table contract. */
  private toTransactionRow(
    event: ContractEvent,
    eventIndex: number,
    createdAt: Date,
    walletAddress: string,
    volumeUSD: string,
  ): TransactionBatchRow {
    return {
      txHash: event.txHash,
      eventIndex,
      walletAddress,
      volumeUSD,
      createdAt,
      type: event.eventName,
      ledger: event.ledger,
      rawData: JSON.stringify(event),
    };
  }

  /** Synchronous, cheap SSE fan-out. Kept separate so the hot loop stays readable. */
  private emitSSE(event: ContractEvent): void {
    switch (event.eventName) {
      case 'PayoutAllocated': {
        const payoutEvent = event as PayoutAllocatedEvent;
        emitSSEEvent('payout_allocated', {
          orgId: payoutEvent.orgId,
          maintainer: payoutEvent.maintainer,
          amountStroops: payoutEvent.amount,
          amountXlm: stroopsToXlm(payoutEvent.amount),
          ledger: payoutEvent.ledger,
          txHash: payoutEvent.txHash,
        });
        break;
      }
      case 'PayoutClaimed': {
        const claimEvent = event as PayoutClaimedEvent;
        emitSSEEvent('payout_claimed', {
          maintainer: claimEvent.maintainer,
          amountStroops: claimEvent.amount,
          amountXlm: stroopsToXlm(claimEvent.amount),
          ledger: claimEvent.ledger,
          txHash: claimEvent.txHash,
        });
        break;
      }
      case 'OrgFunded': {
        const fundEvent = event as OrgFundedEvent;
        emitSSEEvent('funds_deposited', {
          orgId: fundEvent.orgId,
          from: fundEvent.from,
          amountStroops: fundEvent.amount,
          amountXlm: stroopsToXlm(fundEvent.amount),
          ledger: fundEvent.ledger,
          txHash: fundEvent.txHash,
        });
        break;
      }
      case 'OrgRegistered':
        emitSSEEvent('org_registered', { orgId: event.orgId, ledger: event.ledger, txHash: event.txHash });
        break;
      case 'MaintainerAdded': {
        const maintainerEvent = event as MaintainerAddedEvent;
        emitSSEEvent('maintainer_added', { orgId: maintainerEvent.orgId, maintainer: maintainerEvent.maintainer, ledger: maintainerEvent.ledger, txHash: maintainerEvent.txHash });
        break;
      }
      case 'ProtocolPaused':
        emitSSEEvent('protocol_paused', { protocolAdmin: event.protocolAdmin, ledger: event.ledger, txHash: event.txHash });
        break;
      case 'ProtocolUnpaused':
        emitSSEEvent('protocol_unpaused', { protocolAdmin: event.protocolAdmin, ledger: event.ledger, txHash: event.txHash });
        break;
      case 'Initialized':
        emitSSEEvent('contract_initialized', { token: event.token, protocolAdmin: event.protocolAdmin, ledger: event.ledger, txHash: event.txHash });
        break;
      case 'ContractUpgraded':
        emitSSEEvent('contract_upgraded', { protocolAdmin: event.protocolAdmin, newWasmHash: event.newWasmHash, ledger: event.ledger, txHash: event.txHash });
        break;
    }
  }

  /**
   * Dispatches payout webhooks for all claimed events in one bulk maintainer
   * lookup instead of one `findUnique` per event. Fire-and-forget: the indexer
   * never blocks on outbound HTTP / queue delivery.
   */
  private async dispatchClaimedWebhooks(claimedEvents: PayoutClaimedEvent[]): Promise<void> {
    if (claimedEvents.length === 0) return;

    const maintainerAddresses = [...new Set(claimedEvents.map((e) => e.maintainer))];

    try {
      const maintainers = await prisma.maintainer.findMany({
        where: { address: { in: maintainerAddresses } },
        select: { address: true, orgId: true },
      });
      const orgByAddress = new Map(maintainers.map((m) => [m.address, m.orgId]));

      for (const claimEvent of claimedEvents) {
        const orgId = orgByAddress.get(claimEvent.maintainer);
        if (!orgId) {
          logger.debug(
            { maintainer: claimEvent.maintainer },
            '[IndexerService] Skipping webhook, maintainer has no org',
          );
          continue;
        }
        // Fire-and-forget so queue/SQS latency never blocks the sync loop.
        void webhookService
          .dispatchPayoutClaimed(orgId, claimEvent.maintainer, claimEvent.amount, claimEvent.txHash, claimEvent.ledger)
          .catch((error) => {
            logger.error(
              { err: error, orgId, maintainer: claimEvent.maintainer },
              '[IndexerService] Webhook dispatch failed',
            );
          });
      }
    } catch (error) {
      logger.error({ err: error }, '[IndexerService] Bulk maintainer lookup failed, skipping webhook dispatch');
    }
  }

  getStatus(): { isRunning: boolean; lastProcessedLedger?: number; consecutiveFailures: number; currentBackoffMs: number } {
    return {
      isRunning: this.isRunning,
      consecutiveFailures: this.consecutiveFailures,
      currentBackoffMs: this.getBackoffDelay(),
    };
  }

  async triggerSync(): Promise<void> {
    logger.info('Manual sync triggered');
    await this.syncWithBackoff();
  }
}

export const indexerService = new IndexerService();
