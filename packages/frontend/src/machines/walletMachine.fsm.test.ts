/**
 * @file walletMachine.fsm.test.ts
 * @description State-machine transition guarantees for the XState v5 wallet FSM.
 *
 * These tests validate the structural guarantees the FSM provides over a
 * boolean-flag implementation:
 *   - exactly-one-state invariant and impossible-state prevention
 *   - provider discovery / de-duplication
 *   - connect → connected and hardware-timeout recovery flows
 *   - network / account / disconnect transitions while connected
 *   - signing and hardware-timeout-sign recovery flows
 *
 * The adapter (`getWalletAdapter`) is exercised end-to-end through a mocked
 * `@stellar/freighter-api`, mirroring the integration tests in
 * `walletMachine.test.ts`, so connect/sign actually resolve instead of hanging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createActor, waitFor } from 'xstate';
import { walletMachine, type WalletMachineEvent } from './walletMachine';
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

const mockIsConnected = freighterApi.isConnected as ReturnType<typeof vi.fn>;
const mockGetPublicKey = freighterApi.getPublicKey as ReturnType<typeof vi.fn>;
const mockGetNetwork = freighterApi.getNetwork as ReturnType<typeof vi.fn>;
const mockSignTransaction = freighterApi.signTransaction as ReturnType<typeof vi.fn>;

const SESSION_KEY = 'very-prince.wallet-session';
const FREIGHTER_RDNS = 'app.freighter';

function mockSuccessfulFreighter(publicKey = 'GABC123', network: 'PUBLIC' | 'TESTNET' = 'TESTNET') {
  mockIsConnected.mockResolvedValue(true);
  mockGetPublicKey.mockResolvedValue(publicKey);
  mockGetNetwork.mockResolvedValue(network);
}

function providerDetail(rdns: string, name: string): WalletProviderDetail {
  return {
    info: { rdns, name, kind: 'stellar', source: 'eip6963' },
    provider: {},
  };
}

describe('Wallet Machine FSM - State Transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initial State', () => {
    it('starts in disconnected with empty providers and no selection', () => {
      const actor = createActor(walletMachine, { input: {} }).start();
      const snapshot = actor.getSnapshot();

      expect(snapshot.matches('disconnected')).toBe(true);
      expect(snapshot.context.providers).toEqual([]);
      expect(snapshot.context.selectedRdns).toBeNull();
      expect(snapshot.context.publicKey).toBeNull();

      actor.stop();
    });
  });

  describe('Provider Discovery (EIP-6963)', () => {
    it('registers discovered providers', () => {
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'PROVIDER_DISCOVERED', detail: providerDetail(FREIGHTER_RDNS, 'Freighter') });

      expect(actor.getSnapshot().context.providers).toHaveLength(1);
      expect(actor.getSnapshot().context.providers[0]?.rdns).toBe(FREIGHTER_RDNS);

      actor.stop();
    });

    it('de-duplicates providers by rdns', () => {
      const actor = createActor(walletMachine, { input: {} }).start();
      const detail = providerDetail(FREIGHTER_RDNS, 'Freighter');

      actor.send({ type: 'PROVIDER_DISCOVERED', detail });
      actor.send({ type: 'PROVIDER_DISCOVERED', detail });

      expect(actor.getSnapshot().context.providers).toHaveLength(1);

      actor.stop();
    });

    it('tracks multiple providers without conflict', () => {
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'PROVIDER_DISCOVERED', detail: providerDetail(FREIGHTER_RDNS, 'Freighter') });
      actor.send({ type: 'PROVIDER_DISCOVERED', detail: providerDetail('app.metamask', 'MetaMask') });

      expect(actor.getSnapshot().context.providers.map((p) => p.rdns).sort()).toEqual([
        FREIGHTER_RDNS,
        'app.metamask',
      ]);

      actor.stop();
    });
  });

  describe('Connection Flow', () => {
    it('transitions to connecting on CONNECT', () => {
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'CONNECT' });

      expect(actor.getSnapshot().matches('connecting')).toBe(true);

      actor.stop();
    });

    it('selects a specific wallet on SELECT_WALLET', () => {
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'SELECT_WALLET', rdns: 'app.metamask' });

      expect(actor.getSnapshot().matches('connecting')).toBe(true);
      expect(actor.getSnapshot().context.selectedRdns).toBe('app.metamask');

      actor.stop();
    });

    it('reaches connected.idle on successful connection', async () => {
      mockSuccessfulFreighter();
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'CONNECT' });
      await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

      const snapshot = actor.getSnapshot();
      expect(snapshot.context.publicKey).toBe('GABC123');
      expect(snapshot.context.error).toBeNull();

      actor.stop();
    });

    it('keeps a registered provider while connecting', () => {
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'PROVIDER_DISCOVERED', detail: providerDetail(FREIGHTER_RDNS, 'Freighter') });
      actor.send({ type: 'CONNECT' });

      expect(actor.getSnapshot().matches('connecting')).toBe(true);
      expect(actor.getSnapshot().context.providers).toHaveLength(1);

      actor.stop();
    });
  });

  describe('Hardware Wallet Timeout (connect)', () => {
    it('recovers via RETRY after a connect timeout', async () => {
      vi.useFakeTimers();
      mockSuccessfulFreighter();
      // Hang the connect promise so the hardware-timeout delay fires.
      mockGetPublicKey.mockReturnValue(new Promise(() => {}));

      const actor = createActor(walletMachine, { input: { hardwareTimeoutMs: 1000 } }).start();
      actor.send({ type: 'CONNECT' });

      await vi.advanceTimersByTimeAsync(1000);
      expect(actor.getSnapshot().matches('hardwareTimeoutConnect')).toBe(true);

      actor.send({ type: 'RETRY' });
      expect(actor.getSnapshot().matches('connecting')).toBe(true);

      actor.stop();
    });

    it('cancels a connect timeout back to disconnected', async () => {
      vi.useFakeTimers();
      mockSuccessfulFreighter();
      mockGetPublicKey.mockReturnValue(new Promise(() => {}));

      const actor = createActor(walletMachine, { input: { hardwareTimeoutMs: 1000 } }).start();
      actor.send({ type: 'CONNECT' });

      await vi.advanceTimersByTimeAsync(1000);
      expect(actor.getSnapshot().matches('hardwareTimeoutConnect')).toBe(true);

      actor.send({ type: 'CANCEL' });
      expect(actor.getSnapshot().matches('disconnected')).toBe(true);

      actor.stop();
    });
  });

  describe('Connected States', () => {
    it('disconnects back to disconnected and clears state', async () => {
      mockSuccessfulFreighter();
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'CONNECT' });
      await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

      actor.send({ type: 'DISCONNECT' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.matches('disconnected')).toBe(true);
      expect(snapshot.context.publicKey).toBeNull();

      actor.stop();
    });

    it('flags an external disconnect with an error', async () => {
      mockSuccessfulFreighter();
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'CONNECT' });
      await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

      actor.send({ type: 'EXT_DISCONNECTED' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.matches('disconnected')).toBe(true);
      expect(snapshot.context.publicKey).toBeNull();
      expect(snapshot.context.error).toBe('Wallet was disconnected from the extension.');

      actor.stop();
    });

    it('updates the public key in place on ACCOUNT_CHANGED', async () => {
      mockSuccessfulFreighter('GABC123');
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'CONNECT' });
      await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

      actor.send({ type: 'ACCOUNT_CHANGED', publicKey: 'GNEW...' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.matches({ connected: 'idle' })).toBe(true);
      expect(snapshot.context.publicKey).toBe('GNEW...');

      actor.stop();
    });

    it('moves to wrongNetwork when the network changes to an unsupported one', async () => {
      mockSuccessfulFreighter();
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'CONNECT' });
      await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

      actor.send({ type: 'NETWORK_CHANGED', network: 'public' });

      expect(actor.getSnapshot().matches({ connected: 'wrongNetwork' })).toBe(true);
      expect(actor.getSnapshot().context.publicKey).toBe('GABC123');

      actor.stop();
    });
  });

  describe('Signing Flow', () => {
    it('signs and stores the signed XDR before returning to idle', async () => {
      mockSuccessfulFreighter();
      mockSignTransaction.mockResolvedValue('SIGNED_XDR');

      const actor = createActor(walletMachine, { input: {} }).start();
      actor.send({ type: 'CONNECT' });
      await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

      actor.send({ type: 'SIGN_REQUEST', xdr: 'AAAA...' });
      await waitFor(actor, (s) => s.matches({ connected: 'idle' }) && s.context.lastSignedXdr === 'SIGNED_XDR');

      const snapshot = actor.getSnapshot();
      expect(snapshot.context.pendingSignXdr).toBeNull();
      expect(snapshot.context.lastSignedXdr).toBe('SIGNED_XDR');

      actor.stop();
    });

    it('cancels a signing timeout back to idle with a cancel error', async () => {
      vi.useFakeTimers();
      mockSuccessfulFreighter();

      const actor = createActor(walletMachine, { input: { hardwareTimeoutMs: 1000 } }).start();
      actor.send({ type: 'CONNECT' });
      await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

      mockSignTransaction.mockReturnValue(new Promise(() => {}));
      actor.send({ type: 'SIGN_REQUEST', xdr: 'AAAA...' });

      await vi.advanceTimersByTimeAsync(1000);
      expect(actor.getSnapshot().matches({ connected: 'hardwareTimeoutSign' })).toBe(true);

      actor.send({ type: 'CANCEL' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.matches({ connected: 'idle' })).toBe(true);
      expect(snapshot.context.error).toBe('Signing was cancelled.');

      actor.stop();
    });
  });

  describe('Impossible State Prevention', () => {
    it('ignores SIGN_REQUEST while disconnected', () => {
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'SIGN_REQUEST', xdr: 'AAAA...' });

      expect(actor.getSnapshot().matches('disconnected')).toBe(true);

      actor.stop();
    });

    it('ignores DISCONNECT while already disconnected', () => {
      const actor = createActor(walletMachine, { input: {} }).start();

      actor.send({ type: 'DISCONNECT' });

      expect(actor.getSnapshot().matches('disconnected')).toBe(true);
      expect(actor.getSnapshot().context.error).toBeNull();

      actor.stop();
    });

    it('is never simultaneously connecting and connected', () => {
      const actor = createActor(walletMachine, { input: {} }).start();
      actor.send({ type: 'CONNECT' });

      const snapshot = actor.getSnapshot();
      expect(snapshot.matches('connecting')).toBe(true);
      expect(snapshot.matches('connected')).toBe(false);

      actor.stop();
    });
  });

  describe('Session Persistence', () => {
    it('silently restores a persisted session on startup', async () => {
      window.localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ rdns: FREIGHTER_RDNS, publicKey: 'GABC123' }),
      );
      mockSuccessfulFreighter('GABC123');

      const actor = createActor(walletMachine, { input: {} }).start();
      await waitFor(actor, (s) => s.matches({ connected: 'idle' }));

      expect(actor.getSnapshot().context.publicKey).toBe('GABC123');

      actor.stop();
    });
  });

  describe('Type Safety', () => {
    it('defines every event with a discriminator string', () => {
      const validEvents: WalletMachineEvent[] = [
        { type: 'PROVIDER_DISCOVERED', detail: providerDetail(FREIGHTER_RDNS, 'Freighter') },
        { type: 'CONNECT' },
        { type: 'SELECT_WALLET', rdns: FREIGHTER_RDNS },
        { type: 'RETRY' },
        { type: 'CANCEL' },
        { type: 'DISCONNECT' },
        { type: 'EXT_DISCONNECTED' },
        { type: 'ACCOUNT_CHANGED', publicKey: 'GABCD...' },
        { type: 'NETWORK_CHANGED', network: 'testnet' },
        { type: 'SWITCH_NETWORK' },
        { type: 'SIGN_REQUEST', xdr: 'AAAA...' },
      ];

      for (const event of validEvents) {
        expect(typeof event.type).toBe('string');
      }
    });

    it('exposes a fully-shaped context', () => {
      const actor = createActor(walletMachine, { input: {} }).start();
      const context = actor.getSnapshot().context;

      expect(Array.isArray(context.providers)).toBe(true);
      expect(typeof context.providerDetails).toBe('object');
      expect(context.selectedRdns).toBeNull();
      expect(context.publicKey).toBeNull();
      expect(context.network).toBeNull();
      expect(context.error).toBeNull();

      actor.stop();
    });
  });
});
