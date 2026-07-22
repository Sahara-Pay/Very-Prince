/**
 * @file WalletContext.tsx
 * @description React Context provider for Freighter wallet integration
 * 
 * This context provides:
 * - Wallet connection state (public key, network, connection status)
 * - Functions to connect/disconnect wallet
 * - Network change monitoring
 * - Global wallet state management across the app
 */

'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import freighterApi from '@stellar/freighter-api';

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
}

// ── Context Creation ───────────────────────────────────────────────────────

const WalletContext = createContext<WalletContextType | undefined>(undefined);

// ── Helper Functions ───────────────────────────────────────────────────────

const getNetworkFromFreighter = async (): Promise<NetworkType> => {
  try {
    const network = await freighterApi.getNetwork();
    return network === 'PUBLIC' ? 'public' : 'testnet';
  } catch (error) {
    console.warn('Failed to get network from Freighter:', error);
    return 'testnet'; // Default to testnet
  }
};

const getPublicKeyFromFreighter = async (): Promise<string | null> => {
  try {
    return await freighterApi.getPublicKey();
  } catch (error) {
    console.warn('Failed to get public key from Freighter:', error);
    return null;
  }
};

// ── Provider Component ─────────────────────────────────────────────────────

interface WalletProviderProps {
  children: React.ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [walletState, setWalletState] = useState<WalletState>({
    publicKey: null,
    network: 'testnet',
    isConnected: false,
    isConnecting: false,
    isInitialized: false,
    error: null,
  });

  // ── Wallet Connection Functions ───────────────────────────────────────────

  const connectWallet = useCallback(async () => {
    setWalletState(prev => ({ ...prev, isConnecting: true, error: null }));

    try {
      // Check if Freighter is installed
      const isInstalled = await freighterApi.isConnected();
      if (!isInstalled) {
        throw new Error('Freighter wallet is not installed. Please install it to continue.');
      }

      // Get public key
      const publicKey = await getPublicKeyFromFreighter();
      if (!publicKey) {
        throw new Error('Failed to get public key from Freighter wallet.');
      }

      // Get current network
      const network = await getNetworkFromFreighter();

      // Validate that the network is Testnet
      if (network !== 'testnet') {
        throw new Error('Please switch to Stellar Testnet in Freighter.');
      }

      setWalletState({
        publicKey,
        network,
        isConnected: true,
        isConnecting: false,
        isInitialized: true,
        error: null,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to connect wallet';
      setWalletState(prev => ({
        ...prev,
        isConnecting: false,
        isInitialized: true,
        error: errorMessage,
      }));
    }
  }, []);

  const disconnectWallet = useCallback(() => {
    setWalletState({
      publicKey: null,
      network: 'testnet',
      isConnected: false,
      isConnecting: false,
      isInitialized: true,
      error: null,
    });
  }, []);

  const signTransaction = useCallback(async (transactionXdr: string): Promise<string> => {
    if (!walletState.isConnected || !walletState.publicKey) {
      throw new Error('Wallet is not connected. Call connectWallet() first.');
    }

    setWalletState(prev => ({ ...prev, isConnecting: true, error: null }));

    try {
      const signedTxXdr = await freighterApi.signTransaction(transactionXdr, {
        network: walletState.network === 'public' ? 'PUBLIC' : 'TESTNET',
        networkPassphrase: 
          walletState.network === 'public' 
            ? 'Public Global Stellar Network ; September 2015'
            : 'Test SDF Network ; September 2015',
      });

      if (!signedTxXdr) {
        throw new Error('Transaction signing was rejected or failed.');
      }

      return signedTxXdr;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Transaction signing failed';
      setWalletState(prev => ({ ...prev, error: errorMessage }));
      throw new Error(errorMessage);
    } finally {
      setWalletState(prev => ({ ...prev, isConnecting: false }));
    }
  }, [walletState.isConnected, walletState.publicKey, walletState.network]);

  const checkConnection = useCallback(async () => {
    try {
      const isInstalled = await freighterApi.isConnected();
      if (!isInstalled) {
        setWalletState(prev => ({
          ...prev,
          isConnected: false,
          publicKey: null,
          isInitialized: true,
          error: 'Freighter wallet is not installed',
        }));
        return;
      }

      const allowed = await freighterApi.isAllowed();
      if (!allowed) {
        setWalletState(prev => ({
          ...prev,
          isConnected: false,
          publicKey: null,
          isInitialized: true,
          error: null,
        }));
        return;
      }

      const publicKey = await getPublicKeyFromFreighter();
      const network = await getNetworkFromFreighter();

      // Validate that the network is Testnet
      if (network !== 'testnet') {
        setWalletState(prev => ({
          ...prev,
          isConnected: false,
          publicKey: null,
          error: 'Please switch to Stellar Testnet in Freighter.',
        }));
        return;
      }

      if (publicKey) {
        setWalletState({
          publicKey,
          network,
          isConnected: true,
          isConnecting: false,
          isInitialized: true,
          error: null,
        });
      } else {
        setWalletState(prev => ({
          ...prev,
          isConnected: false,
          publicKey: null,
          isInitialized: true,
          error: null,
        }));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to check wallet connection';
      setWalletState(prev => ({
        ...prev,
        isConnected: false,
        publicKey: null,
        isInitialized: true,
        error: errorMessage,
      }));
    }
  }, []);

  // ── Network Change Monitoring ─────────────────────────────────────────────

  useEffect(() => {
    if (!walletState.isConnected) return;

    const handleNetworkChange = async () => {
      const newNetwork = await getNetworkFromFreighter();
      setWalletState(prev => ({ ...prev, network: newNetwork }));
    };

    // Listen for network changes from Freighter
    const unsubscribe = (freighterApi as any).onNetworkChange?.(handleNetworkChange);

    return () => {
      unsubscribe?.();
    };
  }, [walletState.isConnected]);

  // ── Wallet Event Listeners ────────────────────────────────────────────────

  useEffect(() => {
    const handleWalletChange = () => {
      checkConnection();
    };

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
  }, [checkConnection]);

  // ── Initial Connection Check ─────────────────────────────────────────────

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // ── Context Value ─────────────────────────────────────────────────────────

  const contextValue: WalletContextType = useMemo(
    () => ({
      ...walletState,
      connectWallet,
      disconnectWallet,
      checkConnection,
      signTransaction,
      isLoading: walletState.isConnecting,
    }),
    [walletState, connectWallet, disconnectWallet, checkConnection, signTransaction]
  );

  return (
    <WalletContext.Provider value={contextValue}>
      {children}
    </WalletContext.Provider>
  );
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
