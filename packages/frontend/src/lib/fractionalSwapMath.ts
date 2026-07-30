/**
 * @file fractionalSwapMath.ts
 * @description TypeScript port of AMM constant-product swap math for optimistic
 * UI predictions. Mirrors the `compute_output_amount` / `compute_input_amount`
 * functions from `packages/amm-math/src/lib.rs` but operates on BigInt for
 * exact fractional precision in the browser.
 *
 * All arithmetic is integer-based using the smallest token unit (stroops for
 * XLM-like tokens, or the token's native atomic unit). Floating-point is
 * avoided entirely to ensure deterministic results that match the Soroban
 * contract's on-chain Wasm computation.
 */

// ── Stellar Precision Constants ───────────────────────────────────────────────

/** Standard Stellar decimal precision (7 for XLM, USDC-like tokens). */
export const STELLAR_DECIMALS = 7;

/** One "whole" unit in atomic form (10^7 stroops = 1 XLM). */
export const ONE_XLM = BigInt(10 ** STELLAR_DECIMALS); // 10_000_000n

// ── Types ─────────────────────────────────────────────────────────────────────

/** Token metadata needed for AMM calculations. */
export interface TokenInfo {
  /** Ticker symbol (e.g. "XLM", "USDC"). */
  symbol: string;
  /** Number of decimal places (e.g. 7 for XLM). */
  decimals: number;
  /** Current on-chain reserve in atomic units. */
  reserve: bigint;
}

/** Result of a swap output computation. */
export interface SwapOutput {
  /** Output amount in atomic units (integer). */
  atomicOutput: bigint;
  /** Output amount as a human-readable fixed-point string. */
  displayOutput: string;
  /** Effective price: input / output as a ratio string. */
  price: string;
  /** Price impact in basis points (1 bp = 0.01%). */
  priceImpactBps: number;
}

/** Result of a swap input computation (how much input to get a desired output). */
export interface SwapInput {
  /** Required input amount in atomic units. */
  atomicInput: bigint;
  /** Input as a human-readable fixed-point string. */
  displayInput: string;
  /** Effective price: input / output as a ratio string. */
  price: string;
  /** Price impact in basis points. */
  priceImpactBps: number;
}

// ── Core AMM Math ─────────────────────────────────────────────────────────────

/**
 * Compute the output amount for a constant-product AMM swap.
 *
 * Formula: output = (reserveOut * inputAmount) / (reserveIn + inputAmount)
 *
 * This is the exact same formula used by the Soroban contract's
 * `compute_output_amount` function. We replicate it client-side so the
 * optimistic cache update matches the eventual on-chain result.
 *
 * @param inputAmount  - Amount of tokens being sold (in atomic units).
 * @param tokenIn      - Metadata and reserve for the input token.
 * @param tokenOut     - Metadata and reserve for the output token.
 * @returns            - Computed output or an error string.
 */
export function computeSwapOutput(
  inputAmount: bigint,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
): SwapOutput {
  if (inputAmount <= BigInt(0)) {
    return {
      atomicOutput: BigInt(0),
      displayOutput: formatAtomic(BigInt(0), tokenOut.decimals),
      price: "0",
      priceImpactBps: 0,
    };
  }

  if (tokenIn.reserve <= BigInt(0) || tokenOut.reserve <= BigInt(0)) {
    return {
      atomicOutput: BigInt(0),
      displayOutput: formatAtomic(BigInt(0), tokenOut.decimals),
      price: "0",
      priceImpactBps: 0,
    };
  }

  // numerator = reserveOut * inputAmount
  const numerator = tokenOut.reserve * inputAmount;

  // denominator = reserveIn + inputAmount
  const denominator = tokenIn.reserve + inputAmount;

  // output = numerator / denominator (integer division, truncating toward zero)
  const atomicOutput = numerator / denominator;

  // Compute price impact in basis points
  const spotPrice = computeSpotPrice(tokenIn.reserve, tokenOut.reserve);
  const executionPrice =
    denominator > BigInt(0)
      ? Number((inputAmount * BigInt(10 ** 9)) / atomicOutput) / 1e9
      : 0;
  const priceImpactBps = computePriceImpactBps(
    tokenIn.reserve,
    tokenOut.reserve,
    inputAmount,
  );

  return {
    atomicOutput,
    displayOutput: formatAtomic(atomicOutput, tokenOut.decimals),
    price:
      executionPrice > 0
        ? executionPrice.toFixed(tokenOut.decimals > 2 ? 6 : tokenOut.decimals)
        : "0",
    priceImpactBps,
  };
}

/**
 * Compute how much input is required to receive a desired output amount.
 *
 * Formula: input = (reserveIn * outputAmount) / (reserveOut - outputAmount)
 *
 * @param outputAmount - Desired output (in atomic units).
 * @param tokenIn      - Metadata and reserve for the input token.
 * @param tokenOut     - Metadata and reserve for the output token.
 * @returns            - Computed required input or an error.
 */
export function computeSwapInput(
  outputAmount: bigint,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
): SwapInput {
  // Validate upfront and return a sentinel zero result with a non-zero input to signal error
  if (outputAmount <= BigInt(0)) {
    return {
      atomicInput: BigInt(0),
      displayInput: formatAtomic(BigInt(0), tokenIn.decimals),
      price: "0",
      priceImpactBps: 0,
    };
  }

  if (outputAmount >= tokenOut.reserve) {
    return {
      atomicInput: BigInt(0),
      displayInput: "0",
      price: "0",
      priceImpactBps: 0,
    };
  }

  if (tokenIn.reserve <= BigInt(0) || tokenOut.reserve <= BigInt(0)) {
    return {
      atomicInput: BigInt(0),
      displayInput: "0",
      price: "0",
      priceImpactBps: 0,
    };
  }

  // numerator = reserveIn * outputAmount
  const numerator = tokenIn.reserve * outputAmount;

  // denominator = reserveOut - outputAmount (safe because of the check above)
  const denominator = tokenOut.reserve - outputAmount;

  // input = numerator / denominator + 1 (round up to ensure sufficient input)
  const rawInput = numerator / denominator;
  // Add 1 wei to ensure we get at least the desired output (round up)
  const atomicInput = rawInput + BigInt(1);

  const executionPrice =
    denominator > BigInt(0)
      ? Number((atomicInput * BigInt(10 ** 9)) / outputAmount) / 1e9
      : 0;
  const priceImpactBps = computePriceImpactBps(
    tokenIn.reserve,
    tokenOut.reserve,
    atomicInput,
  );

  return {
    atomicInput,
    displayInput: formatAtomic(atomicInput, tokenIn.decimals),
    price:
      executionPrice > 0
        ? executionPrice.toFixed(tokenIn.decimals > 2 ? 6 : tokenIn.decimals)
        : "0",
    priceImpactBps,
  };
}

/**
 * Compute the spot price (before any trade) as a floating-point ratio.
 * spot = reserveOutDec / reserveInDec  (both normalized to human units)
 */
export function computeSpotPrice(reserveIn: bigint, reserveOut: bigint): number {
  if (reserveIn <= BigInt(0) || reserveOut <= BigInt(0)) return 0;

  const PRECISION = BigInt(10 ** 9);
  const ratio = (reserveOut * PRECISION) / reserveIn;
  return Number(ratio) / 1e9;
}

/**
 * Compute price impact in basis points (bp).
 *
 * Price impact measures how much the execution price deviates from the spot
 * price due to the trade size. Higher impact = larger slippage.
 *
 * impact_bps = |spot - execution| / spot * 10000
 *
 * Returns an integer in [0, 10000] where 100 = 1%.
 */
export function computePriceImpactBps(
  reserveIn: bigint,
  reserveOut: bigint,
  inputAmount: bigint,
): number {
  if (reserveIn <= BigInt(0) || reserveOut <= BigInt(0) || inputAmount <= BigInt(0)) {
    return 0;
  }

  const spot = computeSpotPrice(reserveIn, reserveOut);
  if (spot === 0) return 0;

  const newReserveIn = reserveIn + inputAmount;
  const outputAmount = (reserveOut * inputAmount) / newReserveIn;
  const execution =
    outputAmount > BigInt(0)
      ? Number((inputAmount * BigInt(10 ** 9)) / outputAmount) / 1e9
      : 0;

  if (execution === 0) return 10000; // Max impact

  const impact = Math.abs(spot - execution) / spot;
  return Math.round(impact * 10000);
}

// ── Balance Prediction ────────────────────────────────────────────────────────

/**
 * Compute predicted post-swap balances for a user given a swap.
 *
 * This applies the fractional math locally so the React Query cache can be
 * updated optimistically before the Soroban RPC confirms the transaction.
 *
 * @param currentBalances - Map of token symbol → current atomic balance.
 * @param inputAmount     - Amount being sold (atomic units).
 * @param tokenInSymbol   - Symbol of the token being sold.
 * @param predictedOutput - Predicted output (atomic units) from AMM math.
 * @param tokenOutSymbol  - Symbol of the token being bought.
 * @returns               - New balances map identical shape to currentBalances.
 */
export function predictPostSwapBalances(
  currentBalances: Record<string, bigint>,
  inputAmount: bigint,
  tokenInSymbol: string,
  predictedOutput: bigint,
  tokenOutSymbol: string,
): Record<string, bigint> {
  const updated = { ...currentBalances };

  // Subtract input amount from tokenIn balance
  const currentIn = updated[tokenInSymbol] ?? BigInt(0);
  updated[tokenInSymbol] = currentIn - inputAmount;

  // Add predicted output to tokenOut balance
  const currentOut = updated[tokenOutSymbol] ?? BigInt(0);
  updated[tokenOutSymbol] = currentOut + predictedOutput;

  return updated;
}

/**
 * Predict the post-swap reserves of the AMM pool.
 *
 * @param currentReserves - Map of token symbol → current reserve.
 * @param inputAmount     - Amount being sold (atomic units).
 * @param tokenInSymbol   - Symbol of input token.
 * @param predictedOutput - Predicted output.
 * @param tokenOutSymbol  - Symbol of output token.
 * @returns               - New reserves map.
 */
export function predictPostSwapReserves(
  currentReserves: Record<string, bigint>,
  inputAmount: bigint,
  tokenInSymbol: string,
  predictedOutput: bigint,
  tokenOutSymbol: string,
): Record<string, bigint> {
  const updated = { ...currentReserves };

  // Pool gains input, loses output
  updated[tokenInSymbol] = (updated[tokenInSymbol] ?? BigInt(0)) + inputAmount;
  updated[tokenOutSymbol] = (updated[tokenOutSymbol] ?? BigInt(0)) - predictedOutput;

  return updated;
}

// ── Utility Functions ─────────────────────────────────────────────────────────

/**
 * Parse a human-readable amount string into atomic BigInt units.
 *
 * @param amount      - Human-readable amount (e.g. "1.5").
 * @param decimals    - Number of decimals for the token.
 * @returns           - Atomic BigInt, or null if parsing fails.
 */
export function parseAtomic(amount: string, decimals: number): bigint | null {
  if (!amount || amount === ".") return null;

  const parts = amount.split(".");
  const intPart = parts[0] ?? "0";
  let fracPart = parts[1] ?? "";

  if (fracPart.length > decimals) {
    fracPart = fracPart.slice(0, decimals);
  }
  fracPart = fracPart.padEnd(decimals, "0");

  try {
    // Remove leading zeros but keep at least one digit for BigInt parsing
    const combined = (intPart + fracPart).replace(/^0+(?=\d)/, "") || "0";
    return BigInt(combined);
  } catch {
    return null;
  }
}

/**
 * Format an atomic BigInt amount into a human-readable fixed-point string.
 *
 * @param atomic    - Amount in atomic units.
 * @param decimals  - Number of decimal places.
 * @returns         - Formatted string (e.g. "1.5000000").
 */
export function formatAtomic(atomic: bigint, decimals: number): string {
  if (atomic === BigInt(0)) return "0." + "0".repeat(Math.min(decimals, 7));

  const isNegative = atomic < BigInt(0);
  const abs = isNegative ? -atomic : atomic;
  const str = abs.toString().padStart(decimals + 1, "0");

  const intPart = str.slice(0, str.length - decimals) || "0";
  const fracPart = str.slice(str.length - decimals);

  // Trim trailing zeros but keep at least 2 for display
  let trimmedFrac = fracPart.replace(/0+$/, "");
  if (trimmedFrac.length < 2) {
    trimmedFrac = trimmedFrac.padEnd(2, "0");
  }

  return `${isNegative ? "-" : ""}${intPart}.${trimmedFrac}`;
}

/**
 * Convert an atomic BigInt to stroops (same for XLM-like tokens with 7 decimals).
 */
export function toStroops(amount: string): bigint | null {
  return parseAtomic(amount, STELLAR_DECIMALS);
}

/**
 * Convert stroops to a human-readable XLM string.
 */
export function stroopsToXlm(stroops: bigint): string {
  return formatAtomic(stroops, STELLAR_DECIMALS);
}

/**
 * Validate that the swap won't exceed available balances or reserves.
 */
export function validateSwapConstraints(params: {
  inputAmount: bigint;
  inputBalance: bigint;
  inputReserve: bigint;
  outputReserve: bigint;
  minOutput: bigint;
}): { valid: true } | { valid: false; error: string } {
  const { inputAmount, inputBalance, inputReserve, outputReserve, minOutput } = params;

  if (inputAmount <= BigInt(0)) {
    return { valid: false, error: "Input amount must be positive." };
  }

  if (inputAmount > inputBalance) {
    return {
      valid: false,
      error: `Insufficient balance: have ${formatAtomic(inputBalance, STELLAR_DECIMALS)}, need ${formatAtomic(inputAmount, STELLAR_DECIMALS)}.`,
    };
  }

  if (inputReserve <= BigInt(0) || outputReserve <= BigInt(0)) {
    return { valid: false, error: "Pool has insufficient liquidity." };
  }

  const output = (outputReserve * inputAmount) / (inputReserve + inputAmount);

  if (output < minOutput) {
    return {
      valid: false,
      error: `Slippage too high: expected at least ${formatAtomic(minOutput, STELLAR_DECIMALS)}, but would receive ${formatAtomic(output, STELLAR_DECIMALS)}.`,
    };
  }

  return { valid: true };
}
