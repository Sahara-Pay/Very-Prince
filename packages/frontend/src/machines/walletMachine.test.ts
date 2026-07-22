import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createActor, waitFor } from 'xstate';
import { walletMachine } from './walletMachine';
import type { WalletProviderDetail } from '../lib/web3/eip6963';

vi.mock('@stellar/freighter-api', () => ({
  default: {
    isConnected: vi.fn(),
    isAllowed: vi.fn(),
    getPublicKey: vi.fn(),
    getNetwork: vi.fn(),
    signTransaction: vi.fn(),
  },
}));

import freighterApi from '@stellar/freighter-api';

const mockIsConnected = freighterApi.isConnected as any;
const mockGetPublicKey = freighterApi.getPublicKey as any;
const mockGetNetwork = freighterApi.getNetwork as any;
const mockSignTransaction = freighterApi.signTransaction as any;

const SESSION_KEY = 'very-prince.wallet-session';

function mockSuccessfulFreighter(publicKey = 'GABC123', network: 'PUBLIC' | 'TESTNET' = 'TESTNET') {
  mockIsConnected.mockResolvedValue(true);
  mockGetPublicKey.mockResolvedValue(publicKey);
  mockGetNetwork.mockResolvedValue(network);
}

function metamaskDetail(): WalletProviderDetail {
  return {
    info: { rdns: 'io.metamask', name: 'MetaMask', kind: 'evm', source: 'eip6963' },
    provider: {},
  };
}

describe('walletMachine', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. No wallet extension installed
  it('surfaces a clear error when Freighter is not installed', async () => {
    mockIsConnected.mockResolvedValue(false);
    const actor = createActor(walletMachine).start();

    actor.send({ type: 'CONNECT' });
    const snapshot = await waitFor(actor, (s) => s.matches('disconnected') && s.context.error !== null);

    expect(snapshot.context.error).toBe('Freighter wallet is not installed. Please install it to continue.');
    expect(snapshot.context.publicKey).toBeNull();
  });

  // 2. Multiple extensions installed at once, discovered without conflict
  it('discovers multiple wallet providers without duplicating entries', () => {
    const actor = createActor(walletMachine).start();

    actor.send({
      type: 'PROVIDER_DISCOVERED',
      detail: { info: { rdns: 'app.freighter', name: 'Freighter', kind: 'stellar', source: 'legacy-injected' }, provider: {} },
    });
    actor.send({ type: 'PROVIDER_DISCOVERED', detail: metamaskDetail() });
    // Re-announcing the same wallet must not create a duplicate entry.
    actor.send({ type: 'PROVIDER_DISCOVERED', detail: metamaskDetail() });

    expect(actor.getSnapshot().context.providers).toHaveLength(2);
    expect(actor.getSnapshot().context.providers.map((p) => p.rdns).sort()).toEqual(['app.freighter', 'io.metamask']);
  });

  // 3. User explicitly selects a specific discovered wallet
  it('connects to the wallet the user explicitly selected', async () => {
    const actor = createActor(walletMachine).start();
    actor.send({ type: 'PROVIDER_DISCOVERED', detail: metamaskDetail() });

    actor.send({ type: 'SELECT_WALLET', rdns: 'io.metamask' });
    const snapshot = await waitFor(actor, (s) => s.matches('disconnected') && s.context.error !== null);

    expect(snapshot.context.error).toMatch(/MetaMask/);
    expect(snapshot.context.error).toMatch(/not yet supported/);
  });

  // 4. User rejects the connection request
  it('treats a rejected connection request as a distinct, non-hardware error', async () => {
    mockIsConnected.mockResolvedValue(true);
    mockGetPublicKey.mockRejectedValue(new Error('User declined access'));
    const actor = createActor(walletMachine).start();

    actor.send({ type: 'CONNECT' });
    const snapshot = await waitFor(actor, (s) => s.matches('disconnected') && s.context.error !== null);

    expect(snapshot.context.error).toBe('User declined access');
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  // 5. Wrong network detected at connect time
  it('rejects the connection attempt when Freighter is on the wrong network', async () => {
    mockSuccessfulFreighter('GABC123', 'PUBLIC');
    const actor = createActor(walletMachine).start();

    actor.send({ type: 'CONNECT' });
    const snapshot = await waitFor(actor, (s) => s.matches('disconnected') && s.context.error !== null);

    expect(snapshot.context.error).toBe('Please switch to Stellar Testnet in Freighter.');
    expect(snapshot.matches({ connected: 'idle' })).toBe(false);
  });

  // 6. Network changed while already connected
  it('flags the connected session as wrongNetwork when the wallet switches network externally', async () => {
    mockSuccessfulFreighter();
    const actor = createActor(walletMachine).start();
    actor.send({ type: 'CONNECT' });
    await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

    actor.send({ type: 'NETWORK_CHANGED', network: 'public' });

    expect(actor.getSnapshot().matches({ connected: 'wrongNetwork' })).toBe(true);
    expect(actor.getSnapshot().context.publicKey).toBe('GABC123');
  });

  // 7. Account switched while connected
  it('updates the public key in place when the account changes while connected', async () => {
    mockSuccessfulFreighter('GABC123');
    const actor = createActor(walletMachine).start();
    actor.send({ type: 'CONNECT' });
    await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

    actor.send({ type: 'ACCOUNT_CHANGED', publicKey: 'GXYZ999' });

    const snapshot = actor.getSnapshot();
    expect(snapshot.matches({ connected: 'idle' })).toBe(true);
    expect(snapshot.context.publicKey).toBe('GXYZ999');
  });

  // 8. Wallet disconnected/revoked externally while connected
  it('drops back to disconnected when the extension reports an external disconnect', async () => {
    mockSuccessfulFreighter();
    const actor = createActor(walletMachine).start();
    actor.send({ type: 'CONNECT' });
    await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

    actor.send({ type: 'EXT_DISCONNECTED' });

    const snapshot = actor.getSnapshot();
    expect(snapshot.matches('disconnected')).toBe(true);
    expect(snapshot.context.publicKey).toBeNull();
    expect(snapshot.context.error).toBe('Wallet was disconnected from the extension.');
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  // 9. Hardware wallet timeout while connecting
  it('shows a recovery prompt when the hardware wallet does not respond in time while connecting', async () => {
    vi.useFakeTimers();
    mockIsConnected.mockResolvedValue(true);
    // Simulate a Ledger that never confirms — the connect promise just hangs.
    mockGetPublicKey.mockReturnValue(new Promise(() => {}));

    const actor = createActor(walletMachine, { input: { hardwareTimeoutMs: 1000 } }).start();
    actor.send({ type: 'CONNECT' });

    await vi.advanceTimersByTimeAsync(1000);
    expect(actor.getSnapshot().matches('hardwareTimeoutConnect')).toBe(true);
    expect(actor.getSnapshot().context.error).toMatch(/did not respond in time/);

    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().matches('disconnected')).toBe(true);
  });

  // 10. Hardware wallet timeout while signing
  it('shows a recovery prompt when the hardware wallet does not respond in time while signing', async () => {
    mockSuccessfulFreighter();
    const actor = createActor(walletMachine, { input: { hardwareTimeoutMs: 1000 } }).start();
    actor.send({ type: 'CONNECT' });
    await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

    vi.useFakeTimers();
    mockSignTransaction.mockReturnValue(new Promise(() => {}));
    actor.send({ type: 'SIGN_REQUEST', xdr: 'AAAA...' });

    await vi.advanceTimersByTimeAsync(1000);
    expect(actor.getSnapshot().matches({ connected: 'hardwareTimeoutSign' })).toBe(true);

    actor.send({ type: 'CANCEL' });
    const snapshot = actor.getSnapshot();
    expect(snapshot.matches({ connected: 'idle' })).toBe(true);
    expect(snapshot.context.error).toBe('Signing was cancelled.');
  });

  // 11. Session restore on load succeeds
  it('silently restores a persisted session on startup', async () => {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({ rdns: 'app.freighter', publicKey: 'GABC123' }));
    mockSuccessfulFreighter('GABC123');

    const actor = createActor(walletMachine).start();
    const snapshot = await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

    expect(snapshot.context.publicKey).toBe('GABC123');
    expect(snapshot.context.error).toBeNull();
  });

  // 12. Session restore fails silently (stale/revoked session)
  it('fails a stale session restore silently, without surfacing an error banner', async () => {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({ rdns: 'app.freighter', publicKey: 'GABC123' }));
    mockIsConnected.mockResolvedValue(false);

    const actor = createActor(walletMachine).start();
    const snapshot = await waitFor(actor, (s) => s.matches('disconnected') && s.context.restoreAttempted);

    expect(snapshot.context.error).toBeNull();
    expect(snapshot.context.publicKey).toBeNull();
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
    // A stale session must only ever be auto-retried once, never loop forever.
    expect(snapshot.context.restoreAttempted).toBe(true);
  });
});
