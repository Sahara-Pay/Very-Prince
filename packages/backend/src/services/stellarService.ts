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
  NETWORK_PASSPHRASE,
  RPC_URL,
} from "../config/env.js";
import { withRetry } from "../utils/retry.js";
import { decodeI128ToBigInt, stroopsToXlm, decodeBase64Xdr } from "../utils/xdrDecoder.js";
import type { AccountInfo, ContractCallResult, PayoutEvent, ProfileStats } from "@very-princess/types";

// ─── Types ───────────────────────────────────────────────────────────────────

export type { AccountInfo, ContractCallResult, PayoutEvent, ProfileStats };
// ─── Service ─────────────────────────────────────────────────────────────────

export class StellarService {
  /** Horizon server instance for REST API calls. */
  private readonly horizon: Horizon.Server;

  /** Soroban RPC server for smart contract interactions. */
  private readonly rpcServer: SorobanRpc.Server;

  constructor() {
    this.horizon = new Horizon.Server(HORIZON_URL, {
      allowHttp: HORIZON_URL.startsWith("http://"), // allow HTTP for local dev only
    });

    this.rpcServer = new SorobanRpc.Server(RPC_URL, {
      allowHttp: RPC_URL.startsWith("http://"),
    });
  }

  /**
   * Helper to wrap calls with retry and backoff logic.
   */
  private async _callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      onRetry: (error, attempt) => {
        if (attempt >= 3) {
          console.error(`[CRITICAL] High-priority: Rate limit backoff exceeded 3 times! (Attempt ${attempt})`);
        } else {
          console.warn(`[Stellar] Rate limited. Retrying... (Attempt ${attempt})`);
        }
      }
    });
  }

  // ── Horizon (Account) Operations ─────────────────────────────────────────

  /**
   * Fetch basic account information from Horizon.
   *
   * @param publicKey — The Stellar public key (G...) of the account.
   * @throws If the account does not exist on the network.
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
    
    // topic[0] = Symbol("VeryPrincess"), topic[1] = Symbol("org_registered")
    const topic0 = nativeToScVal("VeryPrincess", { type: "symbol" }).toXDR("base64");
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
        const orgId = scValToNative(event.topic[2]) as string;
        orgIds.add(orgId);
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
    metadataCid?: string;
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
        const valueScVal = decodeBase64Xdr(event.value);
        const amount = decodeI128ToBigInt(valueScVal);

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
      // Get the ledger info to establish baseline
      const ledger = await this._callWithRetry(() => this.rpcServer.getLatestLedger());

      // In a real implementation, you would query specific contract storage keys
      // For now, we'll return basic contract information
      const contractState = {
        contractId,
        ledgerSequence: ledger.sequence,
        timestamp: new Date().toISOString(), // Use current time since ledger doesn't have timestamp
        // Add more contract-specific data as needed
        // This could include total organizations, total budgets, etc.
      };

      return contractState;
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
    }));
  }

  /**
   * Get the latest ledger sequence number.
   * Used to determine the upper bound for event queries.
   */
  async getLatestLedger(): Promise<number> {
    const ledger = await this._callWithRetry(() => this.rpcServer.getLatestLedger());
    return ledger.sequence;
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
    return this._submitContractCall(
      "allocate_payout",
      [
        nativeToScVal(orgId, { type: "symbol" }),
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

    const sendResult = await this._callWithRetry(() => this.rpcServer.sendTransaction(preparedTx));

    if (sendResult.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(sendResult)}`);
    }

    // Poll for confirmation.
    let getResult = await this._callWithRetry(() => this.rpcServer.getTransaction(sendResult.hash));
    while (getResult.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResult = await this._callWithRetry(() => this.rpcServer.getTransaction(sendResult.hash));
    }

    if (getResult.status !== "SUCCESS") {
      throw new Error(`Transaction not successful: ${getResult.status}`);
    }

    return {
      success: true,
      value: scValToNative(getResult.returnValue as xdr.ScVal),
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
    const preparedTx = await this._callWithRetry(() =>
      this.rpcServer.prepareTransaction(transaction, simResult)
    );

    return preparedTx.toXDR();
  }

  /**
   * Submit a signed transaction to the Stellar network.
   */
  async submitTransaction(signedTransactionXdr: string): Promise<ContractCallResult> {
    const transaction = TransactionBuilder.fromXDR(signedTransactionXdr, NETWORK_PASSPHRASE);

    const sendResult = await this._callWithRetry(() => this.rpcServer.sendTransaction(transaction));

    if (sendResult.status === "ERROR") {
      throw new Error(`Transaction failed: ${sendResult.errorResult || 'Unknown error'}`);
    }

    // Poll for confirmation
    let getResult = await this._callWithRetry(() => this.rpcServer.getTransaction(sendResult.hash));
    while (getResult.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      getResult = await this._callWithRetry(() => this.rpcServer.getTransaction(sendResult.hash));
    }

    if (getResult.status !== "SUCCESS") {
      throw new Error(`Transaction not successful: ${getResult.status}`);
    }

    return {
      success: true,
      value: scValToNative(getResult.returnValue as xdr.ScVal),
      transactionHash: sendResult.hash,
    };
  }
}

// Singleton export — avoids creating multiple SDK client instances.
export const stellarService = new StellarService();
