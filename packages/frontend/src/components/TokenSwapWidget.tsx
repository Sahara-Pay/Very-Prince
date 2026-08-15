/**
 * @file TokenSwapWidget.tsx
 * @description Interactive token swap widget demonstrating the optimistic UI
 * reconciler. Users can swap between XLM and USDC with instant balance updates
 * and automatic rollback on RPC failure.
 *
 * ## Features
 * - Real-time price quoting using AMM constant-product math
 * - Optimistic balance updates the millisecond the user signs in Freighter
 * - Graceful rollback if the Soroban RPC rejects the transaction
 * - Slippage tolerance controls
 * - Price impact warnings for large trades
 * - Concurrent swap serialization via React Query mutation keys
 */

"use client";

import React, { useState, useCallback, useMemo } from "react";
import { useOptimisticSwap, type SwapTokenConfig } from "@/hooks/useOptimisticSwap";
import { useUnifiedWallet } from "@/hooks/useUnifiedWallet";
import {
  computeSwapOutput,
  computeSwapInput,
  computeSpotPrice,
  computePriceImpactBps,
  parseAtomic,
  formatAtomic,
  validateSwapConstraints,
  type TokenInfo,
} from "@/lib/fractionalSwapMath";
import { buildTokenSwapTransaction } from "@/lib/sorobanClient";
import { toastTransaction } from "@/lib/transactionToast";
import { GlassPanel } from "@/components/GlassPanel";

// ── Types ────────────────────────────────────────────────────────────────────

interface TokenSwapWidgetProps {
  /** Pool data for the token pair. */
  pool: {
    tokenIn: TokenSwapInfo;
    tokenOut: TokenSwapInfo;
  };
  /** User's current balances. */
  userBalances: Record<string, bigint>;
  /** Wallet address for transaction building. */
  userAddress: string;
}

interface TokenSwapInfo {
  symbol: string;
  decimals: number;
  reserve: bigint;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TokenSwapWidget({ pool, userBalances, userAddress }: TokenSwapWidgetProps) {
  const queryClient = useQueryClient();
  const { isConnected, signTransaction } = useUnifiedWallet();

  // ── Form State ──────────────────────────────────────────────────────────
  const [inputAmount, setInputAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100); // 1% default
  const [isSigning, setIsSigning] = useState(false);
  const [txStep, setTxStep] = useState<"idle" | "building" | "signing" | "submitting" | "confirmed" | "failed">("idle");

  // ── Token Configs for the hook ──────────────────────────────────────────
  const tokenInConfig: SwapTokenConfig = useMemo(
    () => ({
      symbol: pool.tokenIn.symbol,
      decimals: pool.tokenIn.decimals,
      reserveKey: `${pool.tokenIn.symbol.toLowerCase()}Reserve`,
    }),
    [pool.tokenIn.symbol, pool.tokenIn.decimals],
  );

  const tokenOutConfig: SwapTokenConfig = useMemo(
    () => ({
      symbol: pool.tokenOut.symbol,
      decimals: pool.tokenOut.decimals,
      reserveKey: `${pool.tokenOut.symbol.toLowerCase()}Reserve`,
    }),
    [pool.tokenOut.symbol, pool.tokenOut.decimals],
  );

  const affectedKeys = useMemo(
    () => [["balances", userAddress], ["pool-reserves", `${pool.tokenIn.symbol}-${pool.tokenOut.symbol}`]],
    [userAddress, pool.tokenIn.symbol, pool.tokenOut.symbol],
  );

  // ── Optimistic Swap Hook ───────────────────────────────────────────────
  const swap = useOptimisticSwap({
    tokenIn: tokenInConfig,
    tokenOut: tokenOutConfig,
    affectedBalanceKeys: affectedKeys,
    onSwapComplete: (txHash, predictedOutput) => {
      setTxStep("confirmed");
      toastTransaction.success(
        `Swapped ${inputAmount} ${pool.tokenIn.symbol} → ${formatAtomic(predictedOutput, pool.tokenOut.decimals)} ${pool.tokenOut.symbol}`,
        txHash || undefined,
      );
    },
    onSwapError: (error) => {
      setTxStep("failed");
      toastTransaction.error(error, "Swap failed");
    },
  });

  // ── Derived Values ─────────────────────────────────────────────────────
  const parsedInput = inputAmount ? parseAtomic(inputAmount, pool.tokenIn.decimals) : null;

  const quote = useMemo(() => {
    if (!parsedInput || parsedInput <= BigInt(0)) return null;
    return computeSwapOutput(
      parsedInput,
      { symbol: pool.tokenIn.symbol, decimals: pool.tokenIn.decimals, reserve: pool.tokenIn.reserve },
      { symbol: pool.tokenOut.symbol, decimals: pool.tokenOut.decimals, reserve: pool.tokenOut.reserve },
    );
  }, [parsedInput, pool.tokenIn, pool.tokenOut]);

  const spotPrice = useMemo(
    () => computeSpotPrice(pool.tokenIn.reserve, pool.tokenOut.reserve),
    [pool.tokenIn.reserve, pool.tokenOut.reserve],
  );

  const minOutput = useMemo(() => {
    if (!quote || quote.atomicOutput <= BigInt(0)) return BigInt(0);
    // Apply slippage tolerance: output * (10000 - slippageBps) / 10000
    const slippageFactor = BigInt(10000 - slippageBps);
    return (quote.atomicOutput * slippageFactor) / BigInt(10000);
  }, [quote, slippageBps]);

  const validation = useMemo(() => {
    if (!parsedInput || parsedInput <= BigInt(0)) return null;
    const inputBalance = userBalances[pool.tokenIn.symbol] ?? BigInt(0);
    return validateSwapConstraints({
      inputAmount: parsedInput,
      inputBalance,
      inputReserve: pool.tokenIn.reserve,
      outputReserve: pool.tokenOut.reserve,
      minOutput,
    });
  }, [parsedInput, pool.tokenIn, pool.tokenOut, minOutput, userBalances]);

  // ── Price Impact Color ─────────────────────────────────────────────────
  const priceImpactColor = useMemo(() => {
    if (!quote) return "text-white/60";
    if (quote.priceImpactBps <= 50) return "text-green-400"; // < 0.5% — great
    if (quote.priceImpactBps <= 200) return "text-yellow-400"; // < 2% — okay
    if (quote.priceImpactBps <= 500) return "text-orange-400"; // < 5% — warning
    return "text-red-400"; // ≥ 5% — high impact
  }, [quote]);

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleSwap = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!parsedInput || !isConnected || !userAddress || !signTransaction) return;

      setIsSigning(true);
      setTxStep("building");

      try {
        // 1. Build the unsigned swap transaction
        const unsignedXdr = await buildTokenSwapTransaction(
          userAddress,
          pool.tokenIn.symbol,
          pool.tokenOut.symbol,
          parsedInput,
          minOutput,
        );

        // 2. Get user to sign via Freighter
        setTxStep("signing");
        const signedXdr = await signTransaction(unsignedXdr);

        // 3. Fire the optimistic mutation (cache update + RPC submission)
        setTxStep("submitting");
        const inputBalance = userBalances[pool.tokenIn.symbol] ?? BigInt(0);
        swap.mutate({
          signedXdr,
          inputAmount: parsedInput,
          minOutput,
          inputBalance,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Swap cancelled or failed";
        toastTransaction.error(err, "Swap cancelled");
        setTxStep("failed");
      } finally {
        setIsSigning(false);
      }
    },
    [parsedInput, isConnected, userAddress, signTransaction, pool.tokenIn, pool.tokenOut, minOutput, userBalances, swap],
  );

  const handleMaxClick = useCallback(() => {
    const balance = userBalances[pool.tokenIn.symbol];
    if (balance) {
      setInputAmount(formatAtomic(balance, pool.tokenIn.decimals));
    }
  }, [userBalances, pool.tokenIn]);

  const isPending = isSigning || swap.isPending;
  const hasError = validation && !validation.valid;

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <GlassPanel className="relative w-full max-w-md overflow-hidden p-6 shadow-2xl backdrop-blur-xl border-white/10 bg-white/5">
      {/* Background glow */}
      <div className="pointer-events-none absolute -right-20 -top-20 h-40 w-40 rounded-full bg-stellar-purple/20 blur-[60px]" />

      <div className="relative">
        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">Swap Tokens</h3>
          <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-1 text-xs text-white/50">
            <span className="h-2 w-2 rounded-full bg-green-400" />
            Optimistic mode
          </div>
        </div>

        <form onSubmit={handleSwap} className="space-y-4">
          {/* ── Input Token ── */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-all hover:border-white/20">
            <div className="mb-2 flex items-center justify-between">
              <label className="text-xs font-medium uppercase tracking-wider text-white/40">You Pay</label>
              <button
                type="button"
                onClick={handleMaxClick}
                disabled={isPending}
                className="rounded-md bg-stellar-purple/20 px-2 py-0.5 text-xs font-semibold text-stellar-purple transition-colors hover:bg-stellar-purple/30 disabled:opacity-40"
              >
                MAX
              </button>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="number"
                step="any"
                min="0"
                value={inputAmount}
                onChange={(e) => setInputAmount(e.target.value)}
                placeholder="0.00"
                disabled={isPending}
                className="flex-1 bg-transparent font-mono text-xl text-white placeholder-white/20 outline-none disabled:opacity-50"
                required
              />
              <div className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2">
                <span className="text-sm font-bold text-white">{pool.tokenIn.symbol}</span>
              </div>
            </div>
            <p className="mt-1 text-xs text-white/40">
              Balance: {formatAtomic(userBalances[pool.tokenIn.symbol] ?? BigInt(0), pool.tokenIn.decimals)}
            </p>
          </div>

          {/* ── Swap Arrow ── */}
          <div className="flex justify-center">
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/60">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </div>
          </div>

          {/* ── Output Token ── */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition-all hover:border-white/20">
            <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-white/40">You Receive</label>
            <div className="flex items-center gap-3">
              <div className="flex-1 font-mono text-xl text-white">
                {quote ? quote.displayOutput : "0.00"}
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2">
                <span className="text-sm font-bold text-white">{pool.tokenOut.symbol}</span>
              </div>
            </div>
            <p className="mt-1 text-xs text-white/40">
              Balance: {formatAtomic(userBalances[pool.tokenOut.symbol] ?? BigInt(0), pool.tokenOut.decimals)}
            </p>
          </div>

          {/* ── Swap Details ── */}
          {quote && quote.atomicOutput > BigInt(0) && (
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-white/50">Exchange Rate</span>
                <span className="text-white/80">
                  1 {pool.tokenIn.symbol} = {spotPrice.toFixed(6)} {pool.tokenOut.symbol}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-white/50">Price Impact</span>
                <span className={priceImpactColor}>
                  {(quote.priceImpactBps / 100).toFixed(2)}%
                </span>
              </div>
              {minOutput > BigInt(0) && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/50">Minimum Received</span>
                  <span className="text-white/80">{formatAtomic(minOutput, pool.tokenOut.decimals)}</span>
                </div>
              )}
              <div className="flex justify-between text-xs">
                <span className="text-white/50">Slippage Tolerance</span>
                <span className="text-white/80">{(slippageBps / 100).toFixed(2)}%</span>
              </div>
            </div>
          )}

          {/* ── Slippage Slider ── */}
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-white/40">Slippage Tolerance</span>
            </div>
            <div className="flex items-center gap-2">
              {[50, 100, 200, 500].map((bps) => (
                <button
                  key={bps}
                  type="button"
                  onClick={() => setSlippageBps(bps)}
                  disabled={isPending}
                  className={`rounded-lg px-2 py-1 text-xs font-semibold transition-colors ${
                    slippageBps === bps
                      ? "bg-stellar-teal/20 text-stellar-teal"
                      : "bg-white/5 text-white/50 hover:bg-white/10"
                  } disabled:opacity-50`}
                >
                  {(bps / 100).toFixed(2)}%
                </button>
              ))}
            </div>
          </div>

          {/* ── Error Display ── */}
          {hasError && !validation.valid && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
              {validation.error}
            </div>
          )}

          {/* ── Swap Error ── */}
          {swap.isError && swap.error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
              {swap.error.message}
            </div>
          )}

          {/* ── Submit Button ── */}
          <button
            type="submit"
            disabled={
              isPending ||
              !inputAmount ||
              !isConnected ||
              (validation && !validation.valid) ||
              txStep === "confirmed"
            }
            className="w-full rounded-xl bg-gradient-to-r from-stellar-purple to-stellar-teal py-3.5 font-semibold text-white shadow-lg shadow-stellar-purple/20 transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {!isConnected ? (
              "Connect Wallet to Swap"
            ) : isSigning ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                {txStep === "building" ? "Building Transaction..." :
                 txStep === "signing" ? "Waiting for Signature..." :
                 "Processing..."}
              </span>
            ) : swap.isPending ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Submitting to Soroban...
              </span>
            ) : txStep === "confirmed" ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="h-5 w-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Swap Confirmed!
              </span>
            ) : (
              `Swap ${pool.tokenIn.symbol} → ${pool.tokenOut.symbol}`
            )}
          </button>

          {/* ── Info Note ── */}
          <p className="text-center text-[10px] text-white/25">
            Balances update instantly upon wallet signature.
            {quote && quote.priceImpactBps > 500 && (
              <span className="block mt-1 text-orange-400/60">
                ⚠ High price impact — consider a smaller trade.
              </span>
            )}
          </p>
        </form>
      </div>
    </GlassPanel>
  );
}
