/**
 * @file contractTypes.ts
 * @description Shared TypeScript types that mirror the PayoutRegistry Soroban
 * contract's data structures.
 *
 * Keep this file in sync with `packages/contracts/src/lib.rs` and
 * `packages/contracts/src/token_interface.rs`. When you add a new field
 * to a contract struct, update the corresponding interface here.
 */

// ── On-chain Structures ───────────────────────────────────────────────────────

/** Mirrors the `Organization` contracttype from PayoutRegistry. */
export interface Organization {
  /** Short Symbol identifier (up to 9 chars). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Stellar address of the organization admin. */
  admin: string;
  /** IPFS Content Identifier for extended metadata (Logo, Description). */
  metadataCid?: string | undefined;
}

/** Mirrors the `Maintainer` contracttype from PayoutRegistry. */
export interface Maintainer {
  /** Stellar address of the maintainer. */
  address: string;
  /** Symbol ID of the organization this maintainer belongs to. */
  orgId: string;
}

/**
 * Mirrors the `TokenMetadata` struct from the SAC token interface module.
 *
 * Maps 1:1 with the SEP-41 token standard fields (name, symbol, decimals).
 * This ensures AMM compatibility for any external contract or off-chain
 * client that needs token parameter information.
 */
export interface TokenMetadata {
  /** Human-readable token name (e.g. "Very Prince Token"). */
  name: string;
  /** Token ticker symbol (e.g. "VPT"). */
  symbol: string;
  /** Number of decimal places (e.g. 7 for XLM-like precision). */
  decimals: number;
}

// ── UI / Application Types ────────────────────────────────────────────────────

/** Claimable balance for a maintainer, enriched with XLM conversion. */
export interface MaintainerBalance {
  address: string;
  /** Raw balance in stroops (as bigint to avoid precision loss). */
  stroops: bigint;
  /** Human-readable XLM amount string (e.g. "1.2500000"). */
  xlm: string;
  /** True if this is an optimistic update and hasn't been confirmed yet. */
  isPending?: boolean;
}

/** Payout allocation payload sent to the backend API. */
export interface AllocatePayoutPayload {
  orgId: string;
  maintainerAddress: string;
  /** Amount in stroops as a string. */
  amountStroops: string;
  /** Org admin's secret key — for demo only. */
  signerSecret: string;
}

/** Result returned by the backend /payouts endpoint. */
export interface AllocatePayoutResult {
  success: boolean;
  transactionHash?: string;
  orgId: string;
  maintainer: string;
  amountStroops: string;
}
