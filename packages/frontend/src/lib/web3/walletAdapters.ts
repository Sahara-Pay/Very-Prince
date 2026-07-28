/**
 * @file walletAdapters.ts
 * @description Normalizes every discovered wallet (see `eip6963.ts`) behind a
 * single `WalletAdapter` interface so `walletMachine.ts` never has to know
 * which extension it is talking to.
 *
 * Only Freighter is fully wired up today — it is the wallet this dApp
 * actually transacts with on Stellar. Other wallets picked up by the
 * EIP-6963 discovery layer (Hiro, MetaMask, ...) still get a real adapter so
 * they show up in the UI without conflicting with Freighter, but connecting
 * to them raises a clear "not supported yet" error instead of pretending to
 * work.
 */

import freighterApi from '@stellar/freighter-api';
import type { WalletProviderDetail } from './eip6963';

export type NetworkType = 'public' | 'testnet';

export const REQUIRED_NETWORK: NetworkType = 'testnet';

export interface WalletConnectResult {
  publicKey: string;
  network: NetworkType;
}

export interface WalletAdapter {
  connect(): Promise<WalletConnectResult>;
  getNetwork(): Promise<NetworkType>;
  signTransaction(transactionXdr: string, network: NetworkType): Promise<string>;
}

// ── Freighter (Stellar) ──────────────────────────────────────────────────────

const NETWORK_PASSPHRASE: Record<NetworkType, string> = {
  public: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
};

function toNetworkType(raw: string | undefined): NetworkType {
  return raw === 'PUBLIC' ? 'public' : 'testnet';
}

export const freighterAdapter: WalletAdapter = {
  async connect() {
    const installed = await freighterApi.isConnected();
    if (!installed) {
      throw new Error('Freighter wallet is not installed. Please install it to continue.');
    }

    const publicKey = await freighterApi.getPublicKey();
    if (!publicKey) {
      throw new Error('Failed to get public key from Freighter wallet.');
    }

    const network = toNetworkType(await freighterApi.getNetwork());
    if (network !== REQUIRED_NETWORK) {
      throw new Error('Please switch to Stellar Testnet in Freighter.');
    }

    return { publicKey, network };
  },

  async getNetwork() {
    return toNetworkType(await freighterApi.getNetwork());
  },

  async signTransaction(transactionXdr: string, network: NetworkType) {
    const signedTxXdr = await freighterApi.signTransaction(transactionXdr, {
      network: network === 'public' ? 'PUBLIC' : 'TESTNET',
      networkPassphrase: NETWORK_PASSPHRASE[network],
    });

    if (!signedTxXdr) {
      throw new Error('Transaction signing was rejected or failed.');
    }

    return signedTxXdr;
  },
};

// ── Not-yet-supported wallets (still discoverable, just can't transact) ─────

function unsupportedAdapter(displayName: string): WalletAdapter {
  const message = `${displayName} is discovered but not yet supported for signing on this dApp.`;
  return {
    async connect(): Promise<WalletConnectResult> {
      throw new Error(message);
    },
    async getNetwork(): Promise<NetworkType> {
      throw new Error(message);
    },
    async signTransaction(): Promise<string> {
      throw new Error(message);
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function getWalletAdapter(rdns: string, detail?: WalletProviderDetail): WalletAdapter {
  if (rdns === 'app.freighter') return freighterAdapter;
  return unsupportedAdapter(detail?.info.name ?? rdns);
}
