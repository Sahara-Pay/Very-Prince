import { TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "../config/env.js";
import { prisma } from "./db.js";
import { stellarService } from "./stellarService.js";
import { lockService } from "./lockService.js";
import { logger } from "../utils/logger.js";
import { SagaStatus } from "@prisma/client";

export class ClaimSagaService {
  private async logTransition(
    sagaId: string,
    fromState: string,
    toState: string,
    event: string,
    payload?: Record<string, any>
  ) {
    logger.info({ sagaId, fromState, toState, event, payload }, `[Saga] Transitioning: ${fromState} -> ${toState} via ${event}`);
    try {
      await prisma.sagaAuditLog.create({
        data: {
          sagaId,
          fromState,
          toState,
          event,
          payload: payload ? JSON.stringify(payload) : null,
        },
      });
    } catch (err) {
      logger.error({ err, sagaId }, "[Saga] Failed to create audit log");
    }
  }

  /**
   * Phase 1: Prepare Claim & Reserve State
   */
  async prepareClaim(orgId: string, maintainerAddress: string): Promise<{ sagaId: string; transactionXdr: string }> {
    const lockKey = `lock:claim:${orgId}:${maintainerAddress}`;
    
    // Concurrency control: Distributed lock to prevent concurrent claims for same maintainer/org
    const lockToken = await lockService.acquireLockWithRetry(lockKey, 10000); // 10s TTL
    if (!lockToken) {
      throw new Error("Concurrent claim request in progress. Please try again.");
    }

    try {
      // 1. Check if there are active sagas (PREPARED or SUBMITTED)
      const activeSagas = await prisma.claimSaga.findMany({
        where: {
          maintainerAddress,
          orgId,
          status: { in: [SagaStatus.PREPARED, SagaStatus.SUBMITTED] }
        }
      });

      for (const saga of activeSagas) {
        if (saga.status === SagaStatus.SUBMITTED) {
          throw new Error("A claim submission is already in progress for this maintainer.");
        }
        
        if (saga.status === SagaStatus.PREPARED) {
          // If the prepared saga is older than 15 minutes, expire it. Otherwise reuse or fail.
          const ageMs = Date.now() - saga.createdAt.getTime();
          if (ageMs > 15 * 60 * 1000) {
            await prisma.claimSaga.update({
              where: { id: saga.id },
              data: { status: SagaStatus.FAILED, errorMessage: "Transaction expired without submission" }
            });
            await this.logTransition(saga.id, SagaStatus.PREPARED, SagaStatus.FAILED, "EXPIRED", { reason: "Timeout after 15m" });
          } else {
            // Supersede the old prepared transaction
            await prisma.claimSaga.update({
              where: { id: saga.id },
              data: { status: SagaStatus.FAILED, errorMessage: "Superseded by a new prepare request" }
            });
            await this.logTransition(saga.id, SagaStatus.PREPARED, SagaStatus.FAILED, "SUPERSEDED", { reason: "New prepare request received" });
          }
        }
      }

      // 2. Read the claimable balance from Soroban
      const balanceStroops = await stellarService.readClaimableBalance(maintainerAddress);
      if (balanceStroops <= 0n) {
        throw new Error("No claimable balance found for this maintainer.");
      }

      // 3. Create unsigned transaction XDR
      const unsignedXdr = await stellarService.createClaimPayoutTransaction(orgId, maintainerAddress);
      
      // Calculate transaction hash (acts as unique saga ID and idempotency key)
      const tx = TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE);
      const txHash = tx.hash().toString("hex");

      // 4. Save saga state (Reservation Phase)
      await prisma.$transaction(async (txPrisma) => {
        await txPrisma.claimSaga.create({
          data: {
            id: txHash,
            orgId,
            maintainerAddress,
            amountStroops: balanceStroops,
            status: SagaStatus.PREPARED,
            unsignedXdr
          }
        });
      });

      await this.logTransition(txHash, "NONE", SagaStatus.PREPARED, "CLAIM_PREPARED", {
        orgId,
        maintainerAddress,
        amountStroops: balanceStroops.toString()
      });

      return { sagaId: txHash, transactionXdr: unsignedXdr };
    } finally {
      await lockService.releaseLock(lockKey, lockToken);
    }
  }

  /**
   * Phase 2: Submit/Commit Claim
   */
  async submitClaim(signedTransactionXdr: string): Promise<{ success: boolean; transactionHash?: string; message?: string }> {
    const tx = TransactionBuilder.fromXDR(signedTransactionXdr, NETWORK_PASSPHRASE);
    const txHash = tx.hash().toString("hex");

    // Look up the prepared saga
    const saga = await prisma.claimSaga.findUnique({
      where: { id: txHash }
    });

    if (!saga) {
      throw new Error("Transaction not prepared by this server.");
    }

    // Strict Idempotency Checks
    if (saga.status === SagaStatus.SUCCESS) {
      logger.info({ txHash }, "[Saga] Returning cached success response (idempotent)");
      return { success: true, transactionHash: saga.txHash || txHash };
    }

    if (saga.status === SagaStatus.SUBMITTED) {
      logger.info({ txHash }, "[Saga] Transaction submission already in progress");
      return { success: true, transactionHash: saga.txHash || txHash, message: "Submission in progress" };
    }

    if (saga.status === SagaStatus.FAILED) {
      return { success: false, message: saga.errorMessage || "Transaction previously failed" };
    }

    // Acquire lock for this specific submission to prevent double submission race conditions
    const submitLockKey = `lock:submit:${txHash}`;
    const lockToken = await lockService.acquireLockWithRetry(submitLockKey, 30000); // 30s TTL
    if (!lockToken) {
      throw new Error("Submission already in progress for this transaction.");
    }

    try {
      // Re-verify status under lock
      const freshSaga = await prisma.claimSaga.findUnique({ where: { id: txHash } });
      if (!freshSaga || freshSaga.status !== SagaStatus.PREPARED) {
        throw new Error(`Invalid transaction status: ${freshSaga?.status}`);
      }

      // Update to SUBMITTED
      await prisma.claimSaga.update({
        where: { id: txHash },
        data: { status: SagaStatus.SUBMITTED, signedXdr: signedTransactionXdr, txHash }
      });
      await this.logTransition(txHash, SagaStatus.PREPARED, SagaStatus.SUBMITTED, "CLAIM_SUBMITTING");

      // Broadcast to network
      let result;
      try {
        result = await stellarService.submitTransaction(signedTransactionXdr);
      } catch (submitError: any) {
        // If it's a definitive execution failure (e.g. simulation error or contract failure), rollback state
        logger.error({ err: submitError, txHash }, "[Saga] Submission returned error");
        
        await prisma.claimSaga.update({
          where: { id: txHash },
          data: { status: SagaStatus.FAILED, errorMessage: submitError.message || "Submission failed" }
        });
        await this.logTransition(txHash, SagaStatus.SUBMITTED, SagaStatus.FAILED, "CLAIM_FAILED", {
          error: submitError.message
        });

        return { success: false, message: submitError.message || "Transaction submission failed" };
      }

      // Successful broadcast
      if (result.success) {
        await prisma.claimSaga.update({
          where: { id: txHash },
          data: { status: SagaStatus.SUCCESS, txHash: result.transactionHash || txHash }
        });
        await this.logTransition(txHash, SagaStatus.SUBMITTED, SagaStatus.SUCCESS, "CLAIM_SUCCESS", {
          txHash: result.transactionHash || txHash
        });
        return { success: true, transactionHash: result.transactionHash || txHash };
      } else {
        // Broadcast failed
        await prisma.claimSaga.update({
          where: { id: txHash },
          data: { status: SagaStatus.FAILED, errorMessage: "Transaction submission not successful" }
        });
        await this.logTransition(txHash, SagaStatus.SUBMITTED, SagaStatus.FAILED, "CLAIM_FAILED", {
          reason: "Not successful"
        });
        return { success: false, message: "Transaction submission not successful" };
      }
    } catch (err: any) {
      // For general network/timeout errors, keep as SUBMITTED so the recovery worker can poll and check status.
      logger.warn({ err, txHash }, "[Saga] Submission encountered timeout or transient error. Left in SUBMITTED state for recovery.");
      await this.logTransition(txHash, SagaStatus.SUBMITTED, SagaStatus.SUBMITTED, "CLAIM_SUBMIT_TIMEOUT", {
        error: err.message
      });
      throw err;
    } finally {
      await lockService.releaseLock(submitLockKey, lockToken);
    }
  }

  /**
   * Automated Rollback/Recovery worker to resolve stalled or timed out transactions.
   */
  async recoverStalledSagas(stalledDurationMs = 60000): Promise<{ processedCount: number; successes: number; failures: number }> {
    const cutoffTime = new Date(Date.now() - stalledDurationMs);

    // Find all sagas stuck in SUBMITTED state
    const stalledSagas = await prisma.claimSaga.findMany({
      where: {
        status: SagaStatus.SUBMITTED,
        updatedAt: { lt: cutoffTime }
      }
    });

    let successes = 0;
    let failures = 0;

    for (const saga of stalledSagas) {
      const txHash = saga.txHash || saga.id;
      logger.info({ sagaId: saga.id, txHash }, "[Saga Recovery] Checking status of stalled transaction");

      try {
        const check = await stellarService.getTransactionStatus(txHash);

        if (check.status === "SUCCESS") {
          await prisma.claimSaga.update({
            where: { id: saga.id },
            data: { status: SagaStatus.SUCCESS }
          });
          await this.logTransition(saga.id, SagaStatus.SUBMITTED, SagaStatus.SUCCESS, "RECOVERY_SUCCESS", {
            reason: "Confirmed successful on-chain status"
          });
          successes++;
        } else if (check.status === "FAILED") {
          await prisma.claimSaga.update({
            where: { id: saga.id },
            data: { status: SagaStatus.FAILED, errorMessage: "On-chain execution failed" }
          });
          await this.logTransition(saga.id, SagaStatus.SUBMITTED, SagaStatus.FAILED, "RECOVERY_FAILED", {
            reason: "Confirmed failed on-chain status"
          });
          failures++;
        } else if (check.status === "NOT_FOUND") {
          // If transaction is not found and has been stalled for a long time (e.g. 5 minutes), assume failed/never broadcasted.
          const isReallyOld = Date.now() - saga.updatedAt.getTime() > 5 * 60 * 1000;
          if (isReallyOld) {
            await prisma.claimSaga.update({
              where: { id: saga.id },
              data: { status: SagaStatus.FAILED, errorMessage: "Transaction expired (not found on-chain after 5 minutes)" }
            });
            await this.logTransition(saga.id, SagaStatus.SUBMITTED, SagaStatus.FAILED, "RECOVERY_EXPIRED_NOT_FOUND", {
              reason: "Transaction not found on-chain and expired"
            });
            failures++;
          }
        }
      } catch (err: any) {
        logger.error({ err, sagaId: saga.id }, "[Saga Recovery] Error checking transaction status");
      }
    }

    return {
      processedCount: stalledSagas.length,
      successes,
      failures
    };
  }
}

export const claimSagaService = new ClaimSagaService();
