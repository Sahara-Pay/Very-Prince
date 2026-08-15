/**
 * @file useOptimisticSwap.ts
 * @description React Query-based optimistic mutation hook for fractional token
 * swaps with automatic cache snapshot/rollback on Soroban RPC failure.
 *
 * ## Architecture
 *
 * 1. **onMutate** – Before the mutation fires:
 *    - Cancels in-flight queries for affected balance/price keys so stale
 *      refetches don't overwrite the optimistic update.
 *    - Snapshots the current React Query cache state for all affected keys.
 *    - Computes the predicted post-swap balances using the exact AMM
 *      constant-product formula (`predictPostSwapBalances`).
 *    - Applies the predicted balances to the cache so the UI updates
 *      instantly at the millisecond the user signs the transaction.
 *
 * 2. **mutationFn** – Submits the signed transaction to the Soroban RPC and
 *    polls for confirmation.
 *
 * 3. **onError** – If the RPC returns `tx_failed` or any error:
 *    - Restores the snapshot captured in `onMutate`, invisibly reverting
 *      the UI to the prior true state.
 *    - Calls the user-provided `onSwapError` callback.
 *
 * 4. **onSettled** – Whether success or failure:
 *    - Invalidates all affected queries so React Query refetches the
 *      canonical on-chain state.
 *    - On success, calls `onSwapComplete` with the tx hash extracted from
 *      the mutation result and the predicted output.
 *
 * ## Concurrency
 *
 * React Query serializes mutations with the same `mutationKey`. Overlapping
 * swaps on the *same* pair wait for the previous one to settle. Use distinct
 * `scope` values for independent trading pairs that can run concurrently.
 */

"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  predictPostSwapBalances,
  computeSwapOutput,
  validateSwapConstraints,
} from "@/lib/fractionalSwapMath";
import { submitSignedTransaction } from "@/lib/sorobanClient";

// ── Types ────────────────────────────────────────────────────────────────────

/** Configuration for an optimistic swap token pair. */
export interface SwapTokenConfig {
  /** Ticker symbol of the token. */
  symbol: string;
  /** Decimal precision of the token. */
  decimals: number;
  /** Key used to look up the token's pool reserve in the cached data. */
  reserveKey: string;
}

/** Input variables for the mutation. */
export interface OptimisticSwapVariables {
  /** The fully signed transaction XDR, obtained from Freighter. */
  signedXdr: string;
  /** Amount of input token being sold (in atomic units). */
  inputAmount: bigint;
  /** Minimum acceptable output amount (atomic units). Protects against slippage. */
  minOutput: bigint;
  /** User's current balance of the input token (atomic units). */
  inputBalance: bigint;
}

/** Context snapshot captured in onMutate for rollback in onError. */
interface OptimisticSwapContext {
  /** Map of serialized query key → previous cache data. */
  previousData: Map<string, unknown>;
  /** Predicted output amount for display purposes. */
  predictedOutput: bigint;
  /** Display string of predicted output. */
  predictedOutputDisplay: string;
}

/** Options for the useOptimisticSwap hook. */
export interface UseOptimisticSwapOptions {
  /** Metadata for the input token. */
  tokenIn: SwapTokenConfig;
  /** Metadata for the output token. */
  tokenOut: SwapTokenConfig;
  /**
   * React Query keys to snapshot and optimistically update.
   * These should include user balance queries and pool reserve queries.
   */
  affectedBalanceKeys: QueryKey[];
  /**
   * Called when the swap is confirmed on-chain.
   * @param txHash - The Soroban transaction hash (may be empty for mocked envs).
   * @param predictedOutput - The predicted output amount (atomic).
   */
  onSwapComplete?: (txHash: string, predictedOutput: bigint) => void;
  /**
   * Called when the swap fails (either RPC rejection or validation error).
   */
  onSwapError?: (error: Error) => void;
  /**
   * Optional mutation scope. Mutations with the same scope are serialized;
   * different scopes can run concurrently. Defaults to a single global queue.
   */
  scope?: string;
  /**
   * Optional transformer to apply the predicted balances to a specific cached
   * query result. Receives the old data, input amount, predicted output, and
   * token symbols. Must return the new data in the same shape.
   *
   * Default: replaces flat `{ [symbol]: bigint }` records via
   * `predictPostSwapBalances`.
   */
  applyBalanceTransform?: (
    oldData: unknown,
    inputAmount: bigint,
    tokenInSymbol: string,
    predictedOutput: bigint,
    tokenOutSymbol: string,
  ) => unknown;
}

/** Return type of the useOptimisticSwap hook. */
export interface UseOptimisticSwapResult {
  /** Execute the optimistic swap mutation. */
  mutate: (variables: OptimisticSwapVariables) => void;
  /** Execute the optimistic swap mutation and return a promise. */
  mutateAsync: (variables: OptimisticSwapVariables) => Promise<unknown>;
  /** Whether a mutation is currently in flight. */
  isPending: boolean;
  /** Whether the last mutation succeeded. */
  isSuccess: boolean;
  /** Whether the last mutation errored. */
  isError: boolean;
  /** The error from the last mutation, if any. */
  error: Error | null;
  /** Reset the mutation state. */
  reset: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Deep clone a value. Handles objects, arrays, and BigInts.
 * Used to snapshot cache data so the onError rollback restores the exact
 * pre-mutation state without aliasing.
 */
function deepSnapshot<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value; // Immutable

  if (Array.isArray(value)) {
    return value.map(deepSnapshot) as unknown as T;
  }

  if (typeof value === "object") {
    const cloned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      cloned[key] = deepSnapshot(val);
    }
    return cloned as unknown as T;
  }

  return value;
}

/**
 * Default balance transformer: expects `oldData` to be a flat record of
 * `{ [tokenSymbol]: bigint }` and applies `predictPostSwapBalances`.
 */
function defaultBalanceTransform(
  oldData: unknown,
  inputAmount: bigint,
  tokenInSymbol: string,
  predictedOutput: bigint,
  tokenOutSymbol: string,
): unknown {
  if (oldData === null || oldData === undefined) return oldData;

  if (typeof oldData === "object" && !Array.isArray(oldData)) {
    // Convert all numeric/bigint/string values to BigInt for the math
    const balances: Record<string, bigint> = {};
    for (const [key, val] of Object.entries(oldData as Record<string, unknown>)) {
      if (typeof val === "bigint") {
        balances[key] = val;
      } else if (typeof val === "string") {
        try {
          balances[key] = BigInt(val);
        } catch {
          // Keep non-BigInt fields as-is below
        }
      } else if (typeof val === "number") {
        balances[key] = BigInt(Math.floor(val));
      }
    }

    // Apply the AMM math to predict new balances
    const predicted = predictPostSwapBalances(
      balances,
      inputAmount,
      tokenInSymbol,
      predictedOutput,
      tokenOutSymbol,
    );

    // Merge back, preserving non-BigInt fields
    const result = { ...(oldData as Record<string, unknown>) };
    for (const [key, val] of Object.entries(predicted)) {
      result[key] = val;
    }
    return result;
  }

  // For arrays or primitives, return as-is (no transform)
  return oldData;
}

/**
 * Extract a transaction hash from a Soroban submission result.
 * Handles both mock objects and real SorobanRpc.GetTransactionResponse.
 */
function extractTxHash(result: unknown): string {
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    // SorobanRpc.GetTransactionResponse has .hash
    if (typeof obj.hash === "string") return obj.hash;
    // Our mock response may have .hash or .transactionHash
    if (typeof obj.transactionHash === "string") return obj.transactionHash;
  }
  return "";
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

/**
 * Extract token reserve values from the React Query cache.
 *
 * Walks the cached data for each affected key and pulls out numeric/bigint
 * values keyed by property name.
 */
function getReservesFromCache(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: QueryKey[],
): Record<string, bigint> {
  const reserves: Record<string, bigint> = {};

  for (const key of keys) {
    const data = queryClient.getQueryData(key);
    if (!data) continue;
    extractBigIntValues(data, reserves);
  }

  return reserves;
}

function extractBigIntValues(
  data: unknown,
  target: Record<string, bigint>,
): void {
  if (data === null || data === undefined) return;

  if (Array.isArray(data)) {
    for (const item of data) extractBigIntValues(item, target);
    return;
  }

  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "bigint") {
        target[key] = value;
      } else if (typeof value === "string") {
        try {
          target[key] = BigInt(value);
        } catch {
          // Not a BigInt string, skip
        }
      } else if (typeof value === "number") {
        target[key] = BigInt(Math.floor(value));
      } else if (typeof value === "object" && value !== null) {
        extractBigIntValues(value, target);
      }
    }
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Optimistic swap mutation hook using React Query's `useMutation`.
 *
 * Provides instant UI feedback when a user swaps tokens by predicting the
 * post-swap state client-side, updating the query cache immediately, and
 * auto-rolling back on Soroban RPC failure.
 */
export function useOptimisticSwap(
  options: UseOptimisticSwapOptions,
): UseOptimisticSwapResult {
  const {
    tokenIn,
    tokenOut,
    affectedBalanceKeys,
    onSwapComplete,
    onSwapError,
    scope = "global-swap-queue",
    applyBalanceTransform = defaultBalanceTransform,
  } = options;

  const queryClient = useQueryClient();

  const mutation = useMutation<unknown, Error, OptimisticSwapVariables, OptimisticSwapContext>({
    mutationKey: ["optimistic-swap", scope],

    // ── mutationFn: submit the signed transaction ────────────────────────
    mutationFn: async ({ signedXdr, inputAmount, minOutput, inputBalance }) => {
      const reserves = getReservesFromCache(queryClient, affectedBalanceKeys);

      const inputReserve = reserves[tokenIn.reserveKey] ?? BigInt(0);
      const outputReserve = reserves[tokenOut.reserveKey] ?? BigInt(0);

      const validation = validateSwapConstraints({
        inputAmount,
        inputBalance,
        inputReserve,
        outputReserve,
        minOutput,
      });

      if (!validation.valid) {
        throw new Error(validation.error);
      }

      return await submitSignedTransaction(signedXdr);
    },

    // ── onMutate: snapshot cache & apply optimistic update ───────────────
    onMutate: async ({ inputAmount }) => {
      // 1. Cancel in-flight queries so they don't overwrite our optimistic update.
      await Promise.all(
        affectedBalanceKeys.map((key) =>
          queryClient.cancelQueries({ queryKey: key }),
        ),
      );

      // 2. Snapshot the current cache state for every affected key.
      const previousData = new Map<string, unknown>();
      for (const key of affectedBalanceKeys) {
        const data = queryClient.getQueryData(key);
        if (data !== undefined) {
          previousData.set(JSON.stringify(key), deepSnapshot(data));
        }
      }

      // 3. Compute the predicted output using the exact AMM constant-product formula.
      const reserves = getReservesFromCache(queryClient, affectedBalanceKeys);
      const inputReserve = reserves[tokenIn.reserveKey] ?? BigInt(0);
      const outputReserve = reserves[tokenOut.reserveKey] ?? BigInt(0);

      const { atomicOutput, displayOutput } = computeSwapOutput(
        inputAmount,
        { symbol: tokenIn.symbol, decimals: tokenIn.decimals, reserve: inputReserve },
        { symbol: tokenOut.symbol, decimals: tokenOut.decimals, reserve: outputReserve },
      );

      // 4. Apply the predicted balances to each affected cache key using the
      //    provided (or default) transformer that invokes predictPostSwapBalances.
      for (const key of affectedBalanceKeys) {
        queryClient.setQueryData(key, (old: unknown) => {
          if (old === undefined) return old;
          return applyBalanceTransform(
            deepSnapshot(old),
            inputAmount,
            tokenIn.symbol,
            atomicOutput,
            tokenOut.symbol,
          );
        });
      }

      // 5. Return context for onError rollback.
      return { previousData, predictedOutput: atomicOutput, predictedOutputDisplay: displayOutput };
    },

    // ── onError: restore snapshot ────────────────────────────────────────
    onError: (error, _variables, context) => {
      if (context?.previousData) {
        for (const [keyStr, data] of context.previousData.entries()) {
          try {
            const key = JSON.parse(keyStr) as QueryKey;
            queryClient.setQueryData(key, data);
          } catch {
            // Malformed key — skip but don't leave the UI in a broken state
          }
        }
      }

      onSwapError?.(error);
    },

    // ── onSettled: invalidate to refetch true state ──────────────────────
    onSettled: (data, error, _variables, context) => {
      // Invalidate all affected queries so React Query refetches canonical state.
      for (const key of affectedBalanceKeys) {
        queryClient.invalidateQueries({ queryKey: key });
      }

      // On success, extract tx hash from the result and notify the caller.
      if (!error && context) {
        const txHash = extractTxHash(data);
        onSwapComplete?.(txHash, context.predictedOutput);
      }
    },

    retry: 0,
  });

  return {
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
    isError: mutation.isError,
    error: mutation.error,
    reset: mutation.reset,
  };
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export { predictPostSwapBalances, predictPostSwapReserves };
