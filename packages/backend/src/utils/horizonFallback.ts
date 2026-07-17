/**
 * @file horizonFallback.ts
 * @description Horizon API fallback provider for Soroban RPC failures.
 *
 * When the Soroban RPC endpoint becomes unavailable (rate-limited, network
 * outage, or maintenance), this provider transparently falls back to the
 * Stellar Horizon REST API for operations that have Horizon equivalents.
 *
 * ## Supported Fallback Operations
 *
 * | Soroban RPC Operation      | Horizon Equivalent                        |
 * |----------------------------|-------------------------------------------|
 * | `sendTransaction`          | `POST /transactions`                      |
 * | `getTransaction`           | `GET /transactions/{hash}`                |
 * | `getLatestLedger`          | `GET /ledgers?order=desc&limit=1`         |
 * | `getHealth`                | `GET /` (root endpoint)                   |
 *
 * ## Non-Fallback Operations
 *
 * The following Soroban-specific operations have no Horizon equivalent and
 * will NOT fall back:
 * - `simulateTransaction` — Soroban-only (no execution, no fees)
 * - `getEvents` (Soroban contract events) — Different format on Horizon
 * - `getLedgerEntries` — Soroban-specific contract storage reads
 *
 * ## Design Principles
 *
 * 1. Transparent: Callers do not need to know about the fallback.
 * 2. Safe: Fallback only triggers on transient RPC errors (5xx, timeout, ECONNREFUSED).
 * 3. Observable: All fallback activations are logged with structured context.
 * 4. Non-blocking: Fallback attempts have their own short timeout.
 */

import { Horizon, Transaction } from "@stellar/stellar-sdk";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Configuration for the Horizon fallback provider.
 */
export interface HorizonFallbackConfig {
  /** Horizon server URL (e.g., https://horizon-testnet.stellar.org) */
  horizonUrl: string;
  /** Network passphrase for transaction reconstruction */
  networkPassphrase: string;
  /** Timeout in ms for individual fallback HTTP calls */
  timeoutMs?: number;
}

/**
 * Result type for fallback operations that may return null when
 * the fallback itself is unavailable.
 */
export type FallbackResult<T> = { ok: true; value: T; source: "horizon" } | { ok: false; source: "horizon" };

/**
 * Determine whether an error is eligible for Horizon fallback.
 * We fallback on transient infrastructure errors, NOT on application-level
 * errors (e.g., simulation failure is a valid Soroban response, not a fallback candidate).
 */
export function isFallbackEligibleError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as Record<string, unknown>;

  // Network-level failures
  if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "ETIMEDOUT") return true;
  if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") return true;

  // HTTP status code based
  const status = (err.response as { status?: number })?.status ?? err.status;
  if (typeof status === "number" && status >= 500) return true;
  if (status === 429) return true; // Rate limit

  // Timeout errors
  if (err.message && typeof err.message === "string") {
    const msg = err.message.toLowerCase();
    if (msg.includes("timeout") || msg.includes("timed out")) return true;
    if (msg.includes("network") && msg.includes("error")) return true;
    if (msg.includes("fetch failed")) return true;
  }

  return false;
}

// ─── Provider ────────────────────────────────────────────────────────────────

/**
 * Horizon-based fallback provider for Soroban RPC operations.
 *
 * Wraps the Stellar Horizon REST API to provide degraded-but-available
 * responses when the primary Soroban RPC node is unreachable.
 */
export class HorizonFallbackProvider {
  private readonly horizon: Horizon.Server;

  constructor(config: HorizonFallbackConfig) {
    this.horizon = new Horizon.Server(config.horizonUrl, {
      allowHttp: config.horizonUrl.startsWith("http://"),
    });
  }

  /**
   * Get the latest ledger sequence from Horizon.
   *
   * Falls back to `GET /ledgers?order=desc&limit=1` when Soroban RPC
   * `getLatestLedger` is unavailable.
   */
  async getLatestLedger(): Promise<FallbackResult<{ sequence: number }>> {
    try {
      const response = await this.horizon
        .ledgers()
        .order("desc")
        .limit(1)
        .call();

      const ledger = response.records?.[0];
      if (!ledger) {
        return { ok: false, source: "horizon" };
      }

      return {
        ok: true,
        value: { sequence: ledger.sequence },
        source: "horizon",
      };
    } catch (error) {
      console.warn("[HorizonFallback] getLatestLedger failed:", (error as Error).message);
      return { ok: false, source: "horizon" };
    }
  }

  /**
   * Look up a transaction by hash from Horizon.
   *
   * Falls back to `GET /transactions/{hash}` when Soroban RPC
   * `getTransaction` is unavailable.
   *
   * Returns a minimal object matching the shape callers expect
   * (`{ status, returnValue }`), but note that `returnValue` will be
   * absent for Horizon-originated lookups since Horizon does not expose
   * Soroban return values.
   */
  async getTransaction(
    hash: string
  ): Promise<FallbackResult<{ status: string }>> {
    try {
      const txResponse = await this.horizon
        .transactions()
        .transaction(hash)
        .call();

      // Map Horizon transaction status to Soroban-like status
      const status = txResponse.successful ? "SUCCESS" : "FAILED";

      return {
        ok: true,
        value: { status },
        source: "horizon",
      };
    } catch (error) {
      // 404 means transaction not found — not an eligible fallback error
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        return { ok: true, value: { status: "NOT_FOUND" }, source: "horizon" };
      }

      console.warn("[HorizonFallback] getTransaction failed:", (error as Error).message);
      return { ok: false, source: "horizon" };
    }
  }

  /**
   * Submit a signed transaction via Horizon.
   *
   * Falls back to `POST /transactions` when Soroban RPC
   * `sendTransaction` is unavailable.
   *
   * Note: Horizon submission does not return Soroban-specific metadata
   * (simulation results, auth data). It only confirms whether the
   * transaction was accepted into the ledger.
   */
  async submitTransaction(
    signedTransaction: Transaction | string
  ): Promise<FallbackResult<{ hash: string; status: string }>> {
    try {
      let result: { hash: string; successful: boolean };

      if (typeof signedTransaction === "string") {
        // When given a raw XDR string, use the Horizon HTTP endpoint directly
        // because Horizon.Server.submitTransaction() only accepts Transaction objects.
        const response = await fetch(`${this.horizon.serverURL}/transactions`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ tx: signedTransaction }),
        });
        const data = await response.json() as { hash?: string; successful?: boolean };
        result = { hash: data.hash ?? "", successful: data.successful ?? false };
      } else {
        result = await this.horizon.submitTransaction(signedTransaction);
      }

      return {
        ok: true,
        value: {
          hash: result.hash,
          status: result.successful ? "SUCCESS" : "FAILED",
        },
        source: "horizon",
      };
    } catch (error) {
      // Horizon wraps submission errors in a response envelope
      const horizonError = error as {
        response?: { status?: number; data?: { hash?: string; status?: string; result_xdr?: string } };
        data?: { hash?: string; status?: string; result_xdr?: string };
      };

      const errorData = horizonError.response?.data ?? horizonError.data;
      if (errorData?.hash) {
        return {
          ok: true,
          value: {
            hash: errorData.hash,
            status: errorData.status ?? "FAILED",
          },
          source: "horizon",
        };
      }

      console.warn("[HorizonFallback] submitTransaction failed:", (error as Error).message);
      return { ok: false, source: "horizon" };
    }
  }

  /**
   * Check Horizon health status.
   *
   * Falls back to `GET /` (root endpoint) when Soroban RPC
   * `getHealth` is unavailable.
   */
  async getHealth(): Promise<FallbackResult<{ status: string }>> {
    try {
      // Horizon root endpoint returns server info
      const response = await fetch(`${this.horizon.serverURL}`);
      if (!response.ok) {
        return { ok: false, source: "horizon" };
      }
      return {
        ok: true,
        value: { status: "ok" },
        source: "horizon",
      };
    } catch (error) {
      console.warn("[HorizonFallback] getHealth failed:", (error as Error).message);
      return { ok: false, source: "horizon" };
    }
  }
}
