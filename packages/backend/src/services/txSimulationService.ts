/**
 * Transaction simulation (dry-run) service.
 * Runs Soroban simulateTransaction without submitting or writing Prisma state.
 * Designed to stay non-blocking under heavy indexer / webhook load.
 */
import { TransactionBuilder, SorobanRpc } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "../config/env.js";
import { getSorobanRpcClient } from "./sorobanRpcService.js";
import { withRetry } from "../utils/retry.js";
import { logger } from "../utils/logger.js";

export type TxSimulationSuccess = {
  success: true;
  minResourceFee?: string;
  cost?: {
    cpuInsns?: string;
    memBytes?: string;
  };
  latestLedger?: number;
};

export type TxSimulationFailure = {
  success: false;
  reason:
    | "malformed_xdr"
    | "invalid_network"
    | "simulation_error"
    | "empty_input";
  message: string;
};

export type TxSimulationResult = TxSimulationSuccess | TxSimulationFailure;

export interface SimulateTransactionInput {
  /** Base64-encoded TransactionEnvelope XDR */
  transactionXdr: string;
}

/**
 * Dry-run a transaction via Soroban RPC simulateTransaction.
 * - Does NOT call sendTransaction
 * - Does NOT write to Prisma
 * - Fully async / non-blocking for the event loop
 */
export async function simulateTransactionDryRun(
  input: SimulateTransactionInput,
): Promise<TxSimulationResult> {
  const { transactionXdr } = input;

  if (typeof transactionXdr !== "string" || transactionXdr.trim().length === 0) {
    return {
      success: false,
      reason: "empty_input",
      message: "transactionXdr is required and must be a non-empty string",
    };
  }

  let transaction;
  try {
    transaction = TransactionBuilder.fromXDR(
      transactionXdr.trim(),
      NETWORK_PASSPHRASE,
    );
  } catch (err) {
    logger.debug({ err }, "[TxSimulation] Failed to parse XDR");
    return {
      success: false,
      reason: "malformed_xdr",
      message: "Invalid or malformed transaction XDR",
    };
  }

  try {
    const rpc = getSorobanRpcClient();
    const simResult = await withRetry(() => rpc.simulateTransaction(transaction));

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return {
        success: false,
        reason: "simulation_error",
        message: simResult.error || "Simulation failed",
      };
    }

    // Successful simulation — extract useful fields without side effects
    const success: TxSimulationSuccess = {
      success: true,
    };

    if ("minResourceFee" in simResult && simResult.minResourceFee != null) {
      success.minResourceFee = String(simResult.minResourceFee);
    }

    if ("cost" in simResult && simResult.cost) {
      const cost = simResult.cost as { cpuInsns?: string | number; memBytes?: string | number };
      const costOut: { cpuInsns?: string; memBytes?: string } = {};
      if (cost.cpuInsns != null) costOut.cpuInsns = String(cost.cpuInsns);
      if (cost.memBytes != null) costOut.memBytes = String(cost.memBytes);
      success.cost = costOut;
    }

    if ("latestLedger" in simResult && simResult.latestLedger != null) {
      success.latestLedger = Number(simResult.latestLedger);
    }

    return success;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown simulation error";
    logger.error({ err }, "[TxSimulation] RPC simulation failed");
    return {
      success: false,
      reason: "simulation_error",
      message,
    };
  }
}

export const txSimulationService = {
  simulateTransactionDryRun,
};
