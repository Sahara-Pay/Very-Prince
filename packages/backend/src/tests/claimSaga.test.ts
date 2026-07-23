import { describe, it, expect, vi, beforeEach } from "vitest";
import { TransactionBuilder, Account, Keypair, BASE_FEE, Operation, Asset } from "@stellar/stellar-sdk";

const { mockPrisma, mockStellarService, mockLockService } = vi.hoisted(() => {
  const prismaMock: any = {
    claimSaga: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    sagaAuditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn((cb) => cb(prismaMock)),
  };

  return {
    mockPrisma: prismaMock,
    mockStellarService: {
      readClaimableBalance: vi.fn(),
      createClaimPayoutTransaction: vi.fn(),
      submitTransaction: vi.fn(),
      getTransactionStatus: vi.fn(),
    },
    mockLockService: {
      acquireLock: vi.fn(),
      acquireLockWithRetry: vi.fn(),
      releaseLock: vi.fn(),
    },
  };
});

vi.mock("../services/db.js", () => ({
  prisma: mockPrisma,
}));

vi.mock("../services/stellarService.js", () => ({
  stellarService: mockStellarService,
}));

vi.mock("../services/lockService.js", () => ({
  lockService: mockLockService,
}));

vi.mock("../config/env.js", () => ({
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  CONTRACT_ID: "C1234567890",
}));

import { claimSagaService } from "../services/claimSagaService.js";
import { SagaStatus } from "@prisma/client";

// Build a real valid Stellar transaction to use in XDR parsing
const keypair = Keypair.random();
const destinationKeypair = Keypair.random();
const account = new Account(keypair.publicKey(), "123");
const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: "Test SDF Network ; September 2015",
})
  .addOperation(
    Operation.payment({
      destination: destinationKeypair.publicKey(),
      asset: Asset.native(),
      amount: "1",
    })
  )
  .setTimeout(30)
  .build();

const validUnsignedXdr = tx.toXDR();
const txHash = tx.hash().toString("hex");

tx.sign(keypair);
const validSignedXdr = tx.toXDR();

describe("ClaimSagaService", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLockService.acquireLockWithRetry.mockResolvedValue("token-123");
    mockLockService.releaseLock.mockResolvedValue(true);
  });

  describe("prepareClaim", () => {
    it("successfully prepares a claim when balance is > 0 and no active sagas exist", async () => {
      mockPrisma.claimSaga.findMany.mockResolvedValue([]);
      mockStellarService.readClaimableBalance.mockResolvedValue(100n);
      mockStellarService.createClaimPayoutTransaction.mockResolvedValue(validUnsignedXdr);

      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        return await cb(mockPrisma);
      });

      const result = await claimSagaService.prepareClaim("org1", keypair.publicKey());

      expect(result.sagaId).toBe(txHash);
      expect(result.transactionXdr).toBe(validUnsignedXdr);
      expect(mockLockService.acquireLockWithRetry).toHaveBeenCalled();
      expect(mockPrisma.claimSaga.create).toHaveBeenCalledWith({
        data: {
          id: txHash,
          orgId: "org1",
          maintainerAddress: keypair.publicKey(),
          amountStroops: 100n,
          status: SagaStatus.PREPARED,
          unsignedXdr: validUnsignedXdr,
        },
      });
      expect(mockPrisma.sagaAuditLog.create).toHaveBeenCalled();
    });

    it("throws an error if balance is 0", async () => {
      mockPrisma.claimSaga.findMany.mockResolvedValue([]);
      mockStellarService.readClaimableBalance.mockResolvedValue(0n);

      await expect(
        claimSagaService.prepareClaim("org1", keypair.publicKey())
      ).rejects.toThrow("No claimable balance found");
    });

    it("supersedes existing PREPARED sagas", async () => {
      const oldSaga = {
        id: "old-hash",
        status: SagaStatus.PREPARED,
        createdAt: new Date(),
      };
      mockPrisma.claimSaga.findMany.mockResolvedValue([oldSaga]);
      mockStellarService.readClaimableBalance.mockResolvedValue(500n);
      mockStellarService.createClaimPayoutTransaction.mockResolvedValue(validUnsignedXdr);

      await claimSagaService.prepareClaim("org1", keypair.publicKey());

      expect(mockPrisma.claimSaga.update).toHaveBeenCalledWith({
        where: { id: "old-hash" },
        data: { status: SagaStatus.FAILED, errorMessage: "Superseded by a new prepare request" },
      });
    });

    it("throws if a saga is already in SUBMITTED state", async () => {
      const activeSaga = {
        id: "active-hash",
        status: SagaStatus.SUBMITTED,
        createdAt: new Date(),
      };
      mockPrisma.claimSaga.findMany.mockResolvedValue([activeSaga]);
      mockStellarService.readClaimableBalance.mockResolvedValue(500n);

      await expect(
        claimSagaService.prepareClaim("org1", keypair.publicKey())
      ).rejects.toThrow("A claim submission is already in progress");
    });
  });

  describe("submitClaim", () => {
    it("resolves from cache if status is SUCCESS", async () => {
      mockPrisma.claimSaga.findUnique.mockResolvedValue({
        id: txHash,
        status: SagaStatus.SUCCESS,
        txHash,
      });

      const result = await claimSagaService.submitClaim(validSignedXdr);

      expect(result).toEqual({ success: true, transactionHash: txHash });
      expect(mockLockService.acquireLockWithRetry).not.toHaveBeenCalled();
    });

    it("broadcasts transaction and updates status on success", async () => {
      mockPrisma.claimSaga.findUnique.mockResolvedValue({
        id: txHash,
        status: SagaStatus.PREPARED,
        unsignedXdr: validUnsignedXdr,
      });
      mockLockService.acquireLockWithRetry.mockResolvedValue("lock-token");
      mockStellarService.submitTransaction.mockResolvedValue({
        success: true,
        transactionHash: "on-chain-hash",
      });

      const result = await claimSagaService.submitClaim(validSignedXdr);

      expect(result).toEqual({ success: true, transactionHash: "on-chain-hash" });
      expect(mockPrisma.claimSaga.update).toHaveBeenCalledTimes(2); // PREPARED -> SUBMITTED, then SUBMITTED -> SUCCESS
      expect(mockPrisma.claimSaga.update).toHaveBeenLastCalledWith({
        where: { id: txHash },
        data: { status: SagaStatus.SUCCESS, txHash: "on-chain-hash" },
      });
      expect(mockLockService.releaseLock).toHaveBeenCalledWith(`lock:submit:${txHash}`, "lock-token");
    });

    it("marks saga as failed on definitive execution failure", async () => {
      mockPrisma.claimSaga.findUnique.mockResolvedValue({
        id: txHash,
        status: SagaStatus.PREPARED,
        unsignedXdr: validUnsignedXdr,
      });
      mockLockService.acquireLockWithRetry.mockResolvedValue("lock-token");
      mockStellarService.submitTransaction.mockRejectedValue(new Error("Contract reverted"));

      const result = await claimSagaService.submitClaim(validSignedXdr);

      expect(result).toEqual({ success: false, message: "Contract reverted" });
      expect(mockPrisma.claimSaga.update).toHaveBeenLastCalledWith({
        where: { id: txHash },
        data: { status: SagaStatus.FAILED, errorMessage: "Contract reverted" },
      });
    });
  });

  describe("recoverStalledSagas", () => {
    it("recovers stalled SUBMITTED sagas to SUCCESS if on-chain status is SUCCESS", async () => {
      const stalledSaga = {
        id: "stalled-id",
        txHash: "stalled-tx-hash",
        status: SagaStatus.SUBMITTED,
        updatedAt: new Date(Date.now() - 100000),
      };
      mockPrisma.claimSaga.findMany.mockResolvedValue([stalledSaga]);
      mockStellarService.getTransactionStatus.mockResolvedValue({
        status: "SUCCESS",
        success: true,
      });

      const result = await claimSagaService.recoverStalledSagas(60000);

      expect(result).toEqual({ processedCount: 1, successes: 1, failures: 0 });
      expect(mockPrisma.claimSaga.update).toHaveBeenCalledWith({
        where: { id: "stalled-id" },
        data: { status: SagaStatus.SUCCESS },
      });
    });

    it("recovers stalled SUBMITTED sagas to FAILED if on-chain status is FAILED", async () => {
      const stalledSaga = {
        id: "stalled-id",
        txHash: "stalled-tx-hash",
        status: SagaStatus.SUBMITTED,
        updatedAt: new Date(Date.now() - 100000),
      };
      mockPrisma.claimSaga.findMany.mockResolvedValue([stalledSaga]);
      mockStellarService.getTransactionStatus.mockResolvedValue({
        status: "FAILED",
        success: false,
      });

      const result = await claimSagaService.recoverStalledSagas(60000);

      expect(result).toEqual({ processedCount: 1, successes: 0, failures: 1 });
      expect(mockPrisma.claimSaga.update).toHaveBeenCalledWith({
        where: { id: "stalled-id" },
        data: { status: SagaStatus.FAILED, errorMessage: "On-chain execution failed" },
      });
    });
  });
});
