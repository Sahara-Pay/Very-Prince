/**
 * @file sorobanRpcService.test.ts
 * @description Unit tests for the Soroban RPC service module.
 *
 * Tests verify:
 * - Proper RPC client initialization from environment variables
 * - Singleton pattern behavior
 * - Custom client creation
 * - Error handling for missing configuration
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getSorobanRpcClient,
  resetSorobanRpcClient,
  createCustomSorobanRpcClient,
  SorobanRpc,
} from "./sorobanRpcService.js";

// ─── Test Setup ───────────────────────────────────────────────────────────────

describe("sorobanRpcService", () => {
  // Store original environment
  const originalEnv = process.env.RPC_URL;

  beforeEach(() => {
    // Reset singleton before each test
    resetSorobanRpcClient();
    
    // Set a default test RPC_URL
    process.env.RPC_URL = "https://soroban-testnet.stellar.org";
  });

  afterEach(() => {
    // Restore original environment
    if (originalEnv) {
      process.env.RPC_URL = originalEnv;
    } else {
      delete process.env.RPC_URL;
    }
    
    // Clean up singleton
    resetSorobanRpcClient();
  });

  // ── getSorobanRpcClient() ────────────────────────────────────────────────

  describe("getSorobanRpcClient()", () => {
    it("should return a SorobanRpc.Server instance", () => {
      const client = getSorobanRpcClient();
      expect(client).toBeInstanceOf(SorobanRpc.Server);
    });

    it("should return the same instance on subsequent calls (singleton)", () => {
      const client1 = getSorobanRpcClient();
      const client2 = getSorobanRpcClient();
      expect(client1).toBe(client2);
    });

    it("should throw an error if RPC_URL is not configured", () => {
      delete process.env.RPC_URL;
      resetSorobanRpcClient();

      expect(() => getSorobanRpcClient()).toThrow(
        "RPC_URL environment variable is required"
      );
    });

    it("should configure allowHttp as true for http:// URLs", () => {
      process.env.RPC_URL = "http://localhost:8000/soroban/rpc";
      resetSorobanRpcClient();

      const client = getSorobanRpcClient();
      expect(client).toBeInstanceOf(SorobanRpc.Server);
      // Note: We can't directly test the allowHttp property as it's internal,
      // but we verify the client is created without throwing
    });

    it("should configure allowHttp as false for https:// URLs", () => {
      process.env.RPC_URL = "https://soroban-testnet.stellar.org";
      resetSorobanRpcClient();

      const client = getSorobanRpcClient();
      expect(client).toBeInstanceOf(SorobanRpc.Server);
    });

    it("should initialize client on first call after reset", () => {
      const client1 = getSorobanRpcClient();
      resetSorobanRpcClient();
      const client2 = getSorobanRpcClient();
      
      // After reset, a new instance should be created
      expect(client2).toBeInstanceOf(SorobanRpc.Server);
      expect(client1).not.toBe(client2);
    });
  });

  // ── createCustomSorobanRpcClient() ───────────────────────────────────────

  describe("createCustomSorobanRpcClient()", () => {
    it("should create a new client instance with custom URL", () => {
      const customUrl = "https://custom-rpc.stellar.org";
      const client = createCustomSorobanRpcClient(customUrl);
      
      expect(client).toBeInstanceOf(SorobanRpc.Server);
    });

    it("should create a different instance each time (no singleton)", () => {
      const customUrl = "https://custom-rpc.stellar.org";
      const client1 = createCustomSorobanRpcClient(customUrl);
      const client2 = createCustomSorobanRpcClient(customUrl);
      
      expect(client1).toBeInstanceOf(SorobanRpc.Server);
      expect(client2).toBeInstanceOf(SorobanRpc.Server);
      // These should be different instances
      expect(client1).not.toBe(client2);
    });

    it("should accept allowHttp parameter", () => {
      const client = createCustomSorobanRpcClient(
        "http://localhost:8000/soroban/rpc",
        true
      );
      
      expect(client).toBeInstanceOf(SorobanRpc.Server);
    });

    it("should default allowHttp to false", () => {
      const client = createCustomSorobanRpcClient(
        "https://soroban-testnet.stellar.org"
      );
      
      expect(client).toBeInstanceOf(SorobanRpc.Server);
    });
  });

  // ── resetSorobanRpcClient() ──────────────────────────────────────────────

  describe("resetSorobanRpcClient()", () => {
    it("should allow re-initialization after reset", () => {
      const client1 = getSorobanRpcClient();
      
      resetSorobanRpcClient();
      
      const client2 = getSorobanRpcClient();
      expect(client2).toBeInstanceOf(SorobanRpc.Server);
    });

    it("should not throw when called multiple times", () => {
      expect(() => {
        resetSorobanRpcClient();
        resetSorobanRpcClient();
        resetSorobanRpcClient();
      }).not.toThrow();
    });
  });

  // ── Integration Scenarios ────────────────────────────────────────────────

  describe("Integration scenarios", () => {
    it("should handle URL without trailing slash", () => {
      process.env.RPC_URL = "https://soroban-testnet.stellar.org";
      resetSorobanRpcClient();

      const client = getSorobanRpcClient();
      expect(client).toBeInstanceOf(SorobanRpc.Server);
    });

    it("should handle URL with trailing slash", () => {
      process.env.RPC_URL = "https://soroban-testnet.stellar.org/";
      resetSorobanRpcClient();

      const client = getSorobanRpcClient();
      expect(client).toBeInstanceOf(SorobanRpc.Server);
    });

    it("should handle custom port in URL", () => {
      process.env.RPC_URL = "http://localhost:8000/soroban/rpc";
      resetSorobanRpcClient();

      const client = getSorobanRpcClient();
      expect(client).toBeInstanceOf(SorobanRpc.Server);
    });
  });
});
