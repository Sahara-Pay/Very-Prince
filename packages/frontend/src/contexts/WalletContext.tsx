/**
 * @file WalletContext.tsx
 * @description React Context provider for wallet integration, backed by the
 * `walletMachine` XState v5 state machine (see `machines/walletMachine.ts`).
 *
 * This context provides:
 * - Wallet connection state (public key, network, connection status)
 * - Multi-wallet discovery via EIP-6963 + legacy-injected fallbacks
 * - Hardware wallet (Ledger) timeout recovery prompts
 * - Session persistence across page reloads
 * - Functions to connect/disconnect/sign, kept API-compatible with the
 *   previous Freighter-only implementation so existing consumers
 *   (AuthContext, useFreighter, WalletTest, ...) keep working unchanged.
 */

'use client';

import React, { createContext, useContext, useEffect, useMemo, useCallback } from 'react';
import { useMachine } from '@xstate/react';
import { waitFor } from 'xstate';
import { walletMachine } from '../machines/walletMachine';
import { subscribeToProviders, type WalletProviderInfo } from '../lib/web3/eip6963';

// ── Type Definitions ───────────────────────────────────────────────────────

export type NetworkType = 'public' | 'testnet';

export interface WalletState {
  publicKey: string | null;
  network: NetworkType;
  isConnected: boolean;
  isConnecting: boolean;
  isInitialized: boolean;
  error: string | null;
}

export interface WalletContextType extends WalletState {
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
  checkConnection: () => Promise<void>;
  signTransaction: (transactionXdr: string) => Promise<string>;
  isLoading: boolean;
  /** Every wallet extension discovered so far (EIP-6963 + legacy), de-duplicated by rdns. */
  providers: WalletProviderInfo[];
  /** Connect to a specific discovered wallet instead of the default (Freighter). */
  selectWallet: (rdns: string) => void;
  /** True once the wallet reported a network other than Stellar Testnet while connected. */
  isWrongNetwork: boolean;
  /** True while waiting on a hardware wallet (e.g. Ledger) to respond. */
  isHardwareTimeout: boolean;
  /** Retry a connect/sign attempt after a hardware wallet timeout. */
  retryConnection: () => void;
  /** Cancel a pending hardware wallet wait. */
  cancelHardwareWait: () => void;
}

// ── Context Creation ───────────────────────────────────────────────────────

const WalletContext = createContext<WalletContextType | undefined>(undefined);

// ── Provider Component ─────────────────────────────────────────────────────

interface WalletProviderProps {
  children: React.ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [snapshot, send, actorRef] = useMachine(walletMachine, { input: {} });

  // ── Discover installed wallet extensions (EIP-6963 + legacy fallbacks) ───

  useEffect(() => {
    const unsubscribe = subscribeToProviders((detail) => {
      send({ type: 'PROVIDER_DISCOVERED', detail });
    });
    return unsubscribe;
  }, [send]);

  // ── Freighter-specific event bridge (account/network/disconnect) ─────────

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const freighter = (window as any).freighter;
    if (!freighter?.on) return;

    const handleAccountChanged = async () => {
      try {
        const freighterApi = (await import('@stellar/freighter-api')).default;
        const publicKey = await freighterApi.getPublicKey();
        send({ type: 'ACCOUNT_CHANGED', publicKey: publicKey ?? null });
      } catch {
        send({ type: 'ACCOUNT_CHANGED', publicKey: null });
      }
    };
    const handleDisconnected = () => send({ type: 'EXT_DISCONNECTED' });

    freighter.on('accountChanged', handleAccountChanged);
    freighter.on('disconnected', handleDisconnected);

    return () => {
      freighter.off?.('accountChanged', handleAccountChanged);
      freighter.off?.('disconnected', handleDisconnected);
    };
  }, [send]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const isConnected = snapshot.matches({ connected: 'idle' }) || snapshot.matches({ connected: 'wrongNetwork' });
  const isConnecting = snapshot.matches('connecting') || snapshot.matches({ connected: 'signing' });
  const isHardwareTimeout = snapshot.matches('hardwareTimeoutConnect') || snapshot.matches({ connected: 'hardwareTimeoutSign' });
  const isWrongNetwork = snapshot.matches({ connected: 'wrongNetwork' });

  // ── Imperative, Promise-based API (kept compatible with previous version) ─

  const connectWallet = useCallback(async () => {
    send({ type: 'CONNECT' });
    await waitFor(
      actorRef,
      (s) => s.matches('disconnected') || s.matches({ connected: 'idle' }) || s.matches({ connected: 'wrongNetwork' })
    );
  }, [send, actorRef]);

  const disconnectWallet = useCallback(() => {
    send({ type: 'DISCONNECT' });
  }, [send]);

  const checkConnection = useCallback(async () => {
    await connectWallet();
  }, [connectWallet]);

  const signTransaction = useCallback(
    async (transactionXdr: string): Promise<string> => {
      const current = actorRef.getSnapshot();
      if (!current.matches({ connected: 'idle' }) && !current.matches({ connected: 'wrongNetwork' })) {
        throw new Error('Wallet is not connected. Call connectWallet() first.');
      }

      send({ type: 'SIGN_REQUEST', xdr: transactionXdr });

      const settled = await waitFor(
        actorRef,
        (s) => s.matches({ connected: 'idle' }) && s.context.pendingSignXdr === null
      );

      if (settled.context.lastSignedXdr) {
        return settled.context.lastSignedXdr;
      }
      throw new Error(settled.context.error ?? 'Transaction signing failed');
    },
    [send, actorRef]
  );

  const selectWallet = useCallback((rdns: string) => send({ type: 'SELECT_WALLET', rdns }), [send]);
  const retryConnection = useCallback(() => send({ type: 'RETRY' }), [send]);
  const cancelHardwareWait = useCallback(() => send({ type: 'CANCEL' }), [send]);

  // ── Context Value ─────────────────────────────────────────────────────────

  const contextValue: WalletContextType = useMemo(
    () => ({
      publicKey: snapshot.context.publicKey,
      network: snapshot.context.network ?? 'testnet',
      isConnected,
      isConnecting,
      isInitialized: true,
      error: snapshot.context.error,
      isLoading: isConnecting,
      providers: snapshot.context.providers,
      isWrongNetwork,
      isHardwareTimeout,
      connectWallet,
      disconnectWallet,
      checkConnection,
      signTransaction,
      selectWallet,
      retryConnection,
      cancelHardwareWait,
    }),
    [
      snapshot.context.publicKey,
      snapshot.context.network,
      snapshot.context.error,
      snapshot.context.providers,
      isConnected,
      isConnecting,
      isWrongNetwork,
      isHardwareTimeout,
      connectWallet,
      disconnectWallet,
      checkConnection,
      signTransaction,
      selectWallet,
      retryConnection,
      cancelHardwareWait,
    ]
  );

  return <WalletContext.Provider value={contextValue}>{children}</WalletContext.Provider>;
}

// ── Hook for Using Wallet Context ───────────────────────────────────────────

export function useWallet(): WalletContextType {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}

// ── Export Context (for testing) ─────────────────────────────────────────────

export { WalletContext };
