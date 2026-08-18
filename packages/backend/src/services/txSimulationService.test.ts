import { describe, it, expect, vi, beforeEach } from "vitest";
import { simulateTransactionDryRun } from "./txSimulationService.js";

vi.mock("./sorobanRpcService.js", () => ({
  getSorobanRpcClient: () => ({
    simulateTransaction: vi.fn(),
  }),
}));

vi.mock("../utils/retry.js", () => ({
  withRetry: async <T>(fn: () => Promise<T>) => fn(),
}));

import { getSorobanRpcClient } from "./sorobanRpcService.js";

describe("txSimulationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects empty input", async () => {
    const result = await simulateTransactionDryRun({ transactionXdr: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("empty_input");
    }
  });

  it("rejects whitespace-only input", async () => {
    const result = await simulateTransactionDryRun({ transactionXdr: "   " });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("empty_input");
    }
  });

  it("rejects malformed XDR", async () => {
    const result = await simulateTransactionDryRun({
      transactionXdr: "not-valid-xdr",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("malformed_xdr");
    }
  });

  it("rejects short invalid base64 that is not a valid envelope", async () => {
    const result = await simulateTransactionDryRun({
      transactionXdr: "AAAAAg==",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("malformed_xdr");
    }
  });

  it("does not call RPC when XDR is invalid", async () => {
    const rpc = getSorobanRpcClient() as {
      simulateTransaction: ReturnType<typeof vi.fn>;
    };
    await simulateTransactionDryRun({ transactionXdr: "garbage" });
    expect(rpc.simulateTransaction).not.toHaveBeenCalled();
  });
});
