'use client';

import React, { createContext, useContext, useEffect } from 'react';
import { useActor } from '@xstate/react';
import { walletMachine } from '../machines/walletMachine';
import { subscribeToProviders } from '../lib/web3/eip6963';

interface WalletContextType {
  state: ReturnType<typeof useActor>[0];
  send: ReturnType<typeof useActor>[1];
}

const WalletContext = createContext<WalletContextType | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, send] = useActor(walletMachine);

  useEffect(() => {
    // Escuchar anuncios EIP-6963 dinámicamente
    const unsubscribe = subscribeToProviders((detail) => {
      send({ type: 'PROVIDER_DISCOVERED', detail });
    });
    return unsubscribe;
  }, [send]);

  return (
    <WalletContext.Provider value={{ state, send }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}
