/**
 * @file api-responses.ts
 * @description Comprehensive TypeScript interfaces for all backend JSON responses.
 *
 * These types ensure compile-time safety for data shapes exchanged between
 * the Fastify backend and Next.js frontend, catching mismatches early.
 */

import type { StellarAddress, OrgId } from "./primitives.js";

// ── Common response primitives ────────────────────────────────────────────────

/** Standard offset pagination metadata returned by paginated endpoints. */
export interface OffsetPaginationMeta {
  totalPages: number;
  currentPage: number;
  totalCount: number;
}

/** Cursor-based pagination metadata. */
export interface CursorPaginationMeta {
  totalCount: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  startCursor?: string;
  endCursor?: string;
}

/** Generic offset paginated response wrapper. */
export interface OffsetPaginatedResponse<T> {
  data: T[];
  meta: OffsetPaginationMeta;
}

/** Generic cursor paginated response wrapper. */
export interface CursorPaginatedResponse<T> {
  data: T[];
  meta: CursorPaginationMeta;
}

/** Generic paginated response wrapper (kept for backwards compatibility). */
export interface PaginatedResponse<T> extends OffsetPaginatedResponse<T> {}

/** Standard success envelope. */
export interface SuccessResponse {
  success: true;
  message?: string;
}

/** Standard error envelope returned by error-handling middleware. */
export interface ErrorResponse {
  success?: false;
  error: string;
  message?: string;
  details?: Record<string, string[]>;
}

/** Rate-limit exceeded response. */
export interface RateLimitResponse {
  statusCode: 429;
  error: "Too Many Requests";
  message: string;
}

// ── Health ────────────────────────────────────────────────────────────────────

/** GET /health */
export interface HealthResponse {
  status: "ok";
  version: string;
  timestamp: string;
  uptime: number;
}

// ── Indexer ───────────────────────────────────────────────────────────────────

/** GET /indexer/status */
export interface IndexerStatusResponse {
  isRunning: boolean;
  lastProcessedLedger?: number;
  consecutiveFailures: number;
  currentBackoffMs: number;
}

/** POST /indexer/sync */
export interface IndexerSyncResponse {
  message: "Sync triggered";
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/** SIWS nonce data returned inside the nonce success envelope. */
export interface NonceData {
  message: string;
  nonce: string;
  expiresAt: number;
}

/** GET /api/v1/auth/nonce — success */
export interface AuthNonceSuccessResponse {
  success: true;
  data: NonceData;
}

/** POST /api/v1/auth/verify — success */
export interface AuthVerifySuccessResponse {
  success: true;
  message: string;
}

/** POST /api/v1/auth/verify — error */
export interface AuthVerifyErrorResponse {
  success: false;
  error: string;
  message: string;
}

/** POST /api/v1/auth/nonce (contract) */
export interface ContractNonceResponse {
  nonce: string;
}

/** POST /contract/auth/verify (contract) */
export interface ContractAuthVerifyResponse {
  success: true;
  message: string;
}

// ── Contract / Organizations ──────────────────────────────────────────────────

/** Organisation as returned by GET /contract/orgs/:orgId. */
export interface OrgResponse {
  id: string;
  name: string;
  admin: string;
}

/** Organisation enriched with on-chain budget. */
export interface OrgWithBudgetResponse {
  id: string;
  name: string;
  admin: string;
  budgetStroops: string;
  budgetXlm: string;
  metadataCid?: string;
}

/** Organisation item within a paginated list (includes publicBudget). */
export interface OrgListItem {
  id: string;
  name: string;
  admin: string;
  publicBudget?: string;
}

/** GET /contract/orgs — paginated organisation list. */
export type OrgListResponse = PaginatedResponse<OrgListItem>;

/** GET /contract/orgs/:orgId/maintainers — paginated maintainer list. */
export interface MaintainersResponse {
  orgId: string;
  maintainers: string[];
  count: number;
  meta: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
  };
}

/** GET /contract/orgs/:orgId/budget */
export interface BudgetResponse {
  orgId: string;
  budgetStroops: string;
  budgetXlm: string;
}

/** POST /contract/orgs and POST /contract/orgs/:orgId/fund — funding result. */
export interface FundResponse {
  success: boolean;
  transactionHash?: string;
  orgId: string;
  donor: string;
  amountStroops: string;
}

/** POST /contract/payouts — payout allocation result. */
export interface PayoutResponse {
  success: boolean;
  transactionHash?: string;
  orgId: string;
  maintainer: string;
  amountStroops: string;
}

/** GET /contract/maintainers/:address/balance */
export interface MaintainerBalanceResponse {
  maintainer: string;
  claimableStroops: string;
  claimableXlm: string;
}

/** POST /contract/claim */
export interface ClaimTransactionResponse {
  transactionXdr: string;
}

/** POST /contract/submit */
export interface SubmitTransactionResponse {
  success: boolean;
  transactionHash?: string;
}

// ── Profile ───────────────────────────────────────────────────────────────────

/** A single payout event in the profile stats. */
export interface ProfilePayoutEvent {
  orgId: string;
  amountStroops: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
}

/** GET /profile/:address/stats */
export interface ProfileStatsResponse {
  address: string;
  totalStroops: string;
  totalXlm: string;
  orgIds: string[];
  payouts: ProfilePayoutEvent[];
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/** GET /stats/global */
export interface GlobalStatsResponse {
  totalOrganizations: number;
  totalFundedStroops: string;
  totalFundedXlm: string;
  totalClaimedStroops: string;
  totalClaimedXlm: string;
  cachedAt: string;
  cacheExpiresAt: string;
}

/** GET /stats/tvl */
export interface TVLResponse {
  tvlUSD: string;
  lastUpdated: string;
}

/** Single entry in the top-maintainers list. */
export interface TopMaintainer {
  address: string;
  totalEarningsXlm: string;
  totalEarningsStroops: string;
  organizationsAssisted: number;
}

/** GET /stats/funds-raised */
export interface FundsRaisedResponse {
  totalFundsRaisedStroops: string;
  totalFundsRaisedXlm: string;
  totalFundingEvents: number;
  distinctOrgsCount: number;
  fromDate?: string;
  toDate?: string;
  cachedAt: string;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

/** Single leaderboard entry. */
export interface LeaderboardEntry {
  rank: number;
  walletAddress: string;
  truncatedAddress: string;
  volumeUSD: number;
}

/** GET /analytics/leaderboard */
export type LeaderboardResponse = LeaderboardEntry[];

// ── Organization (direct contract read) ───────────────────────────────────────

/** GET /org/:id — organization details from contract. */
export interface OrganizationDetailsResponse {
  id: string;
  name: string;
  admin: string;
  budgetStroops: string;
  budgetXlm: string;
}

/** POST /org/upload-metadata */
export interface UploadMetadataResponse {
  cid: string;
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

/** Webhook configuration as returned by GET /org/:orgId/webhook. */
export interface WebhookConfigResponse {
  url: string;
  hasSecret: boolean;
  secret: string;
}

/** Webhook configuration as stored/returned by the service. */
export interface WebhookConfig {
  organizationId: string;
  url: string;
  secret: string;
  deliveries?: WebhookDelivery[];
}

/** A single webhook delivery record. */
export interface WebhookDelivery {
  id: string;
  event: string;
  url: string;
  status: "success" | "failed" | "pending";
  statusCode?: number;
  response?: string;
  error?: string;
  createdAt: string;
  deliveredAt?: string;
}

/** POST /org/:orgId/webhook/test */
export interface WebhookTestResponse {
  success: true;
  message: string;
}

/** GET /org/:orgId/webhook/reveal */
export interface WebhookRevealResponse {
  secret: string | undefined;
}

// ── API Keys ──────────────────────────────────────────────────────────────────

/** API key metadata (without the plaintext key). */
export interface ApiKeyRecord {
  id: string;
  organizationId: string;
  name: string;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /org/:orgId/api-keys — list all API keys. */
export interface ListApiKeysResponse {
  success: true;
  data: ApiKeyRecord[];
}

/** POST /org/:orgId/api-keys — generated API key (plainTextKey shown only once). */
export interface CreateApiKeyResponse {
  success: true;
  data: {
    plainTextKey: string;
    apiKey: ApiKeyRecord;
  };
}

/** DELETE /org/:orgId/api-keys/:id — revoke success. */
export interface RevokeApiKeyResponse {
  success: true;
  message: "API key revoked successfully";
}

/** PUT /org/:orgId/api-keys/:id — update success. */
export interface UpdateApiKeyResponse {
  success: true;
  message: "API key updated successfully";
}

// ── Tokens ────────────────────────────────────────────────────────────────────

/** Risk level for a token contract. */
export type TokenRiskLevel = "LOW" | "HIGH";

/** GET /tokens/verify/:address */
export interface VerifyTokenResponse {
  isVerified: boolean;
  riskLevel: TokenRiskLevel;
}

// ── Export ────────────────────────────────────────────────────────────────────

/** A single export record for payout history. */
export interface ExportRecord {
  date: string;
  orgId: string;
  orgName: string | undefined;
  maintainerAddress: string;
  amountXlm: string;
  amountStroops: string;
  usdValue: string;
  transactionHash: string;
  ledger: number;
  eventType: string;
}

/** Metadata included in JSON export. */
export interface ExportMetadata {
  address: string;
  exportDate: string;
  recordCount: number;
  dateRange: {
    start: string | null;
    end: string | null;
  };
}

/** GET /export/payouts/:address?type=json */
export interface ExportJsonResponse {
  metadata: ExportMetadata;
  data: ExportRecord[];
}

// ── Notifications ─────────────────────────────────────────────────────────────

/** POST /notifications/preferences — success. */
export interface NotificationPreferenceSavedResponse {
  success: true;
  message: "Notification preferences saved.";
}

/** DELETE /notifications/preferences — success. */
export interface NotificationPreferenceDeletedResponse {
  success: true;
  message: "Data purged successfully.";
}

// ── SSE Events ────────────────────────────────────────────────────────────────

/** Payload for the `connected` SSE event. */
export interface SSEConnectedEvent {
  timestamp: number;
}

/** Payload for the `heartbeat` SSE event. */
export interface SSEHeartbeatEvent {
  timestamp: number;
}

/** Payload for `payout_allocated` SSE event. */
export interface SSEPayoutAllocatedEvent {
  orgId: string;
  maintainer: string;
  amountStroops: string;
  amountXlm: string;
  ledger: number;
  txHash: string;
}

/** Payload for `payout_claimed` SSE event. */
export interface SSEPayoutClaimedEvent {
  maintainer: string;
  amountStroops: string;
  amountXlm: string;
  ledger: number;
  txHash: string;
}

/** Payload for `funds_deposited` SSE event. */
export interface SSEFundsDepositedEvent {
  orgId: string;
  from: string;
  amountStroops: string;
  amountXlm: string;
  ledger: number;
  txHash: string;
}

/** Payload for `org_registered` SSE event. */
export interface SSEOrgRegisteredEvent {
  orgId: string;
  ledger: number;
  txHash: string;
}

/** Payload for `maintainer_added` SSE event. */
export interface SSEMaintainerAddedEvent {
  orgId: string;
  maintainer: string;
  ledger: number;
  txHash: string;
}

/** Payload for `protocol_paused` / `protocol_unpaused` SSE events. */
export interface SSEProtocolEvent {
  protocolAdmin: string;
  ledger: number;
  txHash: string;
}

/** Payload for `contract_initialized` SSE event. */
export interface SSEContractInitializedEvent {
  token: string;
  protocolAdmin: string;
  ledger: number;
  txHash: string;
}

/** Payload for `contract_upgraded` SSE event. */
export interface SSEContractUpgradedEvent {
  protocolAdmin: string;
  newWasmHash: string;
  ledger: number;
  txHash: string;
}

// ── tRPC Procedures ───────────────────────────────────────────────────────────

/** tRPC: organization.get response. */
export type TRPCOrganizationResponse = OrganizationDetailsResponse;

/** tRPC: organization.list response. */
export interface TRPCOrganizationListResponse {
  data: OrgListItem[];
  meta: {
    totalCount: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
    startCursor?: string;
    endCursor?: string;
  };
}

/** tRPC: organization.create response. */
export interface TRPCOrganizationCreateResponse {
  success: boolean;
  message: string;
}

/** tRPC: contract.getStatus response. */
export interface TRPCContractStatusResponse {
  status: "ok";
  version: string;
  timestamp: string;
}

/** tRPC: contract.getDetails response. */
export interface TRPCContractDetailsResponse {
  contractId: string;
  network: string;
  lastUpdated: string;
}

/** tRPC: stats.getOverview response. */
export interface TRPCStatsOverviewResponse {
  totalOrganizations: number;
  totalPayouts: number;
  totalVolume: string;
  lastSync: string;
}

// ── Fractional NFT (SVG Rendering) ────────────────────────────────────────────

/** Rarity tier for fractional NFT visual characteristics. */
export type NFTRarityTier =
  | "COMMON"
  | "UNCOMMON"
  | "RARE"
  | "EPIC"
  | "LEGENDARY"
  | "MYTHIC";

/** Visual layer used to compose the final SVG artwork. */
export interface NFTVisualLayer {
  id: string;
  name: string;
  category:
    | "background"
    | "frame"
    | "pattern"
    | "emblem"
    | "overlay"
    | "badge";
  variant: number;
  palette: {
    primary: string;
    secondary: string;
    accent: string;
  };
  opacity: number;
  rotation: number;
  scale: number;
  seed: number;
}

/** A single fractional ownership record inside an NFT. */
export interface FractionalShare {
  owner: StellarAddress;
  /** Numerator of total supply (bigint-safe string). */
  shares: string;
  /** Human-readable ownership percentage (0-100). */
  ownershipPercent: number;
  /** Vesting unlock in seconds since epoch; 0 = liquid. */
  unlockTimestamp: number;
  /** True when the fraction has been listed for sale. */
  isListed: boolean;
  /** Optional floor ask price in stroops, only set when listed. */
  askPriceStroops?: string;
}

/** Core metadata for a fractionalized NFT token. */
export interface FractionalNFTMetadata {
  tokenId: string;
  collectionId: string;
  name: string;
  description: string;
  /** Total supply across all fractions (bigint-safe string). */
  totalSupply: string;
  rarity: NFTRarityTier;
  /** IPFS/Arweave CID of the provenance certificate. */
  provenanceCid?: string;
  /** Organisation that issued the NFT (optional — used for org badges). */
  orgId?: OrgId;
  createdAt: string;
  updatedAt: string;
}

/** Fully rendered fractional NFT — metadata + shares + visual layers. */
export interface FractionalNFT {
  metadata: FractionalNFTMetadata;
  shares: FractionalShare[];
  /** Pre-computed visual layers; the worker derives deterministic SVG from these. */
  layers: NFTVisualLayer[];
  /** Deterministic 32-bit hash: seed = hash(tokenId) so the artwork is stable. */
  seed: number;
}

/** Compact ownership bar slice (derived helper type for UI). */
export interface OwnershipSlice {
  owner: StellarAddress;
  startPercent: number;
  endPercent: number;
  color: string;
  unlockTimestamp: number;
  isListed: boolean;
}

/** Web Worker inbound messages for the SVG fractional NFT renderer. */
export type NftWorkerInboundMessage =
  | {
      type: "RENDER";
      requestId: string;
      nft: FractionalNFT;
      width: number;
      height: number;
      /** When true, also compute a data URL version of the SVG. */
      includeDataUrl?: boolean;
    }
  | {
      type: "COMPUTE_SLICES";
      requestId: string;
      shares: FractionalShare[];
      paletteSeed: number;
    }
  | {
      type: "GENERATE_LAYERS";
      requestId: string;
      tokenId: string;
      rarity: NFTRarityTier;
      seed: number;
    }
  | { type: "CLEANUP" };

/** Render result shape returned by the SVG Web Worker. */
export interface NftWorkerRenderResult {
  type: "RENDER_RESULT";
  requestId: string;
  svgMarkup: string;
  viewBox: string;
  intrinsicSize: { width: number; height: number };
  dataUrl?: string;
  /** Nanosecond rendering time inside the worker. */
  renderTimeNs: number;
}

/** Ownership slices result from the SVG Web Worker. */
export interface NftWorkerSlicesResult {
  type: "SLICES_RESULT";
  requestId: string;
  slices: OwnershipSlice[];
}

/** Layer generation result from the SVG Web Worker. */
export interface NftWorkerLayersResult {
  type: "LAYERS_RESULT";
  requestId: string;
  layers: NFTVisualLayer[];
}

export type NftWorkerOutboundMessage =
  | NftWorkerRenderResult
  | NftWorkerSlicesResult
  | NftWorkerLayersResult
  | { type: "ERROR"; requestId: string; error: string; details?: unknown }
  | { type: "READY" };

/** WCAG AAA accessibility metadata appended to every mounted SVG. */
export interface NFTAccessibilityMeta {
  accessibleTitle: string;
  accessibleDescription: string;
  /** For screen reader users — plain-English breakdown of the fractions. */
  ownershipSummary: string;
  /** Keyboard-navigable focus order of ownership slices. */
  focusOrder: string[];
}
