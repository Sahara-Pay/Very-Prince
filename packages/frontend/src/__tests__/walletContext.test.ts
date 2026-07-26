// packages/frontend/src/__tests__/walletContext.test.ts
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { WalletProvider, useWallet } from '../contexts/WalletContext';
import freighterApi from '@stellar/freighter-api';
import { vi, describe, beforeEach, test, expect } from 'vitest';

const mocks = vi.hoisted(() => ({
  isConnected: vi.fn(),
  getPublicKey: vi.fn(),
  getNetwork: vi.fn(),
}));

vi.mock('@stellar/freighter-api', () => ({
  isConnected: mocks.isConnected,
  getPublicKey: mocks.getPublicKey,
  getNetwork: mocks.getNetwork,
  default: {
    isConnected: mocks.isConnected,
    getPublicKey: mocks.getPublicKey,
    getNetwork: mocks.getNetwork,
  }
}));

const mockIsConnected = mocks.isConnected;
const mockGetPublicKey = mocks.getPublicKey;
const mockGetNetwork = mocks.getNetwork;

describe('WalletContext network validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('connectWallet throws when not on testnet', async () => {
    mockIsConnected.mockResolvedValue(true);
    mockGetPublicKey.mockResolvedValue('GTESTPUBLICKEY123');
    mockGetNetwork.mockResolvedValue('PUBLIC'); // Simulate mainnet

    const wrapper = ({ children }: any) => React.createElement(WalletProvider, null, children);
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

    const wrapper = ({ children }: any) => React.createElement(WalletProvider, null, children);
    const { result } = renderHook(() => useWallet(), { wrapper });

    await act(async () => {
      await result.current.checkConnection();
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBe('Please switch to Stellar Testnet in Freighter.');
  });
});
