// packages/frontend/src/__tests__/walletContext.test.tsx
import { renderHook, act } from '@testing-library/react';
import { WalletProvider, useWallet } from '../contexts/WalletContext';
import freighterApi from '@stellar/freighter-api';
import { vi, describe, test, expect, beforeEach } from 'vitest';
import React from 'react';

vi.mock('@stellar/freighter-api', () => ({
  default: {
    isConnected: vi.fn(),
    getPublicKey: vi.fn(),
    getNetwork: vi.fn(),
  }
}));

const mockIsConnected = freighterApi.isConnected as any;
const mockGetPublicKey = freighterApi.getPublicKey as any;
const mockGetNetwork = freighterApi.getNetwork as any;

describe('WalletContext network validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('connectWallet throws when not on testnet', async () => {
    mockIsConnected.mockResolvedValue(true);
    mockGetPublicKey.mockResolvedValue('GTESTPUBLICKEY123');
    mockGetNetwork.mockResolvedValue('PUBLIC'); // Simulate mainnet

    const wrapper = ({ children }: any) => <WalletProvider>{children}</WalletProvider>;
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.connectWallet();
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBe('Please switch to Stellar Testnet in Freighter.');
  });

  test('checkConnection validates network', async () => {
    mockIsConnected.mockResolvedValue(true);
    mockGetPublicKey.mockResolvedValue('GTESTPUBLICKEY123');
    mockGetNetwork.mockResolvedValue('PUBLIC');

    const wrapper = ({ children }: any) => <WalletProvider>{children}</WalletProvider>;
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.checkConnection();
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBe('Please switch to Stellar Testnet in Freighter.');
  });
});
