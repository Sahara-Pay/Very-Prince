import * as cron from 'node-cron';
import { CONTRACT_ID, DEPLOYMENT_LEDGER } from '../config/env.js';
import { stellarService } from './stellarService.js';
import { prisma } from './db.js';
import { invalidateOnFundingEvent, invalidateOnTransactionEvent } from './cacheInvalidation.js';
import { emitSSEEvent } from './sse.js';
import { webhookService } from './webhookService.js';
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

    const eventsResponse = await stellarService.getEvents(lastProcessedLedger + 1);

    if (eventsResponse.events && eventsResponse.events.length > 0) {
      logger.info({ count: eventsResponse.events.length }, 'Processing new events');

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
          logger.info({ eventName: contractEvent.eventName }, 'Processing event');
          await this.handleContractEvent(contractEvent, eventIndex);
        } catch (error) {
          logger.error({ err: error }, 'Error processing event for SSE');
        }
      }

      const latestLedger = Math.max(...eventsResponse.events.map(e => e.ledger));

      await prisma.$transaction(async (tx) => {
        await tx.indexerState.upsert({
          where: { id: this.CURSOR_ID },
          update: { lastProcessedLedger: latestLedger },
          create: { id: this.CURSOR_ID, lastProcessedLedger: latestLedger },
        });
      });

      logger.info({ latestLedger }, 'Successfully processed events up to ledger');
    } else {
      logger.info('No new events found');
    }

    logger.info('Blockchain data sync completed successfully');
  }

  private async handleContractEvent(event: ContractEvent, eventIndex: number): Promise<void> {
    let walletAddress = '';
    let volumeUSD = BigInt(0);
    const createdAt = new Date(event.ledgerClosedAt);

    switch (event.eventName) {
      case 'PayoutAllocated': {
        const payoutEvent = event as PayoutAllocatedEvent;
        walletAddress = payoutEvent.maintainer;
        volumeUSD = BigInt(payoutEvent.amount);
        emitSSEEvent('payout_allocated', {
          orgId: payoutEvent.orgId,
          maintainer: payoutEvent.maintainer,
          amountStroops: payoutEvent.amount,
          amountXlm: stroopsToXlm(payoutEvent.amount),
          ledger: payoutEvent.ledger,
          txHash: payoutEvent.txHash,
        });
        await prisma.payoutEvent.create({
          data: {
            orgId: payoutEvent.orgId,
            maintainer: payoutEvent.maintainer,
            amountStroops: BigInt(payoutEvent.amount),
            amountXlm: stroopsToXlm(payoutEvent.amount),
            ledger: payoutEvent.ledger,
            txHash: payoutEvent.txHash,
            createdAt,
          }
        });
        break;
      }
      case 'PayoutClaimed': {
        const claimEvent = event as PayoutClaimedEvent;
        walletAddress = claimEvent.maintainer;
        volumeUSD = BigInt(claimEvent.amount);
        emitSSEEvent('payout_claimed', {
          maintainer: claimEvent.maintainer,
          amountStroops: claimEvent.amount,
          amountXlm: stroopsToXlm(claimEvent.amount),
          ledger: claimEvent.ledger,
          txHash: claimEvent.txHash,
        });
        const maintainer = await prisma.maintainer.findUnique({ where: { address: claimEvent.maintainer } });
        if (maintainer) {
          await webhookService.dispatchPayoutClaimed(maintainer.orgId, claimEvent.maintainer, claimEvent.amount, claimEvent.txHash, claimEvent.ledger);
        }
        break;
      }
      case 'OrgFunded': {
        const fundEvent = event as OrgFundedEvent;
        walletAddress = fundEvent.from;
        volumeUSD = BigInt(fundEvent.amount);

        // Emit SSE for real-time UI updates
        emitSSEEvent('funds_deposited', {
          orgId: fundEvent.orgId,
          from: fundEvent.from,
          amountStroops: fundEvent.amount,
          amountXlm: stroopsToXlm(fundEvent.amount),
          ledger: fundEvent.ledger,
          txHash: fundEvent.txHash,
        });

        // Persist to DB for optimized SQL aggregation (avoids N+1 Stellar RPC calls)
        // Uses upsert via createMany skipDuplicates for idempotency on the
        // unique constraint (txHash, orgId, createdAt).
        await prisma.fundingEvent.createMany({
          data: [
            {
              orgId: fundEvent.orgId,
              from: fundEvent.from,
              amountStroops: BigInt(fundEvent.amount),
              amountXlm: stroopsToXlm(fundEvent.amount),
              ledger: fundEvent.ledger,
              txHash: fundEvent.txHash,
              createdAt,
            },
          ],
          skipDuplicates: true,
        });
        void invalidateOnFundingEvent(fundEvent.orgId);
        break;
      }
      case 'OrgRegistered': {
        walletAddress = event.orgId;
        emitSSEEvent('org_registered', { orgId: event.orgId, ledger: event.ledger, txHash: event.txHash });
        break;
      }
      case 'MaintainerAdded': {
        const maintainerEvent = event as MaintainerAddedEvent;
        walletAddress = maintainerEvent.maintainer;
        emitSSEEvent('maintainer_added', { orgId: maintainerEvent.orgId, maintainer: maintainerEvent.maintainer, ledger: maintainerEvent.ledger, txHash: maintainerEvent.txHash });
        await prisma.maintainer.upsert({
          where: { address: maintainerEvent.maintainer },
          update: { orgId: maintainerEvent.orgId },
          create: { address: maintainerEvent.maintainer, orgId: maintainerEvent.orgId }
        });
        break;
      }
      case 'ProtocolPaused': {
        walletAddress = event.protocolAdmin;
        emitSSEEvent('protocol_paused', { protocolAdmin: event.protocolAdmin, ledger: event.ledger, txHash: event.txHash });
        break;
      }
      case 'ProtocolUnpaused': {
        walletAddress = event.protocolAdmin;
        emitSSEEvent('protocol_unpaused', { protocolAdmin: event.protocolAdmin, ledger: event.ledger, txHash: event.txHash });
        break;
      }
      case 'Initialized': {
        walletAddress = event.protocolAdmin;
        emitSSEEvent('contract_initialized', { token: event.token, protocolAdmin: event.protocolAdmin, ledger: event.ledger, txHash: event.txHash });
        break;
      }
      case 'ContractUpgraded': {
        walletAddress = event.protocolAdmin;
        emitSSEEvent('contract_upgraded', { protocolAdmin: event.protocolAdmin, newWasmHash: event.newWasmHash, ledger: event.ledger, txHash: event.txHash });
        break;
      }
    }

    await prisma.transaction.upsert({
      where: { txHash_eventIndex_createdAt: { txHash: event.txHash, eventIndex, createdAt } },
      update: {},
      create: { txHash: event.txHash, eventIndex, walletAddress, volumeUSD: volumeUSD.toString(), type: event.eventName, ledger: event.ledger, rawData: JSON.stringify(event), createdAt },
    });
    void invalidateOnTransactionEvent();
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
