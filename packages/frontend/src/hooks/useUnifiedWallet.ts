/**
 * @file useUnifiedWallet.ts
 * @description Unified wallet hook that consolidates all wallet-related functionality.
 * 
 * This hook provides a single, clean API for all wallet interactions including:
 * - Connection management
 * - Transaction signing
 * - Auth message signing (SIWS)
 * - Payout claiming
 * - Error handling and loading states
 * 
 * This makes it easy to add support for other wallets (Albedo, xBull) later
 * by updating the logic in one place.
 */

import { useState, useCallback, useEffect } from "react";
import {
  isConnected as freighterIsConnected,
  getPublicKey,
  signTransaction as freighterSignTransaction,
  isAllowed,
  setAllowed,
} from "@stellar/freighter-api";
import { toast } from "sonner";
import { toastTransaction } from "../lib/transactionToast";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnifiedWalletState {
  /** True once the browser extension has been detected and queried. */
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
  /** Wallet type (currently only 'freighter', but extensible). */
  walletType: 'freighter' | null;
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
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Returns the current wallet state and interaction callbacks.
 * This is the unified API for all wallet interactions.
 */
export function useUnifiedWallet(): UnifiedWalletState & WalletActions {
  const [state, setState] = useState<UnifiedWalletState>({
    isInitialized: false,
    isInstalled: false,
    isConnected: false,
    publicKey: null,
    isLoading: false,
    isSigning: false,
    error: null,
    walletType: null,
  });

  // ── Detect wallet on mount ─────────────────────────────────────────────

  const checkWalletConnection = useCallback(async () => {
    try {
      // Currently only support Freighter, but this is where we'd detect other wallets
      const connected = await freighterIsConnected();
      
      if (connected !== undefined) {
        setState(prev => ({
          ...prev,
          isInstalled: true,
          walletType: 'freighter',
        }));

        // Check if this site is already allowed without another prompt
        const allowed = await isAllowed();
        if (allowed) {
          const pk = await getPublicKey();
          setState(prev => ({
            ...prev,
            isConnected: !!pk,
            publicKey: pk ?? null,
          }));
        } else {
          setState(prev => ({
            ...prev,
            isConnected: false,
            publicKey: null,
          }));
        }
      } else {
        setState(prev => ({
          ...prev,
          isInstalled: false,
          walletType: null,
          isConnected: false,
          publicKey: null,
        }));
      }
    } catch {
      // Wallet not installed — stay in unconnected state
      setState(prev => ({
        ...prev,
        isInstalled: false,
        walletType: null,
        isConnected: false,
        publicKey: null,
      }));
    } finally {
      setState(prev => ({ ...prev, isInitialized: true }));
    }
  }, []);

  useEffect(() => {
    checkWalletConnection();

    // Listen for wallet events (Freighter specific)
    const handleWalletChange = () => {
      checkWalletConnection();
    };

    // Note: This is Freighter-specific. For multi-wallet support,
    // we'd need to abstract this further.
    if (typeof window !== 'undefined' && (window as any).freighter) {
      const freighter = (window as any).freighter;
      freighter.on?.('accountChanged', handleWalletChange);
      freighter.on?.('connected', handleWalletChange);
      freighter.on?.('disconnected', handleWalletChange);

      return () => {
        freighter.off?.('accountChanged', handleWalletChange);
        freighter.off?.('connected', handleWalletChange);
        freighter.off?.('disconnected', handleWalletChange);
      };
    }
  }, [checkWalletConnection]);

  // ── Connect ───────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      if (!state.isInstalled) {
        throw new Error(
          "Wallet is not installed. Get Freighter at freighter.app"
        );
      }

      // Grant this site permission to read the public key
      await setAllowed();

      const pk = await getPublicKey();

      if (!pk) {
        throw new Error("Failed to retrieve public key from wallet.");
      }

      setState(prev => ({
        ...prev,
        isConnected: true,
        publicKey: pk,
      }));

      toast.success("Wallet connected successfully!");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setState(prev => ({
        ...prev,
        error: message,
        isConnected: false,
        publicKey: null,
      }));
      toast.error(`Failed to connect wallet: ${message}`);
    } finally {
      setState(prev => ({ ...prev, isLoading: false }));
    }
  }, [state.isInstalled]);

  // ── Disconnect ────────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    // Wallets do not expose a programmatic revoke API yet.
    // We clear local state — the user can manually disconnect in the extension.
    setState(prev => ({
      ...prev,
      isConnected: false,
      publicKey: null,
      error: null,
    }));
    toast.success("Wallet disconnected");
  }, []);

  // ── Sign Transaction ──────────────────────────────────────────────────────

  const signTransaction = useCallback(
    async (transactionXdr: string): Promise<string> => {
      if (!state.isConnected || !state.publicKey) {
        throw new Error("Wallet is not connected. Call connect() first.");
      }

      setState(prev => ({ ...prev, isSigning: true, error: null }));

      try {
        const signedTxXdr = await freighterSignTransaction(transactionXdr, {
          network: "TESTNET",
          networkPassphrase:
            process.env["NEXT_PUBLIC_NETWORK_PASSPHRASE"] ??
            "Test SDF Network ; September 2015",
        });

        if (!signedTxXdr) {
          throw new Error("Signing was rejected or failed.");
        }

        return signedTxXdr;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setState(prev => ({ ...prev, error: message }));
        toast.error(`Failed to sign transaction: ${message}`);
        throw new Error(message);
      } finally {
        setState(prev => ({ ...prev, isSigning: false }));
      }
    },
    [state.isConnected, state.publicKey]
  );

  // ── Sign Auth Message ─────────────────────────────────────────────────────

  const signAuthMessage = useCallback(
    async (message: string): Promise<string> => {
      if (!state.isConnected || !state.publicKey) {
        throw new Error("Wallet is not connected. Call connect() first.");
      }

      setState(prev => ({ ...prev, isSigning: true, error: null }));

      try {
        // For Freighter, we need to use the signMessage method
        // This is a simplified implementation - you might need to adjust
        // based on the actual Freighter API for message signing
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
        setState(prev => ({ ...prev, error: message }));
        toast.error(`Failed to sign message: ${message}`);
        throw new Error(message);
      } finally {
        setState(prev => ({ ...prev, isSigning: false }));
      }
    },
    [state.isConnected, state.publicKey]
  );

  // ── Claim Payout ─────────────────────────────────────────────────────────

  const claimPayout = useCallback(
    async (orgId: string) => {
      if (!state.isConnected || !state.publicKey) {
        throw new Error("Wallet is not connected. Call connect() first.");
      }

      setState(prev => ({ ...prev, isSigning: true, error: null }));

      try {
        // Build the claim_payout transaction
        const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/v1/contract/claim`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            orgId,
            maintainerAddress: state.publicKey,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ message: response.statusText }));
          throw new Error(errorData.message || 'Failed to create claim transaction');
        }

        const { transactionXdr } = await response.json();

        // Sign the transaction
        const signedTransaction = await signTransaction(transactionXdr);

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
      } finally {
        setState(prev => ({ ...prev, isSigning: false }));
      }
    },
    [state.isConnected, state.publicKey, signTransaction]
  );

  return {
    ...state,
    connect,
    disconnect,
    signTransaction,
    signAuthMessage,
    claimPayout,
  };
}
