/**
 * @file useUnifiedWallet.ts
 * @description Unified wallet hook that consolidates all wallet-related functionality using XState FSM.
 * 
 * This hook provides a single, clean API for all wallet interactions including:
 * - Connection management via XState state machine
 * - Multi-wallet discovery via EIP-6963
 * - Transaction signing with hardware wallet timeout handling
 * - Auth message signing (SIWS)
 * - Payout claiming
 * - Error handling and loading states
 * 
 * This replaces the previous boolean-flag-based implementation with a robust FSM
 * that prevents race conditions and impossible UI states.
 */

import { useCallback } from "react";
import { useWallet } from "../contexts/WalletContext";
import { toast } from "sonner";
import { toastTransaction } from "../lib/transactionToast";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnifiedWalletState {
  /** True once the wallet context has been initialized. */
  isInitialized: boolean;
  /** True if a wallet extension is installed in the browser. */
  isInstalled: boolean;
  /** True if the user has connected their wallet to this page. */
  isConnected: boolean;
  /** The connected Stellar public key (G...), or null if not connected. */
  publicKey: string | null;
  /** True while a connection request or sign request is in flight. */
  isLoading: boolean;
  /** True while a transaction is being signed/processed. */
  isSigning: boolean;
  /** Last error message, if any. */
  error: string | null;
  /** Current network (public or testnet). */
  network: 'public' | 'testnet';
  /** True if connected to wrong network. */
  isWrongNetwork: boolean;
  /** True while waiting on hardware wallet response. */
  isHardwareTimeout: boolean;
  /** Available wallet providers discovered via EIP-6963. */
  providers: Array<{ rdns: string; name: string; icon?: string }>;
}

export interface WalletActions {
  /** Initiate a wallet connection request. */
  connect: () => Promise<void>;
  /** Disconnect (clear local state — wallets have no programmatic logout). */
  disconnect: () => void;
  /**
   * Request the wallet to sign a transaction XDR.
   * @param transactionXdr — Base64-encoded unsigned transaction XDR.
   * @returns Base64-encoded signed transaction XDR.
   */
  signTransaction: (transactionXdr: string) => Promise<string>;
  /**
   * Request the wallet to sign an authentication message (SIWS).
   * @param message — The message to sign.
   * @returns The signature.
   */
  signAuthMessage: (message: string) => Promise<string>;
  /**
   * Claim a payout for a specific organization.
   * @param orgId — The organization ID to claim payout from.
   * @returns The transaction result.
   */
  claimPayout: (orgId: string) => Promise<any>;
  /** Select a specific wallet provider from discovered providers. */
  selectWallet: (rdns: string) => void;
  /** Retry connection after hardware wallet timeout. */
  retryConnection: () => void;
  /** Cancel pending hardware wallet operation. */
  cancelHardwareWait: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Returns the current wallet state and interaction callbacks.
 * This is the unified API for all wallet interactions, backed by XState FSM.
 * 
 * This hook wraps the WalletContext (which uses the XState walletMachine)
 * to provide the same API as the previous boolean-flag implementation,
 * but with robust state management that prevents race conditions.
 */
export function useUnifiedWallet(): UnifiedWalletState & WalletActions {
  const walletContext = useWallet();

  // ── Derived state from XState machine ────────────────────────────────────

  const isInstalled = walletContext.providers.length > 0;
  const isSigning = walletContext.isLoading && walletContext.isConnected;
  
  // ── Sign Auth Message ─────────────────────────────────────────────────────

  const signAuthMessage = useCallback(
    async (message: string): Promise<string> => {
      if (!walletContext.isConnected || !walletContext.publicKey) {
        throw new Error("Wallet is not connected. Call connect() first.");
      }

      try {
        // Use the wallet adapter to sign the message
        // This will be handled by the selected wallet provider
        const freighter = (window as any).freighter;
        
        if (!freighter?.signMessage) {
          throw new Error("Message signing not supported by this wallet");
        }

        const signature = await freighter.signMessage(message);
        
        if (!signature) {
          throw new Error("Message signing was rejected or failed.");
        }

        return signature;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast.error(`Failed to sign message: ${message}`);
        throw new Error(message);
      }
    },
    [walletContext.isConnected, walletContext.publicKey]
  );

  // ── Claim Payout ─────────────────────────────────────────────────────────

  const claimPayout = useCallback(
    async (orgId: string) => {
      if (!walletContext.isConnected || !walletContext.publicKey) {
        throw new Error("Wallet is not connected. Call connect() first.");
      }

      try {
        // Build the claim_payout transaction
        const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/v1/contract/claim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            orgId,
            maintainerAddress: walletContext.publicKey,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ message: response.statusText }));
          throw new Error(errorData.message || 'Failed to create claim transaction');
        }

        const { transactionXdr } = await response.json();

        // Sign the transaction using the FSM-backed signTransaction
        const signedTransaction = await walletContext.signTransaction(transactionXdr);

        // Submit the signed transaction
        const submitResponse = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/v1/contract/submit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            signedTransaction,
          }),
        });

        if (!submitResponse.ok) {
          const errorData = await submitResponse.json().catch(() => ({ message: submitResponse.statusText }));
          throw new Error(errorData.message || 'Failed to submit transaction');
        }

        const result = await submitResponse.json();

        toastTransaction.success("Successfully claimed payout!", result.transactionHash);
        return result;

      } catch (error) {
        console.error('Error claiming payout:', error);
        toastTransaction.error(error, 'Failed to claim payout');
        throw error;
      }
    },
    [walletContext.isConnected, walletContext.publicKey, walletContext.signTransaction]
  );

  // ── Return unified state and actions ─────────────────────────────────────

  return {
    // State from XState machine
    isInitialized: walletContext.isInitialized,
    isInstalled,
    isConnected: walletContext.isConnected,
    publicKey: walletContext.publicKey,
    isLoading: walletContext.isLoading,
    isSigning,
    error: walletContext.error,
    network: walletContext.network,
    isWrongNetwork: walletContext.isWrongNetwork,
    isHardwareTimeout: walletContext.isHardwareTimeout,
    providers: walletContext.providers,
    
    // Actions from XState machine
    connect: walletContext.connectWallet,
    disconnect: walletContext.disconnectWallet,
    signTransaction: walletContext.signTransaction,
    signAuthMessage,
    claimPayout,
    selectWallet: walletContext.selectWallet,
    retryConnection: walletContext.retryConnection,
    cancelHardwareWait: walletContext.cancelHardwareWait,
  };
}
