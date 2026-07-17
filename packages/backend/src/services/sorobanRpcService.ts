/**
 * @file sorobanRpcService.ts
 * @description Dedicated service module for Soroban RPC client initialization and management.
 *
 * This service abstracts the creation and configuration of SorobanRpc.Server instances,
 * providing a single source of truth for RPC connections across the backend.
 *
 * ## Key Responsibilities
 *
 * - Initialize and configure Soroban RPC client with appropriate settings
 * - Provide singleton access to the RPC server instance
 * - Handle environment-specific configuration (HTTP/HTTPS, URL)
 * - Centralize RPC client lifecycle management
 *
 * ## Design Rationale
 *
 * By abstracting RPC initialization into a dedicated module:
 * - Services can import a pre-configured RPC client without initialization logic
 * - Configuration changes are managed in one place
 * - Testing becomes easier via dependency injection
 * - Client lifecycle and connection pooling are centralized
 *
 * ## Usage
 *
 * ```typescript
 * import { getSorobanRpcClient } from './sorobanRpcService.js';
 *
 * const rpcServer = getSorobanRpcClient();
 * const events = await rpcServer.getEvents({ ... });
 * ```
 *
 * @see {@link https://developers.stellar.org/docs/tools/sdks/library/soroban-rpc|Soroban RPC Documentation}
 */

import { SorobanRpc } from "@stellar/stellar-sdk";
import { RPC_URL } from "../config/env.js";

/**
 * Configuration options for Soroban RPC client initialization.
 */
interface SorobanRpcConfig {
  /** The Soroban RPC endpoint URL */
  url: string;
  /** Whether to allow HTTP connections (should only be true for local development) */
  allowHttp: boolean;
}

/**
 * Singleton instance of the Soroban RPC server.
 * Initialized lazily on first access via getSorobanRpcClient().
 */
let rpcServerInstance: SorobanRpc.Server | null = null;

/**
 * Creates a new Soroban RPC server instance with the provided configuration.
 *
 * @param config - Configuration options for the RPC client
 * @returns A configured SorobanRpc.Server instance
 * @internal
 */
function createSorobanRpcServer(config: SorobanRpcConfig): SorobanRpc.Server {
  return new SorobanRpc.Server(config.url, {
    allowHttp: config.allowHttp,
  });
}

/**
 * Determines the RPC configuration from environment variables.
 *
 * Security Note:
 * - allowHttp is only true when RPC_URL explicitly starts with "http://"
 * - Production deployments should always use HTTPS
 * - Local development against local Stellar quickstart may use HTTP
 *
 * @returns Configuration object for Soroban RPC client
 * @internal
 */
function getSorobanRpcConfig(): SorobanRpcConfig {
  if (!RPC_URL) {
    throw new Error(
      "RPC_URL environment variable is required. Please configure it in your .env file."
    );
  }

  return {
    url: RPC_URL,
    allowHttp: RPC_URL.startsWith("http://"),
  };
}

/**
 * Gets the singleton Soroban RPC client instance.
 *
 * On first call, this function initializes the RPC client using configuration
 * from environment variables. Subsequent calls return the cached instance.
 *
 * Thread Safety:
 * - The singleton pattern is safe in Node.js's single-threaded event loop
 * - Multiple concurrent calls during initialization will share the same instance
 *
 * @returns The configured SorobanRpc.Server instance
 * @throws {Error} If RPC_URL is not configured in environment variables
 *
 * @example
 * ```typescript
 * const rpcServer = getSorobanRpcClient();
 * const ledger = await rpcServer.getLatestLedger();
 * ```
 */
export function getSorobanRpcClient(): SorobanRpc.Server {
  if (!rpcServerInstance) {
    const config = getSorobanRpcConfig();
    rpcServerInstance = createSorobanRpcServer(config);
  }
  return rpcServerInstance;
}

/**
 * Resets the singleton RPC client instance.
 *
 * This is primarily useful for testing scenarios where you need to reset
 * the client state or when switching configurations at runtime.
 *
 * ⚠️  Warning: Use with caution in production. Resetting the client will
 * force re-initialization on the next getSorobanRpcClient() call.
 *
 * @internal
 */
export function resetSorobanRpcClient(): void {
  rpcServerInstance = null;
}

/**
 * Creates a new Soroban RPC client with custom configuration.
 *
 * Unlike getSorobanRpcClient(), this function creates a new instance every time
 * it's called and does not use the singleton. This is useful for scenarios where
 * you need multiple RPC clients with different configurations.
 *
 * @param url - The Soroban RPC endpoint URL
 * @param allowHttp - Whether to allow HTTP connections (default: false)
 * @returns A new SorobanRpc.Server instance
 *
 * @example
 * ```typescript
 * // Create a custom client for a specific testnet
 * const customRpc = createCustomSorobanRpcClient(
 *   'https://soroban-testnet.stellar.org',
 *   false
 * );
 * ```
 */
export function createCustomSorobanRpcClient(
  url: string,
  allowHttp: boolean = false
): SorobanRpc.Server {
  return createSorobanRpcServer({ url, allowHttp });
}

/**
 * Re-export SorobanRpc namespace for convenience.
 * This allows consumers to access SorobanRpc types without importing from stellar-sdk directly.
 */
export { SorobanRpc };
