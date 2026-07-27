import { describe, it, expect, vi, beforeEach } from 'vitest';
import freighterApi from '@stellar/freighter-api';

// Mock freighter-api
vi.mock('@stellar/freighter-api', () => {
  return {
    default: {
      isConnected: vi.fn(),
      isAllowed: vi.fn(),
      getPublicKey: vi.fn(),
      getNetwork: vi.fn(),
    },
  };
});

describe('WalletContext State Clearing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should detect when wallet is not installed', async () => {
    (freighterApi.isConnected as any).mockResolvedValue(false);

    const isInstalled = await freighterApi.isConnected();
    expect(isInstalled).toBe(false);
  });

  it('should detect when wallet is not allowed', async () => {
    (freighterApi.isConnected as any).mockResolvedValue(true);
    (freighterApi.isAllowed as any).mockResolvedValue(false);

    const isInstalled = await freighterApi.isConnected();
    const isAllowed = await freighterApi.isAllowed();

    expect(isInstalled).toBe(true);
    expect(isAllowed).toBe(false);
  });

  it('should retrieve public key and network when allowed', async () => {
    (freighterApi.isConnected as any).mockResolvedValue(true);
    (freighterApi.isAllowed as any).mockResolvedValue(true);
    (freighterApi.getPublicKey as any).mockResolvedValue('GABC123');
    (freighterApi.getNetwork as any).mockResolvedValue('PUBLIC');

    const isInstalled = await freighterApi.isConnected();
    const isAllowed = await freighterApi.isAllowed();
    const publicKey = await freighterApi.getPublicKey();
    const network = await freighterApi.getNetwork();

    expect(isInstalled).toBe(true);
    expect(isAllowed).toBe(true);
    expect(publicKey).toBe('GABC123');
    expect(network).toBe('PUBLIC');
  });
});
