/**
 * @file crypto-sandbox-worker.ts
 * @description Off-main-thread signing worker for the Ed25519 sandbox.
 *
 * This module is loaded into a dedicated `Worker` (created in
 * `crypto-sandbox-client.ts`). The worker:
 *
 *   1. Initialises the inline WebAssembly primitives (see `wasm-primitives.ts`).
 *   2. Generates Ed25519 keys **inside** the worker via
 *      `crypto.getRandomValues`, stores the resulting `Keypair`s in an
 *      internal `Map<handle, …>` keyed by an opaque integer handle, and
 *      returns *only* the 32-byte public key to the main thread. The seed
 *      (and the `Keypair` itself) is never copied across the thread.
 *   3. Reads sign requests from the `SharedArrayBuffer` passed in via
 *      `init`, signs via the stored `Keypair`, writes the resulting
 *      signature back, sets `STATUS_DONE`, and notifies the main thread
 *      via `Atomics.notify`.
 *
 * The `createWorkerModule(self)` factory keeps everything testable from
 * Vitest (where `self` is a fake). In production Next.js, the bottom of
 * this file auto-binds it when this module executes inside a real
 * `DedicatedWorkerGlobalScope`.
 */

import { Keypair, StrKey } from '@stellar/stellar-sdk';

import {
  SLOT,
  SLOT_INT32,
  STATUS_DONE,
  STATUS_ERROR,
  STATUS_PROCESSING,
  STATUS_REQUEST,
  MESSAGE_MAX_BYTES,
  PRIVATE_KEY_BYTES,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  ERROR_INVALID_MSG_LEN,
  ERROR_SIGNING_FAILED,
  ERROR_UNKNOWN_HANDLE,
  ERROR_WASM_INIT_FAILED,
  assertSABShape,
  type SigningViews,
  type WorkerInboundMessage,
  type WorkerOutboundMessage,
} from './protocol';
import { assertWorkerReady, instantiateCryptoWasm } from './wasm-primitives';

// ── Keypair construction helper ──────────────────────────────────────────────
//
// Builds a `Keypair` from raw 32-byte Ed25519 seed bytes. Uses the modern
// `fromRawEd25519Seed` constructor when available, otherwise falls back to
// `StrKey.encodeEd25519SecretSeed(seed) → Keypair.fromSecret(secret)` so it
// works on either recent or slightly older `@stellar/stellar-sdk` releases.

function keypairFromRawSeed(rawSeed: Uint8Array): Keypair {
  if (rawSeed.byteLength !== PRIVATE_KEY_BYTES) {
    throw new RangeError(`Seed must be ${PRIVATE_KEY_BYTES} bytes, got ${rawSeed.byteLength}`);
  }
  const fromRaw = (Keypair as unknown as { fromRawEd25519Seed?: (b: Buffer) => Keypair }).fromRawEd25519Seed;
  if (typeof fromRaw === 'function') {
    return fromRaw(Buffer.from(rawSeed));
  }
  const secret = StrKey.encodeEd25519SecretSeed(rawSeed);
  return Keypair.fromSecret(secret);
}

function rawPublicKeyOf(keypair: Keypair): Uint8Array {
  const buf = keypair.rawPublicKey();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ── Worker module factory (testable) ─────────────────────────────────────────

/**
 * A minimal subset of `DedicatedWorkerGlobalScope` used by the worker
 * module. We type it narrowly so unit tests can pass a fake object.
 */
export interface SandboxWorkerSelf {
  onmessage: ((event: MessageEvent<WorkerInboundMessage>) => void) | null;
  postMessage: (message: WorkerOutboundMessage) => void;
  close?: () => void;
  SharedArrayBuffer?: unknown;
  Atomics?: unknown;
  WebAssembly?: unknown;
  crypto?: { getRandomValues?: <T extends ArrayBufferView>(view: T) => T };
  crossOriginIsolated?: boolean;
  WorkerGlobalScope?: unknown;
}

interface WorkerState {
  views: SigningViews | null;
  wasReady: boolean;
  /** seed handle → opaque `Keypair`. Never crosses the thread. */
  seeds: Map<number, Keypair>;
  nextHandle: number;
}

function emptyState(): WorkerState {
  return { views: null, wasReady: false, seeds: new Map(), nextHandle: 1 };
}

/**
 * Boot the worker against a fake or real `self`. Returns a handle exposing
 * internals for tests — in production code the side-effects (binding
 * `self.onmessage`, posting messages) are all that matters.
 */
export function createWorkerModule(self: SandboxWorkerSelf): {
  state: WorkerState;
} {
  const state = emptyState();

  // ── Helpers ──────────────────────────────────────────────────────────────

  function setError(reason: number): void {
    if (!state.views) return;
    Atomics.store(state.views.int32, SLOT_INT32.STATUS, STATUS_ERROR);
    Atomics.store(state.views.int32, SLOT_INT32.SIG_LEN, reason);
    Atomics.notify(state.views.int32, SLOT_INT32.STATUS, 1);
  }

  function post(message: WorkerOutboundMessage): void {
    try {
      self.postMessage(message);
    } catch {
      // Main thread may have already terminated. Swallow.
    }
  }

  async function handleInit(sab: SharedArrayBuffer): Promise<void> {
    assertSABShape(sab);
    assertWorkerReady(self as unknown as Parameters<typeof assertWorkerReady>[0]);
    try {
      await instantiateCryptoWasm(self as unknown as Parameters<typeof instantiateCryptoWasm>[0]);
    } catch (err) {
      post({
        type: 'error',
        message: `WASM init failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      setError(ERROR_WASM_INIT_FAILED);
      return;
    }
    state.views = {
      int32: new Int32Array(sab),
      bytes: new Uint8Array(sab),
    };
    state.wasReady = true;
    post({ type: 'ready' });
  }

  function handleCreateKey(): void {
    if (!self.crypto?.getRandomValues) {
      post({ type: 'error', message: 'crypto.getRandomValues is unavailable in this worker context.' });
      return;
    }
    const seed = new Uint8Array(PRIVATE_KEY_BYTES);
    self.crypto.getRandomValues(seed);

    let keypair: Keypair;
    try {
      keypair = keypairFromRawSeed(seed);
    } catch (err) {
      post({
        type: 'error',
        message: `Failed to construct keypair: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let publicKey: Uint8Array;
    try {
      publicKey = rawPublicKeyOf(keypair);
    } catch (err) {
      post({
        type: 'error',
        message: `Failed to extract public key: ${err instanceof Error ? err.message : String(err)}`,
      });
      // Wipe the half-built keypair so the seed never lingers.
      state.seeds.delete(state.nextHandle);
      return;
    }
    if (publicKey.byteLength !== PUBLIC_KEY_BYTES) {
      post({ type: 'error', message: 'Derived public key has unexpected length.' });
      state.seeds.delete(state.nextHandle);
      return;
    }

    const handle = state.nextHandle;
    state.nextHandle += 1;
    state.seeds.set(handle, keypair);

    post({ type: 'key-created', handle, publicKey });
  }

  function handleDisposeKey(handle: number): void {
    state.seeds.delete(handle);
    post({ type: 'ready' });
  }

  async function handleSignFromSAB(): Promise<void> {
    if (!state.views) {
      setError(ERROR_UNKNOWN_HANDLE);
      return;
    }
    const views = state.views;

    // Read the request from the SAB. The main thread is responsible for
    // having set these *before* posting this message, but we re-validate
    // everything an attacker could tamper with.
    const seedHandle = Atomics.load(views.int32, SLOT_INT32.SEED_HANDLE);
    const msgLen = Atomics.load(views.int32, SLOT_INT32.MSG_LEN);
    if (msgLen < 0 || msgLen > MESSAGE_MAX_BYTES) {
      setError(ERROR_INVALID_MSG_LEN);
      return;
    }
    const keypair = state.seeds.get(seedHandle);
    if (!keypair) {
      setError(ERROR_UNKNOWN_HANDLE);
      return;
    }

    // Acknowledge we are using the buffer — re-set to PROCESSING so any
    // external poller knows work has started.
    Atomics.store(views.int32, SLOT_INT32.STATUS, STATUS_PROCESSING);

    // Snapshot the message bytes before signing (defensive copy so the
    // sign function can re-use / mutate safely).
    const message = views.bytes.slice(SLOT.MESSAGE, SLOT.MESSAGE + msgLen);

    let signature: Uint8Array;
    try {
      // `Keypair.sign` is synchronous and runs entirely inside the worker
      // thread. It encapsulates the underlying Ed25519 implementation
      // (sha-512 + curve math) without ever exposing the seed material to
      // the main-thread.
      const buf = keypair.sign(Buffer.from(message));
      signature = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      post({
        type: 'error',
        message: `Keypair.sign failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      setError(ERROR_SIGNING_FAILED);
      return;
    }
    if (signature.byteLength !== SIGNATURE_BYTES) {
      setError(ERROR_SIGNING_FAILED);
      return;
    }

    // Write the 64 signature bytes back into the SAB.
    views.bytes.set(signature, SLOT.SIGNATURE);
    Atomics.store(views.int32, SLOT_INT32.SIG_LEN, SIGNATURE_BYTES);
    Atomics.store(views.int32, SLOT_INT32.STATUS, STATUS_DONE);
    Atomics.notify(views.int32, SLOT_INT32.STATUS, 1);
  }

  function handleDispose(): void {
    state.seeds.clear();
    state.views = null;
    if (typeof self.close === 'function') self.close();
  }

  // ── Bind `onmessage` ────────────────────────────────────────────────────
  self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        void handleInit(msg.sab);
        return;
      case 'create-key':
        handleCreateKey();
        return;
      case 'dispose-key':
        handleDisposeKey(msg.handle);
        return;
      case 'sign-from-sab':
        void handleSignFromSAB();
        return;
      case 'dispose':
        handleDispose();
        return;
      default: {
        // Exhaustiveness check — any unknown message type posts an error
        // back to the main thread so callers fail loudly instead of
        // hanging in `Atomics.wait`.
        const _exhaustive: never = msg;
        void _exhaustive;
        post({ type: 'error', message: `Unknown message type: ${(msg as { type: string }).type}` });
      }
    }
  };

  return { state };
}

// ── Auto-bind when this module executes inside a real dedicated worker ───
//
// We detect worker-ness via `self instanceof WorkerGlobalScope`. Vitest
// unit tests use `createWorkerModule(fakeSelf)` directly and will not hit
// this branch — `self` in jsdom is a `Window`, not a `WorkerGlobalScope`.

declare const self: SandboxWorkerSelf | undefined;

if (
  typeof self !== 'undefined' &&
  self.WorkerGlobalScope !== undefined &&
  typeof (globalThis as { WorkerGlobalScope?: { prototype: DedicatedWorkerGlobalScope } }).WorkerGlobalScope === 'object'
) {
  const W = (globalThis as { WorkerGlobalScope: { prototype: DedicatedWorkerGlobalScope } }).WorkerGlobalScope;
  if (self instanceof W.prototype) {
    createWorkerModule(self);
  }
}
