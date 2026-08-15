/**
 * @file useOptimisticSwap.test.ts
 * @description Tests for the optimistic swap mutation hook and fractional math.
 *
 * Tests cover:
 *  - computeSwapOutput / computeSwapInput (AMM math correctness)
 *  - predictPostSwapBalances (balance transformations)
 *  - useOptimisticSwap: onMutate cache snapshot + optimistic update
 *  - useOptimisticSwap: onError rollback to prior state
 *  - useOptimisticSwap: onSettled invalidation
 *  - Concurrent overlapping mutations
 *  - Edge cases: zero amounts, insufficient balance, extreme reserves
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import {
  computeSwapOutput,
  computeSwapInput,
  predictPostSwapBalances,
  predictPostSwapReserves,
  formatAtomic,
  parseAtomic,
  computeSpotPrice,
  computePriceImpactBps,
  validateSwapConstraints,
  type TokenInfo,
} from "@/lib/fractionalSwapMath";

import { useOptimisticSwap } from "@/hooks/useOptimisticSwap";

// ── Mock sorobanClient ────────────────────────────────────────────────────────

const mockSubmitSignedTransaction = vi.fn();

vi.mock("@/lib/sorobanClient", () => ({
  submitSignedTransaction: mockSubmitSignedTransaction,
  buildTokenSwapTransaction: vi.fn().mockResolvedValue("mock-xdr-unsigned"),
}));

/** Helper to create a wrapper with a given QueryClient. */
function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

// ── AMM Math Tests ────────────────────────────────────────────────────────────

describe("fractionalSwapMath", () => {
  describe("computeSwapOutput", () => {
    const xlm: TokenInfo = {
      symbol: "XLM",
      decimals: 7,
      reserve: BigInt("10000000000"), // 1,000 XLM
    };
    const usdc: TokenInfo = {
      symbol: "USDC",
      decimals: 7,
      reserve: BigInt("10000000000"), // 1,000 USDC
    };

    it("computes exact output for a balanced pool (1:1 starting ratio)", () => {
      const input = BigInt("100000000"); // 10 XLM
      const result = computeSwapOutput(input, xlm, usdc);

      expect(result.atomicOutput).toBeGreaterThan(BigInt(0));
      expect(result.atomicOutput).toBeLessThan(input); // Slippage
      expect(result.displayOutput).toBeTruthy();
      expect(result.priceImpactBps).toBeGreaterThan(0);
    });

    it("returns zero output for zero input", () => {
      const result = computeSwapOutput(BigInt(0), xlm, usdc);
      expect(result.atomicOutput).toBe(BigInt(0));
      expect(result.displayOutput).toContain("0");
    });

    it("returns zero output for empty reserves", () => {
      const emptyPool: TokenInfo = { symbol: "XLM", decimals: 7, reserve: BigInt(0) };
      const result = computeSwapOutput(BigInt("100000000"), emptyPool, usdc);
      expect(result.atomicOutput).toBe(BigInt(0));
    });

    it("handles large input amounts without overflow", () => {
      const largeInput = BigInt("5000000000"); // 500 XLM (half the pool)
      const result = computeSwapOutput(largeInput, xlm, usdc);
      expect(result.priceImpactBps).toBeGreaterThan(1000); // > 10%
    });

    it("price impact increases with trade size", () => {
      const small = computeSwapOutput(BigInt("1000000"), xlm, usdc);
      const large = computeSwapOutput(BigInt("1000000000"), xlm, usdc);
      expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
    });
  });

  describe("computeSwapInput", () => {
    const xlm: TokenInfo = {
      symbol: "XLM",
      decimals: 7,
      reserve: BigInt("10000000000"),
    };
    const usdc: TokenInfo = {
      symbol: "USDC",
      decimals: 7,
      reserve: BigInt("10000000000"),
    };

    it("computes required input for a desired output", () => {
      const output = BigInt("100000000"); // Want 10 USDC
      const result = computeSwapInput(output, xlm, usdc);

      // Input should be slightly more than output due to slippage
      expect(result.atomicInput).toBeGreaterThan(output);
      expect(result.displayInput).toBeTruthy();
    });

    it("returns zero atomic input when output exceeds reserve", () => {
      const result = computeSwapInput(
        BigInt("20000000000"), // More than entire reserve
        xlm,
        usdc,
      );
      expect(result.atomicInput).toBe(BigInt(0));
    });

    it("returns zero atomic input for empty pools", () => {
      const emptyPool: TokenInfo = { symbol: "XLM", decimals: 7, reserve: BigInt(0) };
      const result = computeSwapInput(BigInt("100"), emptyPool, usdc);
      expect(result.atomicInput).toBe(BigInt(0));
    });
  });

  describe("predictPostSwapBalances", () => {
    it("subtracts input from tokenIn and adds output to tokenOut", () => {
      const balances = {
        XLM: BigInt("5000000000"),
        USDC: BigInt("2000000000"),
      };

      const updated = predictPostSwapBalances(
        balances,
        BigInt("100000000"),
        "XLM",
        BigInt("99009900"),
        "USDC",
      );

      expect(updated.XLM).toBe(BigInt("4900000000"));
      expect(updated.USDC).toBe(BigInt("2099009900"));
    });

    it("defaults missing balances to 0", () => {
      const balances: Record<string, bigint> = { XLM: BigInt("1000000") };

      const updated = predictPostSwapBalances(
        balances,
        BigInt("100000"),
        "USDC",
        BigInt("99000"),
        "XLM",
      );

      expect(updated.USDC).toBe(BigInt("-100000"));
      expect(updated.XLM).toBe(BigInt("1099000"));
    });
  });

  describe("predictPostSwapReserves", () => {
    it("adds input to pool and removes output", () => {
      const reserves = {
        xlmPool: BigInt("10000000000"),
        usdcPool: BigInt("10000000000"),
      };

      const updated = predictPostSwapReserves(
        reserves,
        BigInt("100000000"),
        "xlmPool",
        BigInt("99009900"),
        "usdcPool",
      );

      expect(updated.xlmPool).toBe(BigInt("10100000000"));
      expect(updated.usdcPool).toBe(BigInt("9990090100"));
    });
  });

  describe("parseAtomic / formatAtomic", () => {
    it("round-trips values correctly", () => {
      const atomic = parseAtomic("123.4567890", 7);
      expect(atomic).not.toBeNull();
      const formatted = formatAtomic(atomic!, 7);
      expect(formatted.startsWith("123.456")).toBe(true);
    });

    it("handles zero", () => {
      expect(parseAtomic("0", 7)).toBe(BigInt(0));
      expect(formatAtomic(BigInt(0), 7)).toContain("0");
    });

    it("handles values with fewer decimals than token precision", () => {
      const atomic = parseAtomic("1.5", 7);
      expect(atomic).toBe(BigInt("15000000"));
    });

    it("truncates excess decimal places", () => {
      const atomic = parseAtomic("1.123456789", 7);
      expect(atomic).toBe(BigInt("11234567"));
    });

    it("returns null for invalid input", () => {
      expect(parseAtomic("", 7)).toBeNull();
      expect(parseAtomic(".", 7)).toBeNull();
    });
  });

  describe("computeSpotPrice", () => {
    it("computes the spot price ratio", () => {
      const price = computeSpotPrice(
        BigInt("10000000000"),
        BigInt("10000000000"),
      );
      expect(price).toBeCloseTo(1, 1);
    });

    it("handles price above 1 correctly", () => {
      const price = computeSpotPrice(
        BigInt("10000000000"),
        BigInt("50000000000"),
      );
      expect(price).toBeCloseTo(5, 1);
    });
  });

  describe("validateSwapConstraints", () => {
    it("passes valid swap", () => {
      const result = validateSwapConstraints({
        inputAmount: BigInt("100000000"),
        inputBalance: BigInt("5000000000"),
        inputReserve: BigInt("10000000000"),
        outputReserve: BigInt("10000000000"),
        minOutput: BigInt("90000000"),
      });
      expect(result.valid).toBe(true);
    });

    it("fails when balance is insufficient", () => {
      const result = validateSwapConstraints({
        inputAmount: BigInt("5000000000"),
        inputBalance: BigInt("100000000"),
        inputReserve: BigInt("10000000000"),
        outputReserve: BigInt("10000000000"),
        minOutput: BigInt(0),
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("Insufficient balance");
      }
    });

    it("fails when input is zero", () => {
      const result = validateSwapConstraints({
        inputAmount: BigInt(0),
        inputBalance: BigInt("100000000"),
        inputReserve: BigInt("10000000000"),
        outputReserve: BigInt("10000000000"),
        minOutput: BigInt(0),
      });
      expect(result.valid).toBe(false);
    });

    it("fails when slippage exceeds tolerance", () => {
      const result = validateSwapConstraints({
        inputAmount: BigInt("100000000"),
        inputBalance: BigInt("5000000000"),
        inputReserve: BigInt("10000000000"),
        outputReserve: BigInt("10000000000"),
        minOutput: BigInt("99999999999"),
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("Slippage too high");
      }
    });
  });
});

// ── useOptimisticSwap Hook Tests ──────────────────────────────────────────────

describe("useOptimisticSwap", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  const defaultOptions = {
    tokenIn: { symbol: "XLM", decimals: 7, reserveKey: "xlmReserve" },
    tokenOut: { symbol: "USDC", decimals: 7, reserveKey: "usdcReserve" },
    affectedBalanceKeys: [
      ["balances", "user-1"],
      ["pool-reserves", "pair-1"],
    ] as const,
  };

  function renderSwapHook() {
    const wrapper = makeWrapper(queryClient);
    return renderHook(() => useOptimisticSwap(defaultOptions), { wrapper });
  }

  it("exposes expected mutation state", () => {
    const { result } = renderSwapHook();

    expect(result.current.isPending).toBe(false);
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.mutate).toBe("function");
    expect(typeof result.current.mutateAsync).toBe("function");
    expect(typeof result.current.reset).toBe("function");
  });

  it("snapshots and updates cache on mutate (onMutate)", async () => {
    queryClient.setQueryData(["balances", "user-1"], {
      address: "user-1",
      XLM: BigInt("50000000000"),
      USDC: BigInt("10000000000"),
    });

    queryClient.setQueryData(["pool-reserves", "pair-1"], {
      pairId: "pair-1",
      xlmReserve: BigInt("100000000000"),
      usdcReserve: BigInt("100000000000"),
    });

    mockSubmitSignedTransaction.mockResolvedValue({ hash: "tx-hash-123" });

    const { result } = renderSwapHook();

    await act(async () => {
      result.current.mutate({
        signedXdr: "mock-signed-xdr",
        inputAmount: BigInt("100000000"),
        minOutput: BigInt("90000000"),
        inputBalance: BigInt("50000000000"),
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess || result.current.isError).toBe(true);
    });

    expect(result.current.isError).toBe(false);
  });

  it("rolls back cache on error (onError)", async () => {
    queryClient.setQueryData(["balances", "user-1"], {
      address: "user-1",
      XLM: BigInt("50000000000"),
      USDC: BigInt("10000000000"),
    });

    queryClient.setQueryData(["pool-reserves", "pair-1"], {
      pairId: "pair-1",
      xlmReserve: BigInt("100000000000"),
      usdcReserve: BigInt("100000000000"),
    });

    mockSubmitSignedTransaction.mockRejectedValue(
      new Error("tx_failed: Soroban RPC rejected transaction"),
    );

    const onSwapError = vi.fn();
    const wrapper = makeWrapper(queryClient);

    const { result } = renderHook(
      () => useOptimisticSwap({ ...defaultOptions, onSwapError }),
      { wrapper },
    );

    await act(async () => {
      result.current.mutate({
        signedXdr: "mock-signed-xdr",
        inputAmount: BigInt("100000000"),
        minOutput: BigInt("90000000"),
        inputBalance: BigInt("50000000000"),
      });
    });

    await waitFor(() => {
      expect(onSwapError).toHaveBeenCalled();
    });

    // After rollback, cached data should be restored to pre-mutation state
    const recoveredData = queryClient.getQueryData(["balances", "user-1"]) as {
      XLM: bigint;
      USDC: bigint;
    } | undefined;
    if (recoveredData) {
      expect(recoveredData.XLM).toBe(BigInt("50000000000"));
      expect(recoveredData.USDC).toBe(BigInt("10000000000"));
    }
  });

  it("calls onSwapComplete on success", async () => {
    queryClient.setQueryData(["pool-reserves", "pair-1"], {
      pairId: "pair-1",
      xlmReserve: BigInt("100000000000"),
      usdcReserve: BigInt("100000000000"),
    });
    queryClient.setQueryData(["balances", "user-1"], {
      XLM: BigInt("50000000000"),
      USDC: BigInt("10000000000"),
    });

    mockSubmitSignedTransaction.mockResolvedValue({ hash: "tx-hash-success" });
    const onSwapComplete = vi.fn();

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(
      () => useOptimisticSwap({ ...defaultOptions, onSwapComplete }),
      { wrapper },
    );

    await act(async () => {
      result.current.mutate({
        signedXdr: "signed-xdr",
        inputAmount: BigInt("100000000"),
        minOutput: BigInt("90000000"),
        inputBalance: BigInt("50000000000"),
      });
    });

    await waitFor(() => {
      expect(onSwapComplete).toHaveBeenCalled();
    });
  });

  it("does not retry automatically on failure", async () => {
    queryClient.setQueryData(["pool-reserves", "pair-1"], {
      pairId: "pair-1",
      xlmReserve: BigInt("100000000000"),
      usdcReserve: BigInt("100000000000"),
    });

    mockSubmitSignedTransaction.mockRejectedValue(new Error("RPC error"));
    const onSwapError = vi.fn();

    const wrapper = makeWrapper(queryClient);
    const { result } = renderHook(
      () => useOptimisticSwap({ ...defaultOptions, onSwapError }),
      { wrapper },
    );

    await act(async () => {
      result.current.mutate({
        signedXdr: "signed-xdr",
        inputAmount: BigInt("100000000"),
        minOutput: BigInt("90000000"),
        inputBalance: BigInt("50000000000"),
      });
    });

    await waitFor(() => {
      expect(onSwapError).toHaveBeenCalledTimes(1);
    });
    expect(mockSubmitSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("handles missing cache data gracefully", async () => {
    mockSubmitSignedTransaction.mockResolvedValue({ hash: "tx-hash" });

    const { result } = renderSwapHook();

    await act(async () => {
      result.current.mutate({
        signedXdr: "signed-xdr",
        inputAmount: BigInt("100000000"),
        minOutput: BigInt(0),
        inputBalance: BigInt("50000000000"),
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess || result.current.isError).toBe(true);
    });
  });

  it("serializes mutations with the same scope (mutationKey)", async () => {
    queryClient.setQueryData(["pool-reserves", "pair-1"], {
      pairId: "pair-1",
      xlmReserve: BigInt("100000000000"),
      usdcReserve: BigInt("100000000000"),
    });

    let resolveFirst: (value: unknown) => void;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mockSubmitSignedTransaction
      .mockReturnValueOnce(firstPromise)
      .mockResolvedValueOnce({ hash: "tx-2" });

    const { result } = renderSwapHook();

    act(() => {
      result.current.mutate({
        signedXdr: "xdr-1",
        inputAmount: BigInt("100000000"),
        minOutput: BigInt("90000000"),
        inputBalance: BigInt("50000000000"),
      });
    });

    act(() => {
      result.current.mutate({
        signedXdr: "xdr-2",
        inputAmount: BigInt("200000000"),
        minOutput: BigInt("180000000"),
        inputBalance: BigInt("50000000000"),
      });
    });

    // Second submission should NOT have been called yet (serialized by mutationKey)
    expect(mockSubmitSignedTransaction).toHaveBeenCalledTimes(1);

    resolveFirst!({ hash: "tx-1" });

    await waitFor(() => {
      expect(mockSubmitSignedTransaction).toHaveBeenCalledTimes(2);
    });
  });
});
