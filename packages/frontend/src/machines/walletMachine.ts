/**
 * @file walletMachine.ts
 * @description XState v5 finite state machine governing the wallet auth
 * lifecycle: discovery of installed wallet extensions (EIP-6963 +
 * legacy-injected fallbacks), connecting, session persistence across page
 * reloads, and hardware wallet (Ledger) timeouts with user recovery prompts.
 *
 * ## The 12 edge cases this machine explicitly models
 *
 *  1. No wallet extension installed           → `connecting` onError (generic)
 *  2. Multiple extensions installed at once   → `providers` list, deduped by rdns
 *  3. User picks a specific wallet to connect → `SELECT_WALLET`
 *  4. User rejects the connection request     → `connecting` onError (isUserRejection)
 *  5. Wrong network at connect time           → `connecting` onError (generic message)
 *  6. Network changed while connected         → `connected.wrongNetwork`
 *  7. Account switched while connected        → `ACCOUNT_CHANGED`
 *  8. Wallet disconnected/revoked externally  → `EXT_DISCONNECTED`
 *  9. Hardware wallet timeout while connecting→ `hardwareTimeoutConnect`
 * 10. Hardware wallet timeout while signing   → `connected.hardwareTimeoutSign`
 * 11. Session restore on load succeeds        → `disconnected` → auto `connecting` (silent)
 * 12. Session restore fails (stale/revoked)   → silent restore onError → `disconnected`, no banner
 */

import { setup, assign } from 'xstate';
import { fromPromise } from 'xstate/actors';
import type { WalletProviderDetail, WalletProviderInfo } from '../lib/web3/eip6963';
import { getWalletAdapter, REQUIRED_NETWORK, type NetworkType } from '../lib/web3/walletAdapters';

// ── Session persistence ───────────────────────────────────────────────────────

const SESSION_STORAGE_KEY = 'very-prince.wallet-session';

interface PersistedSession {
  rdns: string;
  publicKey: string;
}

function loadPersistedSession(): PersistedSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedSession) : null;
  } catch {
    return null;
  }
}

function persistSession(session: PersistedSession): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable (private browsing / quota) — session just won't survive reload.
  }
}

function clearPersistedSession(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown wallet error';
}

function isTimeoutMessage(message: string): boolean {
  return /timeout/i.test(message);
}

function isRejectionMessage(message: string): boolean {
  return /reject|denied|declined|cancel/i.test(message);
}

const DEFAULT_HARDWARE_TIMEOUT_MS = 30_000;

// ── Context & events ───────────────────────────────────────────────────────

export interface WalletMachineContext {
  providers: WalletProviderInfo[];
  providerDetails: Record<string, WalletProviderDetail>;
  selectedRdns: string | null;
  publicKey: string | null;
  network: NetworkType | null;
  error: string | null;
  silentRestore: boolean;
  restoreAttempted: boolean;
  pendingSignXdr: string | null;
  lastSignedXdr: string | null;
  hardwareTimeoutMs: number;
}

export type WalletMachineEvent =
  | { type: 'PROVIDER_DISCOVERED'; detail: WalletProviderDetail }
  | { type: 'CONNECT' }
  | { type: 'SELECT_WALLET'; rdns: string }
  | { type: 'RETRY' }
  | { type: 'CANCEL' }
  | { type: 'DISCONNECT' }
  | { type: 'EXT_DISCONNECTED' }
  | { type: 'ACCOUNT_CHANGED'; publicKey: string | null }
  | { type: 'NETWORK_CHANGED'; network: NetworkType }
  | { type: 'SWITCH_NETWORK' }
  | { type: 'SIGN_REQUEST'; xdr: string };

function preferredRdns(context: WalletMachineContext): string {
  return (
    context.selectedRdns ??
    context.providers.find((p) => p.rdns === 'app.freighter')?.rdns ??
    context.providers[0]?.rdns ??
    'app.freighter'
  );
}

export const walletMachine = setup({
  types: {} as {
    context: WalletMachineContext;
    events: WalletMachineEvent;
    input: { hardwareTimeoutMs?: number };
  },
  actors: {
    connectActor: fromPromise<
      { publicKey: string; network: NetworkType },
      { rdns: string; detail: WalletProviderDetail | undefined }
    >(async ({ input }) => getWalletAdapter(input.rdns, input.detail).connect()),
    signActor: fromPromise<
      string,
      { rdns: string; detail: WalletProviderDetail | undefined; xdr: string; network: NetworkType }
    >(async ({ input }) => getWalletAdapter(input.rdns, input.detail).signTransaction(input.xdr, input.network)),
  },
  guards: {
    hasPersistedSession: ({ context }) => !context.restoreAttempted && loadPersistedSession() !== null,
  },
  actions: {
    registerProvider: assign({
      providers: ({ context, event }) => {
        if (event.type !== 'PROVIDER_DISCOVERED') return context.providers;
        if (context.providers.some((p) => p.rdns === event.detail.info.rdns)) return context.providers;
        return [...context.providers, event.detail.info];
      },
      providerDetails: ({ context, event }) => {
        if (event.type !== 'PROVIDER_DISCOVERED') return context.providerDetails;
        return { ...context.providerDetails, [event.detail.info.rdns]: event.detail };
      },
    }),
    selectProvider: assign({
      selectedRdns: ({ event }) => (event.type === 'SELECT_WALLET' ? event.rdns : null),
      error: null,
    }),
    selectDefaultProvider: assign({
      selectedRdns: ({ context }) => preferredRdns(context),
      error: null,
    }),
    beginSilentRestore: assign(({ context }) => {
      const session = loadPersistedSession();
      return {
        selectedRdns: session?.rdns ?? context.selectedRdns,
        silentRestore: true,
        restoreAttempted: true,
      };
    }),
    endSilentRestore: assign({ silentRestore: false }),
    persistCurrentSession: ({ context }) => {
      if (context.selectedRdns && context.publicKey) {
        persistSession({ rdns: context.selectedRdns, publicKey: context.publicKey });
      }
    },
    assignSilentRestoreFailure: assign({
      error: null,
      publicKey: null,
      network: null,
    }),
    assignHardwareTimeoutError: assign({
      error: 'The hardware wallet did not respond in time. Confirm the action on your device, then retry.',
    }),
    clearSession: assign({
      publicKey: null,
      network: null,
      pendingSignXdr: null,
      lastSignedXdr: null,
      error: null,
    }),
    clearSessionStorage: () => clearPersistedSession(),
    assignExternalDisconnectError: assign({
      error: 'Wallet was disconnected from the extension.',
    }),
    assignAccountChanged: assign({
      publicKey: ({ event }) => (event.type === 'ACCOUNT_CHANGED' ? event.publicKey : null),
    }),
    assignNetwork: assign({
      network: ({ event }) => (event.type === 'NETWORK_CHANGED' ? event.network : null),
    }),
    assignPendingSign: assign({
      pendingSignXdr: ({ event }) => (event.type === 'SIGN_REQUEST' ? event.xdr : null),
      lastSignedXdr: null,
      error: null,
    }),
    assignSignCancelled: assign({
      error: 'Signing was cancelled.',
      pendingSignXdr: null,
      lastSignedXdr: null,
    }),
  },
  delays: {
    HARDWARE_TIMEOUT: ({ context }) => context.hardwareTimeoutMs,
  },
}).createMachine({
  id: 'wallet',
  context: ({ input }) => ({
    providers: [],
    providerDetails: {},
    selectedRdns: null,
    publicKey: null,
    network: null,
    error: null,
    silentRestore: false,
    restoreAttempted: false,
    pendingSignXdr: null,
    lastSignedXdr: null,
    hardwareTimeoutMs: input?.hardwareTimeoutMs ?? DEFAULT_HARDWARE_TIMEOUT_MS,
  }),
  on: {
    // Providers can announce themselves at any point in the lifecycle.
    PROVIDER_DISCOVERED: { actions: 'registerProvider' },
  },
  initial: 'disconnected',
  states: {
    disconnected: {
      always: {
        guard: 'hasPersistedSession',
        target: 'connecting',
        actions: 'beginSilentRestore',
      },
      on: {
        SELECT_WALLET: { target: 'connecting', actions: 'selectProvider' },
        CONNECT: { target: 'connecting', actions: 'selectDefaultProvider' },
      },
    },
    connecting: {
      invoke: {
        id: 'connect',
        src: 'connectActor',
        input: ({ context }) => ({
          rdns: preferredRdns(context),
          detail: context.providerDetails[preferredRdns(context)],
        }),
        onDone: {
          target: 'connected',
          actions: [
            assign({
              publicKey: ({ event }) => event.output.publicKey,
              network: ({ event }) => event.output.network,
              error: null,
            }),
            'persistCurrentSession',
            'endSilentRestore',
          ],
        },
        onError: [
          {
            guard: ({ event }) => isTimeoutMessage(errorMessage(event.error)),
            target: 'hardwareTimeoutConnect',
          },
          {
            // Edge case #12: a silent (background) session-restore attempt failed
            // (revoked permission, uninstalled extension, wrong network, ...).
            // Fail quietly — the user never asked for this attempt, so no error banner.
            guard: ({ context }) => context.silentRestore,
            target: 'disconnected',
            actions: ['assignSilentRestoreFailure', 'clearSessionStorage', 'endSilentRestore'],
          },
          {
            guard: ({ event }) => isRejectionMessage(errorMessage(event.error)),
            target: 'disconnected',
            actions: [
              assign({ error: ({ event }) => errorMessage(event.error) }),
              'clearSessionStorage',
              'endSilentRestore',
            ],
          },
          {
            target: 'disconnected',
            actions: [
              assign({ error: ({ event }) => errorMessage(event.error) }),
              'clearSessionStorage',
              'endSilentRestore',
            ],
          },
        ],
      },
      after: {
        HARDWARE_TIMEOUT: { target: 'hardwareTimeoutConnect' },
      },
    },
    hardwareTimeoutConnect: {
      entry: 'assignHardwareTimeoutError',
      on: {
        RETRY: 'connecting',
        CANCEL: { target: 'disconnected', actions: ['clearSessionStorage', 'endSilentRestore'] },
      },
    },
    connected: {
      initial: 'idle',
      on: {
        DISCONNECT: { target: 'disconnected', actions: ['clearSession', 'clearSessionStorage'] },
        EXT_DISCONNECTED: {
          target: 'disconnected',
          actions: ['clearSession', 'clearSessionStorage', 'assignExternalDisconnectError'],
        },
        ACCOUNT_CHANGED: { actions: ['assignAccountChanged', 'persistCurrentSession'] },
        NETWORK_CHANGED: [
          {
            guard: ({ event }) => event.type === 'NETWORK_CHANGED' && event.network !== REQUIRED_NETWORK,
            target: '.wrongNetwork',
            actions: 'assignNetwork',
          },
          { target: '.idle', actions: 'assignNetwork' },
        ],
      },
      states: {
        idle: {
          on: {
            SIGN_REQUEST: { target: 'signing', actions: 'assignPendingSign' },
          },
        },
        wrongNetwork: {
          on: {
            SWITCH_NETWORK: { target: 'idle', actions: 'assignNetwork' },
          },
        },
        signing: {
          invoke: {
            id: 'sign',
            src: 'signActor',
            input: ({ context }) => ({
              rdns: preferredRdns(context),
              detail: context.providerDetails[preferredRdns(context)],
              xdr: context.pendingSignXdr!,
              network: context.network!,
            }),
            onDone: {
              target: 'idle',
              actions: assign({
                lastSignedXdr: ({ event }) => event.output,
                pendingSignXdr: null,
                error: null,
              }),
            },
            onError: [
              {
                guard: ({ event }) => isTimeoutMessage(errorMessage(event.error)),
                target: 'hardwareTimeoutSign',
              },
              {
                target: 'idle',
                actions: assign({
                  error: ({ event }) => errorMessage(event.error),
                  pendingSignXdr: null,
                  lastSignedXdr: null,
                }),
              },
            ],
          },
          after: {
            HARDWARE_TIMEOUT: { target: 'hardwareTimeoutSign' },
          },
        },
        hardwareTimeoutSign: {
          entry: 'assignHardwareTimeoutError',
          on: {
            RETRY: 'signing',
            CANCEL: { target: 'idle', actions: 'assignSignCancelled' },
          },
        },
      },
    },
  },
});

export type WalletMachine = typeof walletMachine;
