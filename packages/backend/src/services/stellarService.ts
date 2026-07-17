/**
 * @file stellarService.ts
 * @description Core Stellar service layer.
 *
 * This service is the single integration point between the application and the
 * Stellar network. It wraps both:
 *
 *   - `@stellar/stellar-sdk`           — Horizon REST API & Soroban RPC (`SorobanRpc` namespace)
 *
 * All network interaction flows through this class. Controllers should import
 * from this service rather than instantiating SDK objects directly.
 *
 * ## Extending This Service
 *
 * To add a new contract interaction (e.g., a new function you've added to
 * PayoutRegistry):
 *
 *  1. Add a new method below following the pattern of `readClaimableBalance`.
 *  2. Build the `xdr.ScVal` argument list using `nativeToScVal` or the
 *     Soroban SDK helpers.
 *  3. Use `simulateTransaction` for read-only calls and `sendTransaction`
 *     for state-changing calls.
 *
 * ## Architecture & Data Flow
 *
 * 1. Request: Controller calls a service method (e.g., `readClaimableBalance`).
 * 2. Preparation: Service builds an XDR envelope for the contract call.
 * 3. Simulation: Service sends the XDR to Soroban RPC for simulation.
 * 4. Response: RPC returns the simulation result (return value + footprint).
 * 5. Parsing: Service decodes the XDR return value into native JS types.
 *
 * ## Horizon Fallback
 *
 * When the Soroban RPC endpoint is unavailable (rate-limited, network outage,
 * or maintenance), this service transparently falls back to the Stellar Horizon
 * REST API for operations that have Horizon equivalents:
 *
 *   - `sendTransaction` → `POST /transactions` via Horizon
 *   - `getTransaction`  → `GET /transactions/{hash}` via Horizon
 *   - `getLatestLedger` → `GET /ledgers?order=desc&limit=1` via Horizon
 *
 * Soroban-specific operations (simulateTransaction, getEvents for contract
 * events) have no Horizon equivalent and will fail gracefully with the
 * original RPC error.
 *
 * ## Error Handling Policy
 *
 * - Transient Errors: Handled via `_callWithRetry` (exponential backoff).
 * - RPC Failures: Automatically falls back to Horizon when eligible.
 * - Contract Errors: Simulation failures are logged and thrown as standard Errors.
 * - Network Errors: Horizon/RPC timeouts are caught and retried up to 3 times.
 *
 * ## Scaling Considerations
 *
 * - Concurrent Calls: The service handles multiple parallel requests via async/await.
 * - Rate Limiting: Respects Stellar Testnet/Mainnet rate limits using the retry wrapper.
 * - Caching: Higher-level controllers (like `statsController`) implement caching
 *   to minimize redundant RPC calls.
 *
 * ## Security Best Practices
 *
 * - No Private Keys: This service should ideally only handle public keys and
 *   signed XDRs. Secret keys should be managed by the caller or a secure KMS.
 * - Input Validation: All addresses and identifiers should be validated before
 *   being used in XDR construction.
 */

import {
  Horizon,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  SorobanRpc,
} from "@stellar/stellar-sdk";
import {
  CONTRACT_ID,
  HORIZON_URL,
  HORIZON_FALLBACK_URL,
  NETWORK_PASSPHRASE,
} from "../config/env.js";
import { withRetry } from "../utils/retry.js";
import {
  HorizonFallbackProvider,
  isFallbackEligibleError,
  type FallbackResult,
} from "../utils/horizonFallback.js";
import { decodeI128ToBigInt, stroopsToXlm } from "../utils/xdrDecoder.js";
import { getSorobanRpcClient } from "./sorobanRpcService.js";
import type { AccountInfo, ContractCallResult, PayoutEvent, ProfileStats } from "@very-prince/types";

// ─── Types ───────────────────────────────────────────────────────────────────

export type { AccountInfo, ContractCallResult, PayoutEvent, ProfileStats };
// ─── Service ─────────────────────────────────────────────────────────────────

export class StellarService {
  /** Horizon server instance for REST API calls. */
  private readonly horizon: Horizon.Server;

  /** Soroban RPC server for smart contract interactions. */
  private readonly rpcServer: SorobanRpc.Server;

  /** Horizon fallback provider for when Soroban RPC is unavailable. */
  private readonly fallback: HorizonFallbackProvider | null;

  constructor() {
    this.horizon = new Horizon.Server(HORIZON_URL, {
      allowHttp: HORIZON_URL.startsWith("http://"), // allow HTTP for local dev only
    });

// Use the dedicated Soroban RPC service for client initialization
    this.rpcServer = getSorobanRpcClient();

    // Initialize fallback provider if a separate fallback URL is configured.
    // When HORIZON_FALLBACK_URL is not set, the fallback is disabled and the
    // service relies solely on the primary Soroban RPC endpoint.
    if (HORIZON_FALLBACK_URL) {
      this.fallback = new HorizonFallbackProvider({
        horizonUrl: HORIZON_FALLBACK_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
      });
    } else {
      this.fallback = null;
    }
  }
  /**
   * Helper to wrap calls with retry and backoff logic.
   * 
   * This method implements a standard exponential backoff strategy for handling
   * rate limits (429 Too Many Requests) and transient network errors from both
   * Horizon and Soroban RPC.
   * 
   * Implementation Details:
   * - Uses `withRetry` utility from `../utils/retry.js`
   * - Logs warnings on initial retries to assist in debugging
   * - Logs a critical error if the maximum retry limit (default 3) is exceeded
   * - Ensures that the application remains resilient under heavy network load
   * 
   * @param fn — The async function to be executed with retry logic.
   * @returns The result of the function call if successful.
   */
  private async _callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      onRetry: (_, attempt) => {
        if (attempt >= 3) {
          console.error(`[CRITICAL] High-priority: Rate limit backoff exceeded 3 times! (Attempt ${attempt})`);
        } else {
          console.warn(`[Stellar] Rate limited. Retrying... (Attempt ${attempt})`);
        }
      }
    });
  }

  /**
   * Execute an RPC operation with automatic Horizon fallback.
   *
   * Tries the primary Soroban RPC call first. If it fails with a
   * transient error (5xx, timeout, ECONNREFUSED) and a Horizon fallback
   * provider is configured, transparently falls back to Horizon.
   *
   * @param rpcFn - The Soroban RPC operation to execute.
   * @param fallbackFn - The Horizon-based fallback operation.
   * @returns The result from whichever source succeeded.
   * @throws The last error if both RPC and fallback fail.
   */
  private async _callWithFallback<T>(
    rpcFn: () => Promise<T>,
    fallbackFn: (fallback: HorizonFallbackProvider) => Promise<FallbackResult<T>>
  ): Promise<T> {
    try {
      return await this._callWithRetry(rpcFn);
    } catch (rpcError) {
      if (!this.fallback || !isFallbackEligibleError(rpcError)) {
        throw rpcError;
      }

      console.warn(
        `[Stellar] Soroban RPC failed, attempting Horizon fallback: ${(rpcError as Error).message}`
      );

      const fallbackResult = await fallbackFn(this.fallback);
      if (fallbackResult.ok) {
        console.info("[Stellar] Horizon fallback succeeded");
        return fallbackResult.value;
      }

      // Both sources failed — throw the original RPC error
      throw rpcError;
    }
  }

  // ── Horizon (Account) Operations ─────────────────────────────────────────

  /**
   * Fetch basic account information from Horizon.
   *
   * This is a standard Horizon operation that retrieves the current state of a
   * Stellar account, including its sequence number, balances, and subentry count.
   * It is used primarily to prepare transactions by fetching the current sequence
   * number of the source account.
   * 
   * Technical Notes:
   * - Communicates with the Horizon server via REST API.
   * - Automatically retries on rate limits or transient errors.
   * - The returned sequence number is used for the next transaction submission.
   *
   * @param publicKey — The Stellar public key (G...) of the account.
   * @throws If the account does not exist on the network (404 Not Found).
   */
  async getAccountInfo(publicKey: string): Promise<AccountInfo> {
    const account = await this._callWithRetry(() => this.horizon.loadAccount(publicKey));
    return {
      id: account.id,
      sequence: account.sequenceNumber(),
      balances: account.balances,
    };
  }

  // ── Soroban Read Operations ───────────────────────────────────────────────

  /**
   * Read the claimable balance for a maintainer address by simulating a
   * `get_claimable_balance` contract invocation (no transaction fee, read-only).
   *
   * @param maintainerAddress — The Stellar address of the maintainer.
   * @returns The claimable balance in stroops, or `0` if none.
   */
  async readClaimableBalance(maintainerAddress: string): Promise<bigint> {
    const result = await this._simulateContractCall("get_claimable_balance", [
      nativeToScVal(maintainerAddress, { type: "address" }),
    ]);
    return BigInt(scValToNative(result as xdr.ScVal) as number);
  }

  /**
   * Read full information about a registered organization.
   *
   * @param orgId — The Symbol ID of the organization (e.g. "stellar").
   */
  async readOrganization(orgId: string): Promise<Record<string, unknown>> {
    const result = await this._simulateContractCall("get_org", [
      nativeToScVal(orgId, { type: "symbol" }),
    ]);
    // scValToNative converts the contracttype struct to a JS object.
    return scValToNative(result as xdr.ScVal) as Record<string, unknown>;
  }

  /**
   * Read the list of all registered organization IDs.
   * This method fetches all `org_registered` events from the contract.
   */
  async readAllOrganizations(): Promise<string[]> {
    const startLedger = parseInt(process.env["PROFILE_START_LEDGER"] ?? "1", 10);
    
    // topic[0] = Symbol("VeryPrince"), topic[1] = Symbol("org_registered")
    const topic0 = nativeToScVal("VeryPrince", { type: "symbol" }).toXDR("base64");
    const topic1 = nativeToScVal("org_registered", { type: "symbol" }).toXDR("base64");

    const eventsResponse = await this.rpcServer.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          topics: [[topic0, topic1]],
        },
      ],
      limit: 1000,
    });

    const orgIds = new Set<string>();
    for (const event of eventsResponse.events ?? []) {
      try {
        // topic[2] = orgId Symbol
        if (event.topic[2]) {
          const orgId = scValToNative(event.topic[2]) as string;
          orgIds.add(orgId);
        }
      } catch {
        // Skip malformed events
      }
    }

    return [...orgIds];
  }

  /**
   * Read the list of maintainer addresses for an organization.
   *
   * @param orgId — The Symbol ID of the organization.
   * @returns An array of Stellar public key strings.
   */
  async readMaintainers(orgId: string): Promise<string[]> {
    const result = await this._simulateContractCall("get_maintainers", [
      nativeToScVal(orgId, { type: "symbol" }),
    ]);
    return scValToNative(result as xdr.ScVal) as string[];
  }

  /**
   * Read the total budget currently held by an organization.
   *
   * @param orgId — The Symbol ID of the organization.
   */
  async readOrgBudget(orgId: string): Promise<bigint> {
    const result = await this._simulateContractCall("get_org_budget", [
      nativeToScVal(orgId, { type: "symbol" }),
    ]);
    return BigInt(scValToNative(result as xdr.ScVal) as number);
  }

  /**
   * Read complete organization details including budget from the contract.
   * This method queries DataKey::Org(id) and DataKey::OrgBudget(id) directly.
   *
   * @param orgId — The Symbol ID of the organization.
   * @returns Organization details with name, admin address, and budget.
   */
  async readOrganizationDetails(orgId: string): Promise<{
    id: string;
    name: string;
    admin: string;
    budgetStroops: string;
    budgetXlm: string;
    metadataCid?: string | undefined;
  }> {
    // Get organization data from DataKey::Org(id)
    const orgResult = await this._simulateContractCall("get_org", [
      nativeToScVal(orgId, { type: "symbol" }),
    ]);
    const orgData = scValToNative(orgResult as xdr.ScVal) as Record<string, unknown>;

    // Get budget from DataKey::OrgBudget(id)
    const budgetResult = await this._simulateContractCall("get_org_budget", [
      nativeToScVal(orgId, { type: "symbol" }),
    ]);
    const budgetStroops = BigInt(scValToNative(budgetResult as xdr.ScVal) as number);

    return {
      id: orgData.id as string,
      name: orgData.name as string,
      admin: orgData.admin as string,
      budgetStroops: budgetStroops.toString(),
      budgetXlm: (Number(budgetStroops) / 10_000_000).toFixed(7),
      metadataCid: orgData.metadata_cid as string | undefined,
    };
  }



  // ── Add inside StellarService class, after readOrgBudget ──────────────────────

  /**
   * Fetch all historical payout events for a maintainer address.
   *
   * Uses Soroban RPC `getEvents` filtered by contract ID and the maintainer
   * address in topic[1]. This is the on-chain equivalent of a DB index on
   * `maintainerAddress`.
   *
   * NOTE: Soroban RPC retains roughly 17,280 ledgers (~24 hrs on Testnet).
   * Set PROFILE_START_LEDGER in .env to the contract deployment ledger so
   * history is not silently truncated.
   *
   * Expected event layout emitted by `allocate_payout`:
   *   topics: [Symbol("allocate_payout"), Address(maintainer), Symbol(orgId)]
   *   data:   i128(amountStroops)
   *
   * TODO: Confirm this matches the Rust contract's event::publish() call.
   */
  async readProfileStats(maintainerAddress: string): Promise<ProfileStats> {
    const startLedger = parseInt(
      process.env["PROFILE_START_LEDGER"] ?? "1",
      10
    );

    // Build XDR filter for topic[1] = maintainerAddress
    const addressXdr = nativeToScVal(maintainerAddress, {
      type: "address",
    }).toXDR("base64");

    const eventsResponse = await this.rpcServer.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          // topic[0] = any function name, topic[1] = this maintainer
          topics: [["*", addressXdr]],
        },
      ],
      limit: 200,
    });

    const payouts: PayoutEvent[] = [];
    const orgSet = new Set<string>();
    let totalStroops = BigInt(0);

    for (const event of eventsResponse.events ?? []) {
      try {
        // topic[2] = orgId Symbol, data = i128 amount
        const orgId = event.topic[2]
          ? (scValToNative(event.topic[2]) as string)
          : "unknown";

        // Use decodeI128ToBigInt for proper i128 handling (prevents JS number precision loss)
        const amount = decodeI128ToBigInt(event.value);

        orgSet.add(orgId);
        totalStroops += amount;
        payouts.push({
          orgId,
          amountStroops: amount,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt,
          txHash: event.txHash,
        });
      } catch {
        // Skip any malformed events — don't crash the endpoint.
      }
    }

    // Sort timeline newest first.
    payouts.sort((a, b) => b.ledger - a.ledger);

    return {
      address: maintainerAddress,
      totalStroops,
      totalXlm: stroopsToXlm(totalStroops),
      orgIds: [...orgSet],
      payouts,
    };
  }
  /**
   * Get the current state of the contract for indexing purposes.
   * This method fetches key contract data that should be indexed.
   *
   * @param contractId - The contract ID to query
   * @returns Contract state data for indexing
   */
  async getContractState(contractId: string): Promise<Record<string, unknown>> {
    try {
      // Get the ledger info to establish baseline, with Horizon fallback
      const ledgerSequence = await this.getLatestLedger();

      // In a real implementation, you would query specific contract storage keys
      // For now, we'll return basic contract information
      return {
        contractId,
        ledgerSequence,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Error fetching contract state:', error);
      throw error;
    }
  }

  /**
   * Fetch Soroban events for the contract within a ledger range.
   * 
   * @param startLedger - The beginning ledger sequence (inclusive)
   * @param topics - Optional topic filters (XDR-encoded strings)
   * @param limit - Maximum number of events to return
   * @returns Array of events
   */
  async getEvents(
    startLedger: number,
    topics?: string[][],
    limit: number = 1000
  ): Promise<SorobanRpc.Api.GetEventsResponse> {
    return this._callWithRetry(() => this.rpcServer.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          topics: topics ?? [],
        },
      ],
      limit,
    }));
  }

  /**
   * Fetch Soroban events for a specific ledger range with end ledger.
   * Used for batched querying to avoid timeouts.
   * 
   * @param startLedger - The beginning ledger sequence (inclusive)
   * @param endLedger - The ending ledger sequence (inclusive)
   * @param topics - Optional topic filters (XDR-encoded strings)
   * @param limit - Maximum number of events to return
   * @returns Array of events
   */
  async getEventsInRange(
    startLedger: number,
    endLedger: number,
    topics?: string[][],
    limit: number = 1000
  ): Promise<SorobanRpc.Api.GetEventsResponse> {
    return this._callWithRetry(() => this.rpcServer.getEvents({
      startLedger,
      endLedger,
      filters: [
        {
          type: "contract",
          contractIds: [CONTRACT_ID],
          topics: topics ?? [],
        },
      ],
      limit,
    } as any));
  }

  /**
   * Get the latest ledger sequence number.
   * Used to determine the upper bound for event queries.
   *
   * Falls back to Horizon `GET /ledgers?order=desc&limit=1` if Soroban RPC
   * is unavailable.
   */
  async getLatestLedger(): Promise<number> {
    return this._callWithFallback(
      async () => {
        const ledger = await this.rpcServer.getLatestLedger();
        return ledger.sequence;
      },
      async (fallback) => {
        const result = await fallback.getLatestLedger();
        if (result.ok) {
          return { ok: true as const, value: result.value.sequence, source: "horizon" as const };
        }
        return { ok: false as const, source: "horizon" as const };
      }
    );
  }

  // ── Soroban Write Operations ──────────────────────────────────────────────

  /**
   * Initialize the contract with the global Token address.
   */
  async initContract(tokenAddress: string, signerSecret: string): Promise<ContractCallResult> {
    return this._submitContractCall(
      "init",
      [nativeToScVal(tokenAddress, { type: "address" })],
      signerSecret
    );
  }

  /**
   * Register a new organization on the contract.
   * 
   * @param id           — The organization's Symbol ID (max 9 chars).
   * @param name         — The display name of the organization.
   * @param admin        — The admin's Stellar public key.
   * @param signerSecret — The admin's Stellar secret key.
   */
  async registerOrg(
    id: string,
    name: string,
    admin: string,
    signerSecret: string
  ): Promise<ContractCallResult> {
    return this._submitContractCall(
      "register_org",
      [
        nativeToScVal(id, { type: "symbol" }),
        nativeToScVal(name, { type: "string" }),
        nativeToScVal(admin, { type: "address" }),
      ],
      signerSecret
    );
  }

  /**
   * Fund an organization's budget.
   *
   * @param orgId           — The organization's Symbol ID.
   * @param fromAddress     — The funding donor's Stellar address.
   * @param amountStroops   — Amount in stroops to donate.
   * @param signerSecret    — The donor's Stellar secret key.
   */
  async fundOrg(
    orgId: string,
    fromAddress: string,
    amountStroops: bigint,
    signerSecret: string
  ): Promise<ContractCallResult> {
    return this._submitContractCall(
      "fund_org",
      [
        nativeToScVal(orgId, { type: "symbol" }),
        nativeToScVal(fromAddress, { type: "address" }),
        nativeToScVal(amountStroops, { type: "i128" }),
      ],
      signerSecret
    );
  }

  /**
   * Allocate a payout to a maintainer by building and submitting a Soroban
   * transaction signed by the org admin.
   *
   * ⚠️  Security note: In this scaffold the `signerSecret` is passed directly.
   * In a production system, signing should happen client-side (via Freighter)
   * and only the signed XDR should reach this endpoint.
   *
   * @param orgId           — The organization's Symbol ID.
   * @param maintainerAddress — The maintainer's Stellar address.
   * @param amountStroops   — Amount in stroops (bigint).
   * @param signerSecret    — The admin's Stellar secret key (S...).
   * @param unlockTimestamp — Optional unlock timestamp.
   */
  async allocatePayout(
    orgId: string,
    maintainerAddress: string,
    amountStroops: bigint,
    signerSecret: string,
    unlockTimestamp: number = 0
  ): Promise<ContractCallResult> {
    const adminAddress = Keypair.fromSecret(signerSecret).publicKey();
    return this._submitContractCall(
      "allocate_payout",
      [
        nativeToScVal(orgId, { type: "symbol" }),
        nativeToScVal(adminAddress, { type: "address" }),
        nativeToScVal(maintainerAddress, { type: "address" }),
        nativeToScVal(amountStroops, { type: "i128" }),
        nativeToScVal(unlockTimestamp, { type: "u64" }),
      ],
      signerSecret
    );
  }

  // ── Internal Helpers ──────────────────────────────────────────────────────

  /**
   * Simulate a read-only contract call via Soroban RPC `simulateTransaction`.
   * Simulation does not consume fees and is suitable for view functions.
   */
  private async _simulateContractCall(
    functionName: string,
    args: xdr.ScVal[]
  ): Promise<xdr.ScVal> {
    // We need a temporary account for the simulation envelope.
    // Using a well-known Testnet account placeholder is fine for simulation.
    const sourceKeypair = Keypair.random();
    const account = await this.horizon
      .loadAccount(sourceKeypair.publicKey())
      .catch(() => {
        // Fall back to a dummy account for pure simulation.
        return {
          id: sourceKeypair.publicKey(),
          sequenceNumber: () => "0",
        } as unknown as Horizon.AccountResponse;
      });

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // @ts-expect-error — invokeContractFunction exists at runtime but is missing from SDK types
        xdr.Operation.invokeContractFunction({
          contractAddress: xdr.ScAddress.scAddressTypeContract(
            xdr.Hash.fromXDR(CONTRACT_ID, "hex")
          ),
          functionName,
          args,
        })
      )
      .setTimeout(30)
      .build();

    const simResult = await this._callWithRetry(() => this.rpcServer.simulateTransaction(tx));

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    // result.retval is present on successful simulations (not reflected in SDK typings)
    return (simResult.result as { retval: xdr.ScVal } | undefined)?.retval as xdr.ScVal;
  }

  /**
   * Submit a state-changing contract call.
   * Builds → Simulates (to get auth + footprint) → Signs → Sends.
   *
   * Transaction submission and confirmation polling include Horizon fallback:
   * if Soroban RPC is down, transactions are submitted via Horizon's
   * `POST /transactions` endpoint and confirmed via `GET /transactions/{hash}`.
   */
  private async _submitContractCall(
    functionName: string,
    args: xdr.ScVal[],
    signerSecret: string
  ): Promise<ContractCallResult> {
    const keypair = Keypair.fromSecret(signerSecret);
    const account = await this._callWithRetry(() => this.horizon.loadAccount(keypair.publicKey()));

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (xdr.Operation as any).invokeContractFunction({
          contractAddress: xdr.ScAddress.scAddressTypeContract(
            xdr.Hash.fromXDR(CONTRACT_ID, "hex")
          ),
          functionName,
          args,
        })
      )
      .setTimeout(30)
      .build();

    // Simulate to get the authorisation + storage footprint.
    const simResult = await this._callWithRetry(() => this.rpcServer.simulateTransaction(tx));
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    // Assemble the fully-prepared (authorised + footprint-extended) transaction.
    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(keypair);

    // Send transaction with Horizon fallback
    const sendResult = await this._callWithFallback(
      async () => {
        const result = await this.rpcServer.sendTransaction(preparedTx);
        if (result.status === "ERROR") {
          throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
        }
        return result;
      },
      async (fallback) => {
        const result = await fallback.submitTransaction(preparedTx);
        if (!result.ok) return { ok: false as const, source: "horizon" as const };
        if (result.value.status === "FAILED") {
          throw new Error(`Horizon submission failed: ${result.value.hash}`);
        }
        return { ok: true as const, value: { hash: result.value.hash }, source: "horizon" as const };
      }
    );

    // Poll for confirmation with Horizon fallback
    const getResult = await this._pollTransaction(sendResult.hash);

    if (getResult.status !== "SUCCESS") {
      throw new Error(`Transaction not successful: ${getResult.status}`);
    }

    return {
      success: true,
      value: getResult.returnValue ? scValToNative(getResult.returnValue as xdr.ScVal) : undefined,
      transactionHash: sendResult.hash,
    };
  }

  /**
   * Create a claim payout transaction for a maintainer.
   */
  async createClaimPayoutTransaction(orgId: string, maintainerAddress: string): Promise<string> {
    if (!CONTRACT_ID) {
      throw new Error("CONTRACT_ID not configured");
    }

    // Get the maintainer's account
    const account = await this._callWithRetry(() => this.horizon.loadAccount(maintainerAddress));

    // Build the claim_payout transaction
    const contractArgs = [
      nativeToScVal(orgId),
    ];

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation({
        type: "invoke_contract_function",
        contract: CONTRACT_ID,
        function: "claim_payout",
        args: contractArgs,
      } as any)
      .setTimeout(30)
      .build();

    // Simulate the transaction to get the transaction data
    const simResult = await this._callWithRetry(() => this.rpcServer.simulateTransaction(transaction));

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation error: ${simResult.error}`);
    }

    // Prepare the transaction for signing
    const preparedTx = SorobanRpc.assembleTransaction(transaction, simResult).build();

    return preparedTx.toXDR();
  }

  /**
   * Submit a signed transaction to the Stellar network.
   *
   * Includes Horizon fallback: if Soroban RPC is unavailable, the transaction
   * is submitted via Horizon's `POST /transactions` endpoint.
   */
  async submitTransaction(signedTransactionXdr: string): Promise<ContractCallResult> {
    const transaction = TransactionBuilder.fromXDR(signedTransactionXdr, NETWORK_PASSPHRASE);

    const sendResult = await this._callWithFallback(
      async () => {
        const result = await this.rpcServer.sendTransaction(transaction);
        if (result.status === "ERROR") {
          throw new Error(`Transaction failed: ${result.errorResult || "Unknown error"}`);
        }
        return result;
      },
      async (fallback) => {
        const result = await fallback.submitTransaction(signedTransactionXdr);
        if (!result.ok) return { ok: false as const, source: "horizon" as const };
        if (result.value.status === "FAILED") {
          throw new Error(`Horizon submission failed: ${result.value.hash}`);
        }
        return { ok: true as const, value: { hash: result.value.hash }, source: "horizon" as const };
      }
    );

    // Poll for confirmation with Horizon fallback
    const getResult = await this._pollTransaction(sendResult.hash);

    if (getResult.status !== "SUCCESS") {
      throw new Error(`Transaction not successful: ${getResult.status}`);
    }

    return {
      success: true,
      value: getResult.returnValue ? scValToNative(getResult.returnValue as xdr.ScVal) : undefined,
      transactionHash: sendResult.hash,
    };
  }

  /**
   * Poll for transaction confirmation with Horizon fallback.
   *
   * Tries Soroban RPC `getTransaction` first. If it fails with a
   * transient error, falls back to Horizon `GET /transactions/{hash}`.
   *
   * @param hash - The transaction hash to poll for.
   * @returns The transaction result with status and return value.
   */
  private async _pollTransaction(
    hash: string
  ): Promise<{ status: string; returnValue?: xdr.ScVal }> {
    const MAX_POLL_ATTEMPTS = 30;
    const POLL_INTERVAL_MS = 1000;

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      try {
        const result = await this.rpcServer.getTransaction(hash);
        if (result.status !== "NOT_FOUND") {
          return result as { status: string; returnValue?: xdr.ScVal };
        }
      } catch (rpcError) {
        // If RPC fails and we have a fallback, try Horizon
        if (this.fallback && isFallbackEligibleError(rpcError)) {
          console.warn("[Stellar] RPC getTransaction failed, trying Horizon fallback");
          const fallbackResult = await this.fallback.getTransaction(hash);
          if (fallbackResult.ok) {
            // Horizon doesn't provide Soroban return values, but it can confirm success
            return {
              status: fallbackResult.value.status,
            };
          }
        }
        // If fallback also fails, continue polling (transient error may resolve)
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error(`Transaction ${hash} not confirmed after ${MAX_POLL_ATTEMPTS} attempts`);
  }

  /**
   * Helper to retrieve all payouts for a maintainer address.
   */
  async getMaintainerPayouts(address: string) {
    const stats = await this.readProfileStats(address);
    return stats.payouts;
  }
}

// Singleton export — avoids creating multiple SDK client instances.
export const stellarService = new StellarService();
