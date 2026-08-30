/**
 * @file index.ts
 * @description Shared TypeScript interfaces for the very-prince monorepo.
 *
 * Both `@very-prince/backend` and `@very-prince/frontend` import from here
 * to ensure a single source of truth for all Soroban-derived data shapes.
 */

// ── API response types ────────────────────────────────────────────────────────

export * from "./api-responses.js";

// ── Webhook types ─────────────────────────────────────────────────────────────

/** Webhook event data structure for blockchain/indexer payloads */
export type WebhookEventData = Record<string, JsonValue>;

/** JSON value types for webhook data */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Blockchain event metadata from Web3 sources */
export interface BlockchainEventMetadata {
  blockNumber: number;
  blockHash: string;
  timestamp: string;
  network: "mainnet" | "testnet" | "devnet";
}

/** Transaction event metadata for Stellar transactions */
export interface TransactionEventMetadata {
  txHash: string;
  from: string;
  to: string | undefined;
  amount: string;
  assetCode: string | undefined;
  assetIssuer: string | undefined;
  memo: string | undefined;
}

/** Indexer event metadata for custom indexers */
export interface IndexerEventMetadata {
  indexerId: string;
  sequence: number;
  eventType: "block" | "transaction" | "operation" | "ledger_close";
}

/** Webhook ingestion metadata */
export interface WebhookIngestMetadata {
  source: "stellar_horizon" | "soroban_rpc" | "custom_indexer" | "direct_api";
  retryable: boolean | undefined;
  priority: "low" | "normal" | "high" | "critical" | undefined;
}

/** Webhook ingestion request payload */
export interface WebhookIngestRequest {
  organizationId: string;
  event: string;
  data: WebhookEventData;
  metadata?: WebhookIngestMetadata;
}

/** Batch webhook ingestion request */
export interface WebhookBatchIngestRequest {
  webhooks: WebhookIngestRequest[];
  batchId: string | undefined;
  processingMode: "sequential" | "parallel" | "fire_and_forget";
}

/** Webhook ingestion response */
export interface WebhookIngestResponse {
  success: boolean;
  message: string;
  queuedCount: number;
  failedCount: number;
  errors: Array<{
    webhookIndex: number;
    error: string;
  }> | undefined;
  batchId: string | undefined;
  processingTimeMs: number;
}

// ── Stellar / Soroban primitives ──────────────────────────────────────────────

export { type StellarAddress, type OrgId } from "./primitives.js";

// ── Core domain types ─────────────────────────────────────────────────────────

import type { StellarAddress, OrgId } from "./primitives.js";

/** Organisation as stored in the Soroban contract (DataKey::Organization). */
export interface Organization {
  id: OrgId;
  name: string;
  admins: StellarAddress[];
}

/** Maintainer record linking an address to its organisation. */
export interface Maintainer {
  address: StellarAddress;
  orgId: OrgId;
}

/** Claimable payout entry for a maintainer (DataKey::MaintainerBalance). */
export interface MaintainerPayout {
  amount: bigint;
  unlockTimestamp: number;
}

// ── API response shapes ───────────────────────────────────────────────────────

/** Organisation enriched with its on-chain budget, returned by the backend. */
export interface OrganizationWithBudget extends Organization {
  budgetStroops: string;
  budgetXlm: string;
}

/** Offset paginated list of organisations (kept for backwards compatibility). */
export interface PaginatedOrgsResponse {
  data: { id: string; name: string; admin: string; publicBudget?: string }[];
  meta: {
    totalPages: number;
    currentPage: number;
    totalCount: number;
  };
}

/** Cursor paginated list of organisations. */
export interface CursorPaginatedOrgsResponse {
  data: { id: string; name: string; admin: string; publicBudget?: string }[];
  meta: {
    totalCount: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
    startCursor?: string;
    endCursor?: string;
  };
}

// ── Event / analytics types ───────────────────────────────────────────────────

/** A single on-chain payout event emitted by `allocate_payout`. */
export interface PayoutEvent {
  orgId: OrgId;
  amountStroops: bigint;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
}

/** Aggregated payout statistics for a maintainer address. */
export interface ProfileStats {
  address: StellarAddress;
  totalStroops: bigint;
  totalXlm: string;
  orgIds: OrgId[];
  payouts: PayoutEvent[];
}

// ── Stellar SDK wrappers ──────────────────────────────────────────────────────

/** Basic Horizon account information. */
export interface AccountInfo {
  id: string;
  sequence: string;
  balances: Array<{
    balance: string;
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
  }>;
}

/** Result of a Soroban contract call (read or write). */
export interface ContractCallResult {
  success: boolean;
  value: unknown;
  transactionHash?: string;
}

// ─── Error Codes ─────────────────────────────────────────────────────────────

/**
 * Custom error codes returned by the PayoutRegistry contract.
 * These correspond to the PrinceError enum in the Rust contract.
 */
export enum PrinceError {
  AlreadyInitialized = 1,
  EmptyAdminList = 2,
  InvalidThreshold = 3,
  ContractNotInitialized = 4,
  ProtocolPaused = 5,
  InsufficientMultisigAuth = 6,
  OrgAlreadyRegistered = 7,
  OrgNotFound = 8,
  NotAuthorized = 9,
  InvalidAmount = 10,
  BudgetOverflow = 11,
  InsufficientBudget = 12,
  MaxAdminLimitReached = 13,
  AdminAlreadyExists = 14,
  CannotRemoveLastAdmin = 15,
  NotAnAdmin = 16,
  MaintainerAlreadyRegistered = 17,
  MaintainerNotRegistered = 18,
  MaintainerOrgMismatch = 19,
  PayoutOverflow = 20,
  BatchSizeExceeded = 21,
  EmptyBatch = 22,
  NoClaimableBalance = 23,
  PayoutLocked = 24,
  NoPendingAdmin = 25,
  NotPendingAdmin = 26,
}

/**
 * Human-readable messages for PrinceError codes.
 */
export const PrinceErrorMessage: Record<PrinceError, string> = {
  [PrinceError.AlreadyInitialized]: "The contract is already initialized.",
  [PrinceError.EmptyAdminList]: "The admin list cannot be empty.",
  [PrinceError.InvalidThreshold]: "The native protocol admin config is invalid.",
  [PrinceError.ContractNotInitialized]: "The contract has not been initialized yet.",
  [PrinceError.ProtocolPaused]: "The protocol is currently paused for maintenance.",
  [PrinceError.InsufficientMultisigAuth]: "Legacy signer payloads are not accepted for protocol admin actions.",
  [PrinceError.OrgAlreadyRegistered]: "This organization is already registered.",
  [PrinceError.OrgNotFound]: "Organization not found.",
  [PrinceError.NotAuthorized]: "You are not authorized to perform this action.",
  [PrinceError.InvalidAmount]: "The provided amount must be positive.",
  [PrinceError.BudgetOverflow]: "Organization budget overflow.",
  [PrinceError.InsufficientBudget]: "Insufficient organization budget.",
  [PrinceError.MaxAdminLimitReached]: "Maximum number of admins (10) reached.",
  [PrinceError.AdminAlreadyExists]: "This address is already an admin.",
  [PrinceError.CannotRemoveLastAdmin]: "Cannot remove the last administrator.",
  [PrinceError.NotAnAdmin]: "This address is not an administrator.",
  [PrinceError.MaintainerAlreadyRegistered]: "This maintainer is already registered.",
  [PrinceError.MaintainerNotRegistered]: "Maintainer not found in the registry.",
  [PrinceError.MaintainerOrgMismatch]: "Maintainer does not belong to this organization.",
  [PrinceError.PayoutOverflow]: "Payout amount overflow.",
  [PrinceError.BatchSizeExceeded]: "Batch size exceeds the limit of 100 entries.",
  [PrinceError.EmptyBatch]: "The batch payout list cannot be empty.",
  [PrinceError.NoClaimableBalance]: "You have no claimable balance at this time.",
  [PrinceError.PayoutLocked]: "This payout is still in its unlock period.",
  [PrinceError.NoPendingAdmin]: "No pending admin proposal found.",
  [PrinceError.NotPendingAdmin]: "You are not the proposed pending administrator.",
};
