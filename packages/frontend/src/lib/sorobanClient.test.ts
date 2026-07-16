/**
 * @file sorobanClient.test.ts
 * @description Unit tests for the frontend XDR builder utility functions.
 *
 * These tests verify the logic of each `build*Transaction` method on the
 * SorobanClient class without hitting live Stellar network endpoints.
 * All Horizon and Soroban RPC network calls are mocked via Vitest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CONTRACT_ID = "CCONTRACT_ID_MOCK";
  const mockToXDR = vi.fn(() => "MOCK_XDR_STRING");
  const mockBuild = vi.fn(() => ({ toXDR: mockToXDR }));
  const mockAddOperation = vi.fn().mockReturnThis();
  const mockSetTimeout = vi.fn().mockReturnThis();
  const mockTransactionBuilderInstance = {
    addOperation: mockAddOperation,
    setTimeout: mockSetTimeout,
    build: mockBuild,
  };

  const mockContractCall = vi.fn(() => "MOCK_OPERATION");
  const mockContractInstance = { call: mockContractCall };

  const mockSimulateTransaction = vi.fn();
  const mockSendTransaction = vi.fn();
  const mockGetTransaction = vi.fn();
  const mockLoadAccount = vi.fn();
  const mockLoadAccountHorizon = vi.fn();

  const mockAssembleTransaction = vi.fn(() => ({ build: mockBuild }));

  return {
    mockToXDR,
    mockBuild,
    mockAddOperation,
    mockSetTimeout,
    mockTransactionBuilderInstance,
    mockContractCall,
    mockContractInstance,
    mockSimulateTransaction,
    mockSendTransaction,
    mockGetTransaction,
    mockLoadAccount,
    mockLoadAccountHorizon,
    mockAssembleTransaction,
  };
});

const {
  mockToXDR,
  mockBuild,
  mockAddOperation,
  mockSetTimeout,
  mockTransactionBuilderInstance,
  mockContractCall,
  mockContractInstance,
  mockSimulateTransaction,
  mockSendTransaction,
  mockGetTransaction,
  mockLoadAccount,
  mockLoadAccountHorizon,
  mockAssembleTransaction,
} = mocks;

vi.mock("@stellar/stellar-sdk", () => {
  return {
    SorobanRpc: {
      Server: vi.fn(() => ({
        simulateTransaction: mocks.mockSimulateTransaction,
        sendTransaction: mocks.mockSendTransaction,
        getTransaction: mocks.mockGetTransaction,
      })),
      Api: {
        isSimulationError: vi.fn((result: unknown) => {
          return (result as Record<string, unknown>).error !== undefined;
        }),
      },
      assembleTransaction: mocks.mockAssembleTransaction,
    },
    TransactionBuilder: vi.fn(() => mocks.mockTransactionBuilderInstance).mockImplementation(() => mocks.mockTransactionBuilderInstance) as unknown as {
      fromXDR: ReturnType<typeof vi.fn>;
    } & ReturnType<typeof vi.fn>,
    Networks: {
      TESTNET: "Test SDF Network ; September 2015",
    },
    BASE_FEE: "100",
    nativeToScVal: vi.fn((val: unknown) => ({ scVal: val })),
    scValToNative: vi.fn((val: unknown) => val),
    Contract: vi.fn(() => mocks.mockContractInstance),
    Keypair: {
      random: vi.fn(() => ({
        publicKey: vi.fn(() => "GABC1234567890ABCDE"),
      })),
    },
    Horizon: {
      Server: vi.fn(() => ({
        loadAccount: mocks.mockLoadAccountHorizon,
      })),
    },
  };
});

vi.mock("@very-prince/types", () => ({
  PrinceError: {},
  PrinceErrorMessage: {},
}));

// ─── Import after mocks are set up ───────────────────────────────────────────

import {
  buildFundOrgTransaction,
  buildClaimPayoutTransaction,
  buildAllocatePayoutTransaction,
  buildUpdateOrgMetadataTransaction,
  submitSignedTransaction,
  readOrganization,
  readMaintainers,
  readClaimableBalance,
  readOrgBudget,
  readAccountXlmBalance,
} from "./sorobanClient";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns a mock Soroban simulation success result. */
function makeSimSuccess() {
  return {
    result: { retval: { scVal: "native_val" } },
    // no .error → isSimulationError returns false
  };
}

/** Returns a mock Soroban simulation error result. */
function makeSimError(message = "Soroban simulation failed") {
  return { error: message };
}

/** A realistic-enough fake Horizon AccountResponse. */
function makeAccount(publicKey: string) {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => "12345",
    incrementSequenceNumber: () => {},
    balances: [{ asset_type: "native", balance: "100.0000000" }],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("sorobanClient — XDR builder utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: loadAccount succeeds
    mockLoadAccountHorizon.mockResolvedValue(makeAccount("GPUBLIC_KEY_EXAMPLE"));
    // Default: simulation succeeds
    mockSimulateTransaction.mockResolvedValue(makeSimSuccess());
    // Default: assembleTransaction returns a buildable object
    mockAssembleTransaction.mockReturnValue({ build: mockBuild });
    // Default: build returns toXDR
    mockBuild.mockReturnValue({ toXDR: mockToXDR });
    // Default: toXDR returns a deterministic string
    mockToXDR.mockReturnValue("MOCK_XDR_STRING");
  });

  // ── buildFundOrgTransaction ──────────────────────────────────────────────────

  describe("buildFundOrgTransaction", () => {
    it("returns an XDR string on success", async () => {
      const xdr = await buildFundOrgTransaction(
        "org-alpha",
        "GPUBLIC_KEY_EXAMPLE",
        BigInt(10_000_000)
      );
      expect(xdr).toBe("MOCK_XDR_STRING");
    });

    it("calls contract.call with 'fund_org' and correct arguments", async () => {
      await buildFundOrgTransaction("org-alpha", "GPUBLIC_KEY_EXAMPLE", BigInt(10_000_000));
      expect(mockContractCall).toHaveBeenCalledWith(
        "fund_org",
        expect.anything(), // nativeToScVal(orgId)
        expect.anything(), // nativeToScVal(fromAddress)
        expect.anything()  // nativeToScVal(amountStroops, { type: 'i128' })
      );
    });

    it("throws when simulation returns an error", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError("out of gas"));
      await expect(
        buildFundOrgTransaction("org-alpha", "GPUBLIC_KEY_EXAMPLE", BigInt(1))
      ).rejects.toThrow();
    });

    it("throws when account load fails", async () => {
      mockLoadAccountHorizon.mockRejectedValue(new Error("Account not found"));
      await expect(
        buildFundOrgTransaction("org-alpha", "GNOFUNDS", BigInt(1))
      ).rejects.toThrow(/Failed to load account/);
    });
  });

  // ── buildClaimPayoutTransaction ──────────────────────────────────────────────

  describe("buildClaimPayoutTransaction", () => {
    it("returns an XDR string on success", async () => {
      const xdr = await buildClaimPayoutTransaction("GPUBLIC_KEY_EXAMPLE");
      expect(xdr).toBe("MOCK_XDR_STRING");
    });

    it("calls contract.call with 'claim_payout' and the user address", async () => {
      await buildClaimPayoutTransaction("GPUBLIC_KEY_EXAMPLE");
      expect(mockContractCall).toHaveBeenCalledWith(
        "claim_payout",
        expect.anything() // nativeToScVal(userAddress)
      );
    });

    it("throws when simulation returns an error", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError("insufficient balance"));
      await expect(buildClaimPayoutTransaction("GPUBLIC_KEY_EXAMPLE")).rejects.toThrow();
    });

    it("throws when account load fails", async () => {
      mockLoadAccountHorizon.mockRejectedValue(new Error("Network timeout"));
      await expect(buildClaimPayoutTransaction("GPUBLIC_KEY_EXAMPLE")).rejects.toThrow(
        /Failed to load account/
      );
    });
  });

  // ── buildAllocatePayoutTransaction ───────────────────────────────────────────

  describe("buildAllocatePayoutTransaction", () => {
    it("returns an XDR string on success", async () => {
      const xdr = await buildAllocatePayoutTransaction(
        "GADMIN_KEY",
        "org-beta",
        "GMAINTAINER_KEY",
        BigInt(5_000_000)
      );
      expect(xdr).toBe("MOCK_XDR_STRING");
    });

    it("calls contract.call with 'allocate_payout' and five arguments", async () => {
      await buildAllocatePayoutTransaction(
        "GADMIN_KEY",
        "org-beta",
        "GMAINTAINER_KEY",
        BigInt(5_000_000)
      );
      expect(mockContractCall).toHaveBeenCalledWith(
        "allocate_payout",
        expect.anything(), // orgId as symbol
        expect.anything(), // adminAddress as address
        expect.anything(), // maintainerAddress as address
        expect.anything(), // amountStroops as i128
        expect.anything()  // 0 as u64
      );
    });

    it("throws on simulation error", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError("unauthorized"));
      await expect(
        buildAllocatePayoutTransaction("GADMIN_KEY", "org-beta", "GMAINTAINER_KEY", BigInt(1))
      ).rejects.toThrow();
    });

    it("throws when account load fails", async () => {
      mockLoadAccountHorizon.mockRejectedValue(new Error("No account"));
      await expect(
        buildAllocatePayoutTransaction("GADMIN_UNFUNDED", "org-beta", "GMAINTAINER_KEY", BigInt(1))
      ).rejects.toThrow(/Failed to load account/);
    });
  });

  // ── buildUpdateOrgMetadataTransaction ────────────────────────────────────────

  describe("buildUpdateOrgMetadataTransaction", () => {
    it("returns an XDR string on success", async () => {
      const xdr = await buildUpdateOrgMetadataTransaction(
        "GADMIN_KEY",
        "org-gamma",
        "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354"
      );
      expect(xdr).toBe("MOCK_XDR_STRING");
    });

    it("calls contract.call with 'update_org_metadata' and three arguments", async () => {
      await buildUpdateOrgMetadataTransaction("GADMIN_KEY", "org-gamma", "QmCID");
      expect(mockContractCall).toHaveBeenCalledWith(
        "update_org_metadata",
        expect.anything(), // orgId as symbol
        expect.anything(), // adminAddress as address
        expect.anything()  // metadataCid as string
      );
    });

    it("throws on simulation error", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError("not an admin"));
      await expect(
        buildUpdateOrgMetadataTransaction("GADMIN_KEY", "org-gamma", "QmCID")
      ).rejects.toThrow();
    });

    it("throws when account load fails", async () => {
      mockLoadAccountHorizon.mockRejectedValue(new Error("Horizon 404"));
      await expect(
        buildUpdateOrgMetadataTransaction("GADMIN_KEY", "org-gamma", "QmCID")
      ).rejects.toThrow(/Failed to load account/);
    });
  });

  // ── submitSignedTransaction ───────────────────────────────────────────────────

  describe("submitSignedTransaction", () => {
    beforeEach(async () => {
      // TransactionBuilder.fromXDR needs to exist on the mock constructor
      const { TransactionBuilder } = vi.mocked(
        await import("@stellar/stellar-sdk")
      );
      (TransactionBuilder as unknown as { fromXDR: ReturnType<typeof vi.fn> }).fromXDR = vi.fn(
        () => mockTransactionBuilderInstance
      );

      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "TXHASH123" });
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: { scVal: "native_result" },
      });
    });

    it("resolves when transaction reaches SUCCESS status", async () => {
      await expect(submitSignedTransaction("MOCK_SIGNED_XDR")).resolves.toBeDefined();
    });

    it("rejects when send returns ERROR status", async () => {
      mockSendTransaction.mockResolvedValue({ status: "ERROR", extras: {} });
      await expect(submitSignedTransaction("MOCK_SIGNED_XDR")).rejects.toThrow(/Send error/);
    });

    it("rejects when transaction polling sees FAILED status", async () => {
      mockGetTransaction.mockResolvedValue({ status: "FAILED", returnValue: null });
      await expect(submitSignedTransaction("MOCK_SIGNED_XDR")).rejects.toThrow();
    });
  });

  // ── Read API utility functions ────────────────────────────────────────────────

  describe("readOrganization", () => {
    it("maps raw contract map to an Organization object", async () => {
      mockSimulateTransaction.mockResolvedValue({
        result: {
          retval: {
            id: "org-alpha",
            name: "Alpha Org",
            admin: "GADMIN_KEY",
            metadata_cid: "QmCID",
          },
        },
      });

      // scValToNative is mocked to return retval as-is
      vi.mocked((await import("@stellar/stellar-sdk")).scValToNative).mockReturnValue({
        id: "org-alpha",
        name: "Alpha Org",
        admin: "GADMIN_KEY",
        metadata_cid: "QmCID",
      });

      const org = await readOrganization("org-alpha");
      expect(org.id).toBe("org-alpha");
      expect(org.name).toBe("Alpha Org");
      expect(org.admin).toBe("GADMIN_KEY");
      expect(org.metadataCid).toBe("QmCID");
    });

    it("throws when simulation fails", async () => {
      mockSimulateTransaction.mockResolvedValue(makeSimError("org not found"));
      await expect(readOrganization("bad-id")).rejects.toThrow();
    });
  });

  describe("readMaintainers", () => {
    it("returns an array of maintainer addresses", async () => {
      vi.mocked((await import("@stellar/stellar-sdk")).scValToNative).mockReturnValue([
        "GMAINT1",
        "GMAINT2",
      ]);
      const result = await readMaintainers("org-alpha");
      expect(result).toEqual(["GMAINT1", "GMAINT2"]);
    });

    it("returns empty array when result is not an array", async () => {
      vi.mocked((await import("@stellar/stellar-sdk")).scValToNative).mockReturnValue(null);
      const result = await readMaintainers("org-alpha");
      expect(result).toEqual([]);
    });
  });

  describe("readClaimableBalance", () => {
    it("returns stroops as BigInt and xlm as a decimal string", async () => {
      vi.mocked((await import("@stellar/stellar-sdk")).scValToNative).mockReturnValue(10_000_000);
      const balance = await readClaimableBalance("GMAINT1");
      expect(balance.stroops).toBe(BigInt(10_000_000));
      expect(balance.xlm).toBe("1.0000000");
      expect(balance.address).toBe("GMAINT1");
    });
  });

  describe("readOrgBudget", () => {
    it("returns stroops as BigInt and xlm as a decimal string", async () => {
      vi.mocked((await import("@stellar/stellar-sdk")).scValToNative).mockReturnValue(50_000_000);
      const budget = await readOrgBudget("org-alpha");
      expect(budget.stroops).toBe(BigInt(50_000_000));
      expect(budget.xlm).toBe("5.0000000");
    });
  });

  describe("readAccountXlmBalance", () => {
    it("returns the XLM balance as a number when the account is funded", async () => {
      const balance = await readAccountXlmBalance("GPUBLIC_KEY_EXAMPLE");
      expect(typeof balance).toBe("number");
      expect(balance).toBe(100);
    });

    it("returns null when Horizon throws (account not found)", async () => {
      mockLoadAccountHorizon.mockRejectedValue(new Error("Not Found"));
      const balance = await readAccountXlmBalance("GNOFUNDS");
      expect(balance).toBeNull();
    });

    it("returns 0 when account has no native balance line", async () => {
      mockLoadAccountHorizon.mockResolvedValue({ balances: [{ asset_type: "credit_alphanum4", balance: "50.0" }] });
      const balance = await readAccountXlmBalance("GPUBLIC_KEY_EXAMPLE");
      expect(balance).toBe(0);
    });
  });
});
