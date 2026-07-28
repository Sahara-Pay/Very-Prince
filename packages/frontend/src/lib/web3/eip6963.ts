/**
 * @file eip6963.ts
 * @description Multi-wallet discovery based on the EIP-6963 "Multi Injected
 * Provider Discovery" pattern (https://eips.ethereum.org/EIPS/eip-6963).
 *
 * EIP-6963 was designed to solve exactly the problem this dApp has: when
 * several wallet extensions (Freighter, Hiro/Leather, MetaMask, ...) inject
 * themselves into the page, relying on a single global (`window.freighter`,
 * `window.ethereum`, ...) causes the extensions to silently overwrite one
 * another. Instead, wallets that support the standard announce themselves
 * via a `CustomEvent`, so the dApp can build a conflict-free list of every
 * installed wallet.
 *
 * Not every wallet we care about implements EIP-6963 yet (Freighter and
 * Hiro currently use a single injected global instead), so this module
 * layers a "legacy" discovery pass on top of the real EIP-6963 listener:
 * legacy globals are only added to the result if no EIP-6963 announcement
 * already claimed the same `rdns`, which prevents the exact double-listing
 * bug (e.g. MetaMask appearing twice) that the spec exists to avoid.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type WalletKind = 'stellar' | 'evm' | 'stacks';

export interface WalletProviderInfo {
  /** Stable, unique identifier — reverse-DNS for EIP-6963 announcers. */
  rdns: string;
  /** Human readable wallet name, e.g. "Freighter". */
  name: string;
  /** Data-URI icon, when the wallet provides one. */
  icon?: string;
  /** Which chain family this provider talks to. */
  kind: WalletKind;
  /** How this provider was found — useful for debugging/telemetry. */
  source: 'eip6963' | 'legacy-injected';
}

export interface WalletProviderDetail {
  info: WalletProviderInfo;
  /** The raw injected object (shape depends on `kind`). */
  provider: unknown;
}

type ProviderListener = (detail: WalletProviderDetail) => void;

interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: unknown;
}

interface EIP6963AnnounceProviderEvent extends Event {
  detail: EIP6963ProviderDetail;
}

const ANNOUNCE_EVENT = 'eip6963:announceProvider';
const REQUEST_EVENT = 'eip6963:requestProvider';

/** Legacy (non-EIP-6963) wallets we know how to detect on `window`. */
const LEGACY_DETECTORS: Array<{
  rdns: string;
  name: string;
  kind: WalletKind;
  detect: () => unknown | undefined;
}> = [
  {
    rdns: 'app.freighter',
    name: 'Freighter',
    kind: 'stellar',
    detect: () => (typeof window !== 'undefined' ? (window as any).freighter : undefined),
  },
  {
    rdns: 'co.hiro.wallet',
    name: 'Hiro Wallet',
    kind: 'stacks',
    detect: () => (typeof window !== 'undefined' ? (window as any).HiroWalletProvider : undefined),
  },
  {
    rdns: 'io.metamask',
    name: 'MetaMask',
    kind: 'evm',
    detect: () =>
      typeof window !== 'undefined' && (window as any).ethereum?.isMetaMask
        ? (window as any).ethereum
        : undefined,
  },
];

/** Small grace period given to real EIP-6963 announcements before we fall back to legacy globals. */
const LEGACY_SCAN_DELAY_MS = 150;

/**
 * Subscribes to wallet provider discovery. Calls `onProvider` once per
 * unique `rdns`, in the order providers are found (EIP-6963 announcements
 * first, legacy globals afterwards). Returns an unsubscribe function.
 */
export function subscribeToProviders(onProvider: ProviderListener): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const seenRdns = new Set<string>();

  const emit = (detail: WalletProviderDetail) => {
    if (seenRdns.has(detail.info.rdns)) return;
    seenRdns.add(detail.info.rdns);
    onProvider(detail);
  };

  const handleAnnouncement = (event: Event) => {
    const { detail } = event as EIP6963AnnounceProviderEvent;
    if (!detail?.info?.rdns) return;

    emit({
      info: {
        rdns: detail.info.rdns,
        name: detail.info.name,
        icon: detail.info.icon,
        kind: 'evm',
        source: 'eip6963',
      },
      provider: detail.provider,
    });
  };

  window.addEventListener(ANNOUNCE_EVENT, handleAnnouncement);
  // Ask already-loaded wallet scripts to (re-)announce themselves.
  window.dispatchEvent(new Event(REQUEST_EVENT));

  const legacyScanTimer = window.setTimeout(() => {
    for (const detector of LEGACY_DETECTORS) {
      const provider = detector.detect();
      if (!provider) continue;

      emit({
        info: {
          rdns: detector.rdns,
          name: detector.name,
          kind: detector.kind,
          source: 'legacy-injected',
        },
        provider,
      });
    }
  }, LEGACY_SCAN_DELAY_MS);

  return () => {
    window.removeEventListener(ANNOUNCE_EVENT, handleAnnouncement);
    window.clearTimeout(legacyScanTimer);
  };
}
