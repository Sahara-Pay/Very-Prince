/**
 * @file sorobanClient.ts
 * @description Browser-side service for interacting with the Soroban RPC and Horizon.
 */

"use client";

import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  Contract,
  Keypair,
  Horizon,
} from "@stellar/stellar-sdk";
import type { MaintainerBalance, Organization } from "./contractTypes";
import { PrinceError, PrinceErrorMessage } from "@very-prince/types";

// ─── Network Configuration ────────────────────────────────────────────────────

const HORIZON_URL = process.env["NEXT_PUBLIC_HORIZON_URL"] ?? "https://horizon-testnet.stellar.org";
const RPC_URL =
  process.env["NEXT_PUBLIC_RPC_URL"] ?? "https://soroban-testnet.stellar.org";

const NETWORK_PASSPHRASE =
  process.env["NEXT_PUBLIC_NETWORK_PASSPHRASE"] ??
  Networks.TESTNET;

const CONTRACT_ID = process.env["NEXT_PUBLIC_CONTRACT_ID"] ?? "";

/**
 * A service class that provides a centralized client for interacting with
 * the Stellar network (Soroban RPC and Horizon).
 */
class SorobanClient {
  private readonly rpcServer: SorobanRpc.Server;
  private readonly horizonServer: Horizon.Server;

  constructor() {
    this.rpcServer = new SorobanRpc.Server(RPC_URL, {
      allowHttp: RPC_URL.startsWith("http://"),
    });
    this.horizonServer = new Horizon.Server(HORIZON_URL, {
      allowHttp: HORIZON_URL.startsWith("http://"),
    });
  }

  // ─── Error Handling ───────────────────────────────────────────────────────────

  /**
   * Decodes a Soroban error from a failed transaction result or simulation.
   */
  private _parseSorobanError(errorResponse: any): string {
    try {
      // Handle simulation error
      if (errorResponse.error) {
        return `Simulation failed: ${errorResponse.error}`;
      }

      // Handle transaction result error
      const returnValue = errorResponse.returnValue;
      // @ts-ignore - _arm is internal to ScVal objects in stellar-sdk
      if (returnValue && returnValue._arm === "error") {
        // @ts-ignore
        const errorVal = returnValue._value;
        // @ts-ignore
        if (errorVal._arm === "contract") {
          // @ts-ignore
          const errorCode = errorVal._value as number;
          const message = PrinceErrorMessage[errorCode as PrinceError];
          if (message) return message;
          return `Contract Error: ${errorCode}`;
        }
      }

      return "Transaction failed on-chain. Please check your inputs and balance.";
    } catch (err) {
      console.error("Failed to parse Soroban error:", err);
      return "Transaction failed. Error details could not be parsed.";
    }
  }

  // ─── Simulation Helper ────────────────────────────────────────────────────────

  private async _simulateContractCall(
    functionName: string,
    args: any[]
  ): Promise<ReturnType<typeof scValToNative>> {
    if (!CONTRACT_ID) {
      throw new Error("NEXT_PUBLIC_CONTRACT_ID is not set. Deploy the contract first.");
    }

    const fakeKeypair = Keypair.random();
    const contract = new Contract(CONTRACT_ID);

    const fakeAccount = {
      accountId: () => fakeKeypair.publicKey(),
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    };

    const tx = new TransactionBuilder(
      // @ts-ignore
      fakeAccount,
      { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE }
    )
      .addOperation(
        contract.call(functionName, ...args.map((a) => nativeToScVal(a)))
      )
      .setTimeout(30)
      .build();

    const simResult = await this.rpcServer.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(this._parseSorobanError(simResult));
    }

    // @ts-ignore
    return scValToNative(simResult.result?.retval);
  }

  // ─── Public Read API ───────────────────────────────────────────────────────────

  public async readOrganization(orgId: string): Promise<Organization> {
    if (typeof window !== "undefined" && (window as any).__MOCK_SOROBAN_CLIENT__?.readOrganization) {
      return (window as any).__MOCK_SOROBAN_CLIENT__.readOrganization(orgId);
    }
    const raw = await this._simulateContractCall("get_org", [orgId]);
    const map = raw as Record<string, unknown>;
    return {
      id: String(map["id"]),
      name: String(map["name"]),
      admin: String(map["admin"]),
      metadataCid: map["metadata_cid"] ? String(map["metadata_cid"]) : undefined,
    };
  }

  public async readMaintainers(orgId: string): Promise<string[]> {
    if (typeof window !== "undefined" && (window as any).__MOCK_SOROBAN_CLIENT__?.readMaintainers) {
      return (window as any).__MOCK_SOROBAN_CLIENT__.readMaintainers(orgId);
    }
    const raw = await this._simulateContractCall("get_maintainers", [orgId]);
    return Array.isArray(raw) ? (raw as string[]) : [];
  }

  public async readClaimableBalance(address: string): Promise<MaintainerBalance> {
    if (typeof window !== "undefined" && (window as any).__MOCK_SOROBAN_CLIENT__?.readClaimableBalance) {
      return (window as any).__MOCK_SOROBAN_CLIENT__.readClaimableBalance(address);
    }
    const raw = await this._simulateContractCall("get_claimable_balance", [address]);
    const stroops = BigInt(raw as number);
    const xlm = (Number(stroops) / 10_000_000).toFixed(7);
    return { address, stroops, xlm };
  }

  public async readOrgBudget(orgId: string): Promise<Pick<MaintainerBalance, "stroops" | "xlm">> {
    if (typeof window !== "undefined" && (window as any).__MOCK_SOROBAN_CLIENT__?.readOrgBudget) {
      return (window as any).__MOCK_SOROBAN_CLIENT__.readOrgBudget(orgId);
    }
    const raw = await this._simulateContractCall("get_org_budget", [orgId]);
    const stroops = BigInt(raw as number);
    const xlm = (Number(stroops) / 10_000_000).toFixed(7);
    return { stroops, xlm };
  }

  public async readAccountXlmBalance(address: string): Promise<number | null> {
    try {
      const account = await this.horizonServer.loadAccount(address);
      const nativeLine = account.balances.find(
        (b): b is typeof b & { asset_type: "native" } => b.asset_type === "native"
      );
      return nativeLine ? parseFloat(nativeLine.balance) : 0;
    } catch {
      return null;
    }
  }

  // ─── Write API (Transaction Builders) ───────────────────────────────────────

  private async _loadAccount(publicKey: string) {
    try {
      return await this.horizonServer.loadAccount(publicKey);
    } catch (err) {
      throw new Error(`Failed to load account from network. Ensure ${publicKey} is funded on Testnet.`);
    }
  }

  public async buildFundOrgTransaction(
    orgId: string,
    fromAddress: string,
    amountStroops: bigint
  ): Promise<string> {
    const account = await this._loadAccount(fromAddress);
    const contract = new Contract(CONTRACT_ID);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "fund_org",
          nativeToScVal(orgId),
          nativeToScVal(fromAddress),
          nativeToScVal(amountStroops, { type: "i128" })
        )
      )
      .setTimeout(60)
      .build();

    const simResult = await this.rpcServer.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(this._parseSorobanError(simResult));
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    const xdr = preparedTx.toXDR();
    try {
      // Emit a debug event so frontend debug panel can capture raw XDRs
      // (listeners are optional and this is safe to call in browser)
      // @ts-ignore window in Node builds will be undefined; guard at runtime
      if (typeof window !== "undefined" && (window as any).dispatchEvent) {
        const ev = new CustomEvent("very-prince:xdr-debug", {
          detail: { type: "unsigned", label: "fund_org", xdr },
        });
        window.dispatchEvent(ev);
      }
    } catch (err) {
      // swallow any errors — this is non-critical debug instrumentation
    }

    return xdr;
  }

  public async buildClaimPayoutTransaction(userAddress: string): Promise<string> {
    const account = await this._loadAccount(userAddress);
    const contract = new Contract(CONTRACT_ID);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call("claim_payout", nativeToScVal(userAddress))
      )
      .setTimeout(60)
      .build();

    const simResult = await this.rpcServer.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(this._parseSorobanError(simResult));
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    const xdr = preparedTx.toXDR();
    try {
      if (typeof window !== "undefined" && (window as any).dispatchEvent) {
        const ev = new CustomEvent("very-prince:xdr-debug", {
          detail: { type: "unsigned", label: "claim_payout", xdr },
        });
        window.dispatchEvent(ev);
      }
    } catch (err) {}
    return xdr;
  }

  public async buildAllocatePayoutTransaction(
    adminAddress: string,
    orgId: string,
    maintainerAddress: string,
    amountStroops: bigint
  ): Promise<string> {
    const account = await this._loadAccount(adminAddress);
    const contract = new Contract(CONTRACT_ID);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call("allocate_payout",
          nativeToScVal(orgId, { type: "symbol" }),
          nativeToScVal(adminAddress, { type: "address" }),
          nativeToScVal(maintainerAddress, { type: "address" }),
          nativeToScVal(amountStroops, { type: "i128" }),
          nativeToScVal(0, { type: "u64" })
        )
      )
      .setTimeout(60)
      .build();

    const simResult = await this.rpcServer.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(this._parseSorobanError(simResult));
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    const xdr = preparedTx.toXDR();
    try {
      if (typeof window !== "undefined" && (window as any).dispatchEvent) {
        const ev = new CustomEvent("very-prince:xdr-debug", {
          detail: { type: "unsigned", label: "allocate_payout", xdr },
        });
        window.dispatchEvent(ev);
      }
    } catch (err) {}
    return xdr;
  }

  public async buildUpdateOrgMetadataTransaction(
    adminAddress: string,
    orgId: string,
    metadataCid: string
  ): Promise<string> {
    const account = await this._loadAccount(adminAddress);
    const contract = new Contract(CONTRACT_ID);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call("update_org_metadata",
          nativeToScVal(orgId, { type: "symbol" }),
          nativeToScVal(adminAddress, { type: "address" }),
          nativeToScVal(metadataCid, { type: "string" })
        )
      )
      .setTimeout(60)
      .build();

    const simResult = await this.rpcServer.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(this._parseSorobanError(simResult));
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    const xdr = preparedTx.toXDR();
    try {
      if (typeof window !== "undefined" && (window as any).dispatchEvent) {
        const ev = new CustomEvent("very-prince:xdr-debug", {
          detail: { type: "unsigned", label: "update_org_metadata", xdr },
        });
        window.dispatchEvent(ev);
      }
    } catch (err) {}
    return xdr;
  }

  public async submitSignedTransaction(signedXdr: string): Promise<unknown> {
    const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);

    const sendResult = await this.rpcServer.sendTransaction(tx as any);
    if (sendResult.status === "ERROR") {
      throw new Error(`Send error: ${JSON.stringify(sendResult)}`);
    }

    return new Promise((resolve, reject) => {
      let attempts = 0;
      const interval = setInterval(async () => {
        attempts++;
        if (attempts > 30) {
          clearInterval(interval);
          return reject(new Error("Transaction confirmation timed out."));
        }

        try {
          const getTxResponse = await this.rpcServer.getTransaction(sendResult.hash);
          if (getTxResponse.status === "SUCCESS") {
            clearInterval(interval);
            resolve(scValToNative(getTxResponse.returnValue as any));
          } else if (getTxResponse.status === "FAILED") {
            clearInterval(interval);
            reject(new Error(this._parseSorobanError(getTxResponse)));
          }
        } catch (err) {
          // network issue, keep polling
        }
      }, 2000);
    });
  }
}

// ─── Singleton Export ───────────────────────────────────────────────────────────

export const sorobanClient = new SorobanClient();

// ─── Backward-Compatibility Exports ───────────────────────────────────────────

export const readOrganization = sorobanClient.readOrganization.bind(sorobanClient);
export const readMaintainers = sorobanClient.readMaintainers.bind(sorobanClient);
export const readClaimableBalance = sorobanClient.readClaimableBalance.bind(sorobanClient);
export const readOrgBudget = sorobanClient.readOrgBudget.bind(sorobanClient);
export const readAccountXlmBalance = sorobanClient.readAccountXlmBalance.bind(sorobanClient);
export const buildFundOrgTransaction = sorobanClient.buildFundOrgTransaction.bind(sorobanClient);
export const buildClaimPayoutTransaction =
  sorobanClient.buildClaimPayoutTransaction.bind(sorobanClient);
export const buildAllocatePayoutTransaction =
  sorobanClient.buildAllocatePayoutTransaction.bind(sorobanClient);
export const buildUpdateOrgMetadataTransaction =
  sorobanClient.buildUpdateOrgMetadataTransaction.bind(sorobanClient);
export const submitSignedTransaction = sorobanClient.submitSignedTransaction.bind(sorobanClient);
