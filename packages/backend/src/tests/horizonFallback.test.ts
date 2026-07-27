import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── isFallbackEligibleError (imported directly, no mock needed) ──────────────

describe("isFallbackEligibleError", () => {
  // We test the real implementation by importing it after a targeted mock
  // of only the Horizon SDK (which is not needed for this function).
  let isFallbackEligibleError: (error: unknown) => boolean;

  beforeEach(async () => {
    vi.resetModules();
    // Mock only the Horizon SDK to avoid network calls; the function under test
    // does not touch the SDK at all.
    vi.doMock("@stellar/stellar-sdk", () => ({
      Horizon: { Server: vi.fn() },
      xdr: {},
    }));
    const mod = await import("../utils/horizonFallback.js");
    isFallbackEligibleError = mod.isFallbackEligibleError;
  });

  it("returns false for null/undefined", () => {
    expect(isFallbackEligibleError(null)).toBe(false);
    expect(isFallbackEligibleError(undefined)).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isFallbackEligibleError("string")).toBe(false);
    expect(isFallbackEligibleError(42)).toBe(false);
  });

  it("returns true for ECONNREFUSED", () => {
    expect(isFallbackEligibleError({ code: "ECONNREFUSED" })).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    expect(isFallbackEligibleError({ code: "ECONNRESET" })).toBe(true);
  });

  it("returns true for ETIMEDOUT", () => {
    expect(isFallbackEligibleError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("returns true for ENOTFOUND", () => {
    expect(isFallbackEligibleError({ code: "ENOTFOUND" })).toBe(true);
  });

  it("returns true for EAI_AGAIN", () => {
    expect(isFallbackEligibleError({ code: "EAI_AGAIN" })).toBe(true);
  });

  it("returns true for 5xx status codes", () => {
    expect(isFallbackEligibleError({ response: { status: 500 } })).toBe(true);
    expect(isFallbackEligibleError({ response: { status: 502 } })).toBe(true);
    expect(isFallbackEligibleError({ response: { status: 503 } })).toBe(true);
    expect(isFallbackEligibleError({ response: { status: 504 } })).toBe(true);
  });

  it("returns true for 429 rate limit", () => {
    expect(isFallbackEligibleError({ response: { status: 429 } })).toBe(true);
  });

  it("returns false for non-eligible 4xx status codes", () => {
    expect(isFallbackEligibleError({ response: { status: 400 } })).toBe(false);
    expect(isFallbackEligibleError({ response: { status: 401 } })).toBe(false);
    expect(isFallbackEligibleError({ response: { status: 403 } })).toBe(false);
    expect(isFallbackEligibleError({ response: { status: 404 } })).toBe(false);
    expect(isFallbackEligibleError({ response: { status: 422 } })).toBe(false);
  });

  it("returns true for timeout-related messages", () => {
    expect(isFallbackEligibleError({ message: "Request timeout" })).toBe(true);
    expect(isFallbackEligibleError({ message: "Connection timed out" })).toBe(true);
    // ETIMEDOUT as error code is caught by the code check, not the message check
    expect(isFallbackEligibleError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("returns true for network error messages", () => {
    expect(isFallbackEligibleError({ message: "Network error occurred" })).toBe(true);
    expect(isFallbackEligibleError({ message: "fetch failed" })).toBe(true);
  });

  it("returns false for application-level errors", () => {
    expect(isFallbackEligibleError({ message: "Simulation failed: budget exceeded" })).toBe(false);
    expect(isFallbackEligibleError({ message: "Transaction error: insufficient funds" })).toBe(false);
  });
});

// ─── HorizonFallbackProvider ─────────────────────────────────────────────────

describe("HorizonFallbackProvider", () => {
  // We test the provider by mocking the Horizon SDK at the constructor level
  // and verifying that the provider correctly delegates to Horizon API methods.
  let HorizonFallbackProvider: any;
  let mockLedgersCall: ReturnType<typeof vi.fn>;
  let mockTxCall: ReturnType<typeof vi.fn>;
  let mockSubmitTransaction: ReturnType<typeof vi.fn>;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockLedgersCall = vi.fn();
    mockTxCall = vi.fn();
    mockSubmitTransaction = vi.fn();
    mockFetch = vi.fn();

    // Mock the Horizon SDK
    vi.doMock("@stellar/stellar-sdk", () => ({
      Horizon: {
        Server: vi.fn().mockImplementation(() => ({
          serverURL: "https://horizon-testnet.stellar.org",
          ledgers: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            call: mockLedgersCall,
          }),
          transactions: vi.fn().mockReturnValue({
            transaction: vi.fn().mockReturnThis(),
            call: mockTxCall,
          }),
          submitTransaction: mockSubmitTransaction,
        })),
      },
      xdr: {},
    }));

    // Mock global fetch for getHealth and string submitTransaction
    global.fetch = mockFetch as typeof global.fetch;

    const mod = await import("../utils/horizonFallback.js");
    HorizonFallbackProvider = mod.HorizonFallbackProvider;
  });

  describe("getLatestLedger", () => {
    it("returns the latest ledger sequence on success", async () => {
      mockLedgersCall.mockResolvedValue({ records: [{ sequence: 12345 }] });
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.getLatestLedger();

      expect(result).toEqual({
        ok: true,
        value: { sequence: 12345 },
        source: "horizon",
      });
    });

    it("returns ok: false when no records are returned", async () => {
      mockLedgersCall.mockResolvedValue({ records: [] });
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.getLatestLedger();
      expect(result).toEqual({ ok: false, source: "horizon" });
    });

    it("returns ok: false on network error", async () => {
      mockLedgersCall.mockRejectedValue(new Error("ECONNREFUSED"));
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.getLatestLedger();
      expect(result).toEqual({ ok: false, source: "horizon" });
    });
  });

  describe("getTransaction", () => {
    it("returns SUCCESS status for a successful transaction", async () => {
      mockTxCall.mockResolvedValue({ successful: true });
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.getTransaction("abc123");

      expect(result).toEqual({
        ok: true,
        value: { status: "SUCCESS" },
        source: "horizon",
      });
    });

    it("returns FAILED status for a failed transaction", async () => {
      mockTxCall.mockResolvedValue({ successful: false });
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.getTransaction("abc123");

      expect(result).toEqual({
        ok: true,
        value: { status: "FAILED" },
        source: "horizon",
      });
    });

    it("returns NOT_FOUND for 404 errors", async () => {
      const error: any = new Error("Not found");
      error.response = { status: 404 };
      mockTxCall.mockRejectedValue(error);
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.getTransaction("abc123");

      expect(result).toEqual({
        ok: true,
        value: { status: "NOT_FOUND" },
        source: "horizon",
      });
    });

    it("returns ok: false on network error", async () => {
      mockTxCall.mockRejectedValue(new Error("ECONNREFUSED"));
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.getTransaction("abc123");
      expect(result).toEqual({ ok: false, source: "horizon" });
    });
  });

  describe("submitTransaction", () => {
    it("returns success hash on successful Horizon SDK submission", async () => {
      mockSubmitTransaction.mockResolvedValue({
        hash: "tx_hash_123",
        successful: true,
      });
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      // Pass a Transaction-like object (not a string) to use the SDK path
      const mockTx = { toXDR: () => "xdr_data" } as any;
      const result = await provider.submitTransaction(mockTx);

      expect(result).toEqual({
        ok: true,
        value: { hash: "tx_hash_123", status: "SUCCESS" },
        source: "horizon",
      });
    });

    it("uses fetch for string XDR submissions", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hash: "tx_hash_456", successful: true }),
      });
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.submitTransaction("signed_xdr_string");

      expect(result).toEqual({
        ok: true,
        value: { hash: "tx_hash_456", status: "SUCCESS" },
        source: "horizon",
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://horizon-testnet.stellar.org/transactions",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("returns the hash even when Horizon reports a failure via SDK", async () => {
      const error: any = new Error("Transaction failed");
      error.response = {
        data: { hash: "tx_hash_789", status: "FAILED" },
      };
      mockSubmitTransaction.mockRejectedValue(error);
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const mockTx = { toXDR: () => "xdr_data" } as any;
      const result = await provider.submitTransaction(mockTx);

      expect(result).toEqual({
        ok: true,
        value: { hash: "tx_hash_789", status: "FAILED" },
        source: "horizon",
      });
    });

    it("returns ok: false on network error without error data", async () => {
      mockSubmitTransaction.mockRejectedValue(new Error("ECONNREFUSED"));
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const mockTx = { toXDR: () => "xdr_data" } as any;
      const result = await provider.submitTransaction(mockTx);
      expect(result).toEqual({ ok: false, source: "horizon" });
    });
  });

  describe("getHealth", () => {
    it("returns ok status when Horizon root is reachable", async () => {
      mockFetch.mockResolvedValue({ ok: true });
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.getHealth();

      expect(result).toEqual({
        ok: true,
        value: { status: "ok" },
        source: "horizon",
      });
    });

    it("returns ok: false on network error", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.getHealth();
      expect(result).toEqual({ ok: false, source: "horizon" });
    });

    it("returns ok: false when response is not ok", async () => {
      mockFetch.mockResolvedValue({ ok: false });
      const provider = new HorizonFallbackProvider({
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const result = await provider.getHealth();
      expect(result).toEqual({ ok: false, source: "horizon" });
    });
  });
});
