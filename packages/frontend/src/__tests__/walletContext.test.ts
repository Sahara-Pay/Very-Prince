// packages/frontend/src/__tests__/walletContext.test.ts
import { renderHook, act } from '@testing-library/react-hooks';
import { WalletProvider, useWallet } from '../contexts/WalletContext';
import freighterApi from '@stellar/freighter-api';

jest.mock('@stellar/freighter-api', () => ({
  isConnected: jest.fn(),
  getPublicKey: jest.fn(),
  getNetwork: jest.fn(),
}));

const mockIsConnected = freighterApi.isConnected as jest.Mock;
const mockGetPublicKey = freighterApi.getPublicKey as jest.Mock;
const mockGetNetwork = freighterApi.getNetwork as jest.Mock;

describe('WalletContext network validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
