/**
 * @file chainReorgHandler.ts
 * @description Chain reorganization state rollback handler for the high-throughput indexer.
 *
 * When Stellar network experiences a ledger reorganization (re-org), previously
 * processed ledgers may become orphaned. This service detects re-orgs by
 * monitoring ledger sequence continuity and rolls back state changes made
 * during orphaned ledgers to maintain data consistency.
 *
 * The handler uses a ledger checkpoint system to track processed state and
 * implements non-blocking rollback operations that don't block the Node.js
 * event loop during heavy Web3 webhook ingestion.
 */

import { prisma } from './db.js';
import { logger } from '../utils/logger.js';

/**
 * Maximum number of ledger checkpoints to retain.
 * Older checkpoints are pruned to prevent unbounded storage growth.
 */
const MAX_CHECKPOINTS = 100;

/**
 * How many ledgers can pass before we consider a gap a re-org.
 * Stellar typically finalizes after 3-4 ledgers, but we allow some buffer.
 */
const REORG_DETECTION_THRESHOLD = 10;

interface LedgerCheckpoint {
  ledger: number;
  timestamp: Date;
  /** Snapshot of affected entity IDs for efficient rollback */
  affectedEntities: {
    transactions: string[];
    fundingEvents: string[];
    payoutEvents: string[];
  };
}

interface ReorgDetectionResult {
  isReorg: boolean;
  orphanedLedgers?: number[];
  canonicalFork?: number;
}

export class ChainReorgHandler {
  private checkpoints: LedgerCheckpoint[] = [];
  private lastProcessedLedger = 0;
  private isProcessing = false;

  /**
   * Record a checkpoint before processing a ledger batch.
   * This allows efficient rollback if the ledger becomes orphaned.
   */
  async recordCheckpoint(
    ledger: number,
    affectedEntities: LedgerCheckpoint['affectedEntities'],
  ): Promise<void> {
    const checkpoint: LedgerCheckpoint = {
      ledger,
      timestamp: new Date(),
      affectedEntities,
    };

    this.checkpoints.push(checkpoint);
    this.lastProcessedLedger = ledger;

    // Prune old checkpoints
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      this.checkpoints = this.checkpoints.slice(-MAX_CHECKPOINTS);
    }

    logger.debug({ ledger, checkpointCount: this.checkpoints.length }, 'Recorded ledger checkpoint');
  }

  /**
   * Detect if a chain reorganization has occurred based on the latest
   * ledger sequence from the network.
   */
  async detectReorg(currentLedger: number): Promise<ReorgDetectionResult> {
    if (this.lastProcessedLedger === 0) {
      return { isReorg: false };
    }

    // If the current ledger is behind our last processed, a re-org occurred
    if (currentLedger < this.lastProcessedLedger) {
      const orphanedLedgers: number[] = [];

      // Find all checkpoints that are now orphaned
      for (const checkpoint of this.checkpoints) {
        if (checkpoint.ledger > currentLedger) {
          orphanedLedgers.push(checkpoint.ledger);
        }
      }

      if (orphanedLedgers.length > 0) {
        logger.warn(
          {
            currentLedger,
            lastProcessed: this.lastProcessedLedger,
            orphanedCount: orphanedLedgers.length,
          },
          'Chain reorganization detected',
        );

        return {
          isReorg: true,
          orphanedLedgers,
          canonicalFork: currentLedger,
        };
      }
    }

    // Check for gaps in ledger sequence
    const gap = currentLedger - this.lastProcessedLedger;
    if (gap > REORG_DETECTION_THRESHOLD) {
      logger.warn(
        {
          currentLedger,
          lastProcessed: this.lastProcessedLedger,
          gap,
        },
        'Large ledger gap detected, possible re-org',
      );
    }

    return { isReorg: false };
  }

  /**
   * Rollback state changes for orphaned ledgers.
   * Uses batch operations to minimize database round-trips and
   * maintain non-blocking behavior.
   */
  async rollback(orphanedLedgers: number[]): Promise<void> {
    if (this.isProcessing) {
      logger.warn('Rollback already in progress, skipping');
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      // Collect all affected entity IDs from checkpoints
      const affectedIds = {
        transactions: new Set<string>(),
        fundingEvents: new Set<string>(),
        payoutEvents: new Set<string>(),
      };

      for (const checkpoint of this.checkpoints) {
        if (orphanedLedgers.includes(checkpoint.ledger)) {
          checkpoint.affectedEntities.transactions.forEach((id) => affectedIds.transactions.add(id));
          checkpoint.affectedEntities.fundingEvents.forEach((id) => affectedIds.fundingEvents.add(id));
          checkpoint.affectedEntities.payoutEvents.forEach((id) => affectedIds.payoutEvents.add(id));
        }
      }

      logger.info(
        {
          orphanedLedgers,
          affectedTransactions: affectedIds.transactions.size,
          affectedFundingEvents: affectedIds.fundingEvents.size,
          affectedPayoutEvents: affectedIds.payoutEvents.size,
        },
        'Starting rollback of orphaned ledgers',
      );

      // Perform rollback in a single transaction for atomicity
      await prisma.$transaction(async (tx) => {
        // Delete affected transactions
        if (affectedIds.transactions.size > 0) {
          await tx.transaction.deleteMany({
            where: { id: { in: Array.from(affectedIds.transactions) } },
          });
        }

        // Delete affected funding events
        if (affectedIds.fundingEvents.size > 0) {
          await tx.fundingEvent.deleteMany({
            where: { id: { in: Array.from(affectedIds.fundingEvents) } },
          });
        }

        // Delete affected payout events
        if (affectedIds.payoutEvents.size > 0) {
          await tx.payoutEvent.deleteMany({
            where: { id: { in: Array.from(affectedIds.payoutEvents) } },
          });
        }

        // Update indexer state to the last valid ledger
        const lastValidLedger = Math.min(...orphanedLedgers) - 1;
        await tx.indexerState.upsert({
          where: { id: 'default' },
          update: { lastProcessedLedger: lastValidLedger },
          create: { id: 'default', lastProcessedLedger: lastValidLedger },
        });
      });

      // Remove checkpoints for orphaned ledgers
      this.checkpoints = this.checkpoints.filter(
        (cp) => !orphanedLedgers.includes(cp.ledger),
      );

      this.lastProcessedLedger = Math.min(...orphanedLedgers) - 1;

      const duration = Date.now() - startTime;
      logger.info(
        {
          orphanedLedgers,
          duration,
          remainingCheckpoints: this.checkpoints.length,
        },
        'Rollback completed successfully',
      );
    } catch (error) {
      logger.error(
        { err: error, orphanedLedgers },
        'Rollback failed',
      );
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get the last processed ledger for external consumers.
   */
  getLastProcessedLedger(): number {
    return this.lastProcessedLedger;
  }

  /**
   * Get the current checkpoint count for monitoring.
   */
  getCheckpointCount(): number {
    return this.checkpoints.length;
  }

  /**
   * Clear all checkpoints (e.g., for testing or recovery).
   */
  clearCheckpoints(): void {
    this.checkpoints = [];
    this.lastProcessedLedger = 0;
  }
}

/** Singleton instance for the indexer service */
export const chainReorgHandler = new ChainReorgHandler();
