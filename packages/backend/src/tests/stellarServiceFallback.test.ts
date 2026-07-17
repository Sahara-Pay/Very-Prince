import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Fallback Provider ──────────────────────────────────────────────────

const mockFallbackInstance = {
  getLatestLedger: vi.fn(),
  getTransaction: vi.fn(),
  submitTransaction: vi.fn(),
  getHealth: vi.fn(),
};

// ─── Module Mocks ────────────────────────────────────────────────────────────

vi.mock("../config/env.js", () => ({
  CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADN2S",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  RPC_URL: "https://soroban-testnet.stellar.org",
  HORIZON_FALLBACK_URL: "https://horizon-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
}));

vi.mock("../utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<any>) => fn()),
}));

vi.mock("../utils/horizonFallback.js", () => ({
  isFallbackEligibleError: vi.fn((err: any) => {
    if (!err || typeof err !== "object") return false;
    const code = err.code;
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") return true;
    const status = err.response?.status ?? err.status;
    if (typeof status === "number" && status >= 500) return true;
    if (status === 429) return true;
    const msg = (err.message ?? "").toLowerCase();
    if (msg.includes("timeout") || msg.includes("timed out")) return true;
    if (msg.includes("fetch failed")) return true;
    return false;
  }),
  HorizonFallbackProvider: vi.fn().mockImplementation(() => mockFallbackInstance),
}));

vi.mock("../utils/xdrDecoder.js", () => ({
  decodeI128ToBigInt: vi.fn(),
  stroopsToXlm: vi.fn((stroops: string | bigint) => {
    const val = typeof stroops === "string" ? Number(BigInt(stroops)) : Number(stroops);
    return (val / 10_000_000).toFixed(7);
  }),
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("StellarService Horizon fallback integration", () => {
  let StellarService: any;

  beforeEach(async () => {
    // Reset module cache to ensure fresh StellarService instances
    vi.resetModules();

    // Clear mock call history and implementations
    mockFallbackInstance.getLatestLedger.mockReset();
    mockFallbackInstance.getTransaction.mockReset();
    mockFallbackInstance.submitTransaction.mockReset();
    mockFallbackInstance.getHealth.mockReset();

    // Re-apply module mocks after reset
    vi.doMock("../config/env.js", () => ({
      CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADN2S",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
      RPC_URL: "https://soroban-testnet.stellar.org",
      HORIZON_FALLBACK_URL: "https://horizon-testnet.stellar.org",
      NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    }));
    vi.doMock("../utils/retry.js", () => ({
      withRetry: vi.fn(async (fn: () => Promise<any>) => fn()),
    }));
    vi.doMock("../utils/horizonFallback.js", () => ({
      isFallbackEligibleError: vi.fn((err: any) => {
        if (!err || typeof err !== "object") return false;
        const code = err.code;
        if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") return true;
        const status = err.response?.status ?? err.status;
        if (typeof status === "number" && status >= 500) return true;
        if (status === 429) return true;
        const msg = (err.message ?? "").toLowerCase();
        if (msg.includes("timeout") || msg.includes("timed out")) return true;
        if (msg.includes("fetch failed")) return true;
        return false;
      }),
      HorizonFallbackProvider: vi.fn().mockImplementation(() => mockFallbackInstance),
    }));
    vi.doMock("../utils/xdrDecoder.js", () => ({
      decodeI128ToBigInt: vi.fn(),
      stroopsToXlm: vi.fn((stroops: string | bigint) => {
        const val = typeof stroops === "string" ? Number(BigInt(stroops)) : Number(stroops);
        return (val / 10_000_000).toFixed(7);
      }),
    }));

    const mod = await import("../services/stellarService.js");
    StellarService = mod.StellarService;
  });

  describe("getLatestLedger", () => {
    it("uses Soroban RPC when RPC is available", async () => {
      const service = new StellarService();
      const rpcServer = (service as any).rpcServer;
      rpcServer.getLatestLedger = vi.fn().mockResolvedValue({ sequence: 42 });

      const result = await service.getLatestLedger();

      expect(result).toBe(42);
      expect(rpcServer.getLatestLedger).toHaveBeenCalled();
      expect(mockFallbackInstance.getLatestLedger).not.toHaveBeenCalled();
    });

    it("falls back to Horizon when RPC fails with eligible error", async () => {
      const service = new StellarService();
      const rpcServer = (service as any).rpcServer;
      rpcServer.getLatestLedger = vi.fn().mockRejectedValue(
        Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })
      );

      mockFallbackInstance.getLatestLedger.mockResolvedValue({
        ok: true,
        value: { sequence: 99 },
        source: "horizon",
      });

      const result = await service.getLatestLedger();

      expect(result).toBe(99);
      expect(mockFallbackInstance.getLatestLedger).toHaveBeenCalled();
    });

    it("throws original error when RPC error is not eligible for fallback", async () => {
      const service = new StellarService();
      const rpcServer = (service as any).rpcServer;
      rpcServer.getLatestLedger = vi.fn().mockRejectedValue(
        new Error("Simulation failed: budget exceeded")
      );

      await expect(service.getLatestLedger()).rejects.toThrow(
        "Simulation failed: budget exceeded"
      );
      expect(mockFallbackInstance.getLatestLedger).not.toHaveBeenCalled();
    });
  });

  describe("submitTransaction with fallback", () => {
    it("uses Soroban RPC when available", async () => {
      const service = new StellarService();
      const rpcServer = (service as any).rpcServer;

      rpcServer.sendTransaction = vi.fn().mockResolvedValue({
        hash: "tx_hash_1",
        status: "PENDING",
      });
      rpcServer.getTransaction = vi.fn().mockResolvedValue({
        status: "SUCCESS",
      });

      const horizon = (service as any).horizon;
      horizon.loadAccount = vi.fn().mockResolvedValue({
        id: "GABC",
        sequenceNumber: () => "1",
      });

      const sdk = await import("@stellar/stellar-sdk");
      const mockXdr = "AAAAAgAAAADfsdfsd==";
      const mockTx = {
        toXDR: () => mockXdr,
        sign: vi.fn(),
        hash: () => "tx_hash_1",
      };
      vi.spyOn(sdk.TransactionBuilder, "fromXDR").mockReturnValue(mockTx as any);

      const result = await service.submitTransaction(mockXdr);

      expect(result.success).toBe(true);
      expect(rpcServer.sendTransaction).toHaveBeenCalled();
    });

    it("falls back to Horizon when RPC sendTransaction fails", async () => {
      const service = new StellarService();
      const rpcServer = (service as any).rpcServer;

      rpcServer.sendTransaction = vi.fn().mockRejectedValue(
        Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })
      );

      mockFallbackInstance.submitTransaction.mockResolvedValue({
        ok: true,
        value: { hash: "horizon_tx_hash", status: "SUCCESS" },
        source: "horizon",
      });

      mockFallbackInstance.getTransaction.mockResolvedValue({
        ok: true,
        value: { status: "SUCCESS" },
        source: "horizon",
      });

      // Mock getTransaction on RPC for the polling loop
      rpcServer.getTransaction = vi.fn().mockResolvedValue({
        status: "SUCCESS",
      });

      const horizon = (service as any).horizon;
      horizon.loadAccount = vi.fn().mockResolvedValue({
        id: "GABC",
        sequenceNumber: () => "1",
      });

      const sdk = await import("@stellar/stellar-sdk");
      const mockXdr = "AAAAAgAAAADfsdfsd==";
      const mockTx = {
        toXDR: () => mockXdr,
        sign: vi.fn(),
        hash: () => "horizon_tx_hash",
      };
      vi.spyOn(sdk.TransactionBuilder, "fromXDR").mockReturnValue(mockTx as any);

      const result = await service.submitTransaction(mockXdr);

      expect(result.success).toBe(true);
      expect(result.transactionHash).toBe("horizon_tx_hash");
      expect(mockFallbackInstance.submitTransaction).toHaveBeenCalled();
    });

    it("throws original error when both RPC and fallback fail", async () => {
      const service = new StellarService();
      const rpcServer = (service as any).rpcServer;

      rpcServer.sendTransaction = vi.fn().mockRejectedValue(
        Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })
      );

      mockFallbackInstance.submitTransaction.mockResolvedValue({
        ok: false,
        source: "horizon",
      });

      // Mock getTransaction on RPC for the polling loop
      rpcServer.getTransaction = vi.fn().mockResolvedValue({
        status: "SUCCESS",
      });

      const horizon = (service as any).horizon;
      horizon.loadAccount = vi.fn().mockResolvedValue({
        id: "GABC",
        sequenceNumber: () => "1",
      });

      const sdk = await import("@stellar/stellar-sdk");
      const mockXdr = "AAAAAgAAAADfsdfsd==";
      const mockTx = {
        toXDR: () => mockXdr,
        sign: vi.fn(),
        hash: () => "horizon_tx_hash",
      };
      vi.spyOn(sdk.TransactionBuilder, "fromXDR").mockReturnValue(mockTx as any);

      await expect(service.submitTransaction(mockXdr)).rejects.toThrow("ECONNREFUSED");
    });
  });
});
