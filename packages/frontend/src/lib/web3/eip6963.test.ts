import { describe, it, expect, vi, afterEach } from 'vitest';
import { subscribeToProviders } from './eip6963';

function announce(rdns: string, name: string) {
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: rdns, name, icon: '', rdns }, provider: {} },
    })
  );
}

describe('subscribeToProviders', () => {
  afterEach(() => {
    delete (window as any).freighter;
    delete (window as any).HiroWalletProvider;
    delete (window as any).ethereum;
    vi.useRealTimers();
  });

  it('reports real EIP-6963 announcements immediately', () => {
    const onProvider = vi.fn();
    const unsubscribe = subscribeToProviders(onProvider);

    announce('io.metamask', 'MetaMask');

    expect(onProvider).toHaveBeenCalledTimes(1);
    expect(onProvider.mock.calls[0][0].info).toMatchObject({ rdns: 'io.metamask', source: 'eip6963' });
    unsubscribe();
  });

  it('falls back to legacy-injected wallets after the grace period, without duplicating an already-announced one', async () => {
    vi.useFakeTimers();
    (window as any).freighter = {};
    (window as any).ethereum = { isMetaMask: true };

    const onProvider = vi.fn();
    subscribeToProviders(onProvider);

    // MetaMask announces itself the "real" way — legacy scan must not also add it.
    announce('io.metamask', 'MetaMask');

    await vi.advanceTimersByTimeAsync(200);

    const rdnsSeen = onProvider.mock.calls.map((call) => call[0].info.rdns).sort();
    expect(rdnsSeen).toEqual(['app.freighter', 'io.metamask']);
  });

  it('stops emitting after unsubscribe', () => {
    const onProvider = vi.fn();
    const unsubscribe = subscribeToProviders(onProvider);
    unsubscribe();

    announce('io.metamask', 'MetaMask');

    expect(onProvider).not.toHaveBeenCalled();
  });
});
