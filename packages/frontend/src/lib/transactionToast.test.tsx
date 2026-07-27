import { describe, it, expect, vi, beforeEach } from "vitest";
import { toastTransaction } from "./transactionToast";
import { toast } from "sonner";
import React from "react";

// Mock the sonner toast module
vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("transactionToast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
  });

  describe("pending", () => {
    it("should call toast.loading with the default message", () => {
      toastTransaction.pending();
      expect(toast.loading).toHaveBeenCalledWith("Transaction pending...", undefined);
    });

    it("should call toast.loading with a custom message", () => {
      toastTransaction.pending("Deploying...");
      expect(toast.loading).toHaveBeenCalledWith("Deploying...", undefined);
    });
  });

  describe("success", () => {
    it("should call toast.success without a transaction hash", () => {
      toastTransaction.success("Done!");
      expect(toast.success).toHaveBeenCalledWith("Done!", undefined);
    });

    it("should call toast.success with a transaction hash link", () => {
      toastTransaction.success("Done!", "0x123abc");
      expect(toast.success).toHaveBeenCalled();
      
      const callArgs = vi.mocked(toast.success).mock.calls[0]!;
      const reactElement = callArgs[0] as React.ReactElement;
      
      // Verify it passes the correct props to the TransactionLink component
      expect(reactElement.type).toBeTypeOf("function");
      expect(reactElement.props.message).toBe("Done!");
      expect(reactElement.props.hash).toBe("0x123abc");
    });
    
    it("should handle public network links if configured", () => {
      process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";
      toastTransaction.success("Done!", "0x456def");
      expect(toast.success).toHaveBeenCalled();
      
      const callArgs = vi.mocked(toast.success).mock.calls[0]!;
      const reactElement = callArgs[0] as React.ReactElement;
      expect(reactElement.props.hash).toBe("0x456def");
    });
  });

  describe("error", () => {
    it("should handle standard Error objects", () => {
      toastTransaction.error(new Error("Something broke"));
      expect(toast.error).toHaveBeenCalledWith("Something broke", undefined);
    });

    it("should handle string errors", () => {
      toastTransaction.error("A string error");
      expect(toast.error).toHaveBeenCalledWith("A string error", undefined);
    });

    it("should use the fallback message for unknown error types", () => {
      toastTransaction.error({ foo: "bar" }, "Fallback error");
      expect(toast.error).toHaveBeenCalledWith("Fallback error", undefined);
    });
  });

  describe("promise", () => {
    it("should handle a resolving promise", async () => {
      vi.mocked(toast.loading).mockReturnValue("toast-id");
      const fakePromise = Promise.resolve({ txHash: "0xabc" });

      const result = await toastTransaction.promise(fakePromise, {
        loading: "Loading...",
        success: "Success!",
        getHash: (data) => data.txHash,
      });

      expect(result).toEqual({ txHash: "0xabc" });
      expect(toast.loading).toHaveBeenCalledWith("Loading...");
      
      expect(toast.success).toHaveBeenCalled();
      const callArgs = vi.mocked(toast.success).mock.calls[0]!;
      const reactElement = callArgs[0] as React.ReactElement;
      expect(reactElement.props.hash).toBe("0xabc");
      expect(callArgs[1]).toEqual({ id: "toast-id" });
    });

    it("should handle a rejecting promise", async () => {
      vi.mocked(toast.loading).mockReturnValue("toast-id");
      const fakePromise = Promise.reject(new Error("Failed"));

      await expect(toastTransaction.promise(fakePromise, {
        error: "Custom error fallback",
      })).rejects.toThrow("Failed");

      expect(toast.loading).toHaveBeenCalledWith("Transaction pending...");
      expect(toast.error).toHaveBeenCalledWith("Custom error fallback", { id: "toast-id" });
    });
  });
});
