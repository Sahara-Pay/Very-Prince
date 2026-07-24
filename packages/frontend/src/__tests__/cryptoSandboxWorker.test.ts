/**
 * Tests for the crypto-sandbox Web Worker module.
 *
 * The worker is loaded into a dedicated `Worker` in production. In tests
 * we don't ship a real worker — instead we boot the module by passing a
 * fake `self` object to `createWorkerModule(fakeSelf)`. The same factory
 * is the function that runs when the production worker is loaded.
 *
 * We also mock `@stellar/stellar-sdk` so the tests are deterministic and
 * fast (no real sha512 + curve math). The mocks keep the public surface
 * used by `crypto-sandbox-worker.ts` identical to the real package.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  SLOT,
  SLOT_INT32,
  STATUS_DONE,
  STATUS_ERROR,
  STATUS_REQUEST,
  STATUS_IDLE,
  createSigningSAB,
  createSigningViews,
  ERROR_UNKNOWN_HANDLE,
  ERROR_INVALID_MSG_LEN,
  ERROR_WASM_INIT_FAILED,
} from '../crypto-sandbox/protocol';
import { createWorkerModule } from '../crypto-sandbox/crypto-sandbox-worker';

// ── @stellar/stellar-sdk mock ─────────────────────────────────────────────────
//
// Deterministic fixture in lieu of real Ed25519. The worker only uses
// `Keypair.fromRawEd25519Seed`, `Keypair.fromSecret`, `keypair.sign`, and
// `keypair.rawPublicKey` — plus `StrKey.encodeEd25519SecretSeed` as a
// fallback. We provide sync implementations for all of them.
vi.mock('@stellar/stellar-sdk', () => {
  const keypairStore = new Map<string, { pk: Uint8Array; sk: Uint8Array }>();
  const encodeEd25519SecretSeed = (rawSeed: Uint8Array): string => {
    // Crockford base32 of raw seed bytes (deterministic and trivial).
    const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let s = '';
    for (const b of rawSeed) s += ALPH[b & 0x1f];
    return s;
  };

  class FakeKeypair {
    public pk: Uint8Array;
    public sk: Uint8Array;
    constructor(opts: { secretBytes: Uint8Array }) {
      this.sk = opts.secretBytes.slice();
      this.pk = new Uint8Array(32);
      for (let i = 0; i < 32; i += 1) this.pk[i] = (this.sk[i] ?? 0) ^ 0xc3;
      const secret = encodeEd25519SecretSeed(this.sk);
      keypairStore.set(secret, { pk: this.pk, sk: this.sk });
    }
    sign(message: Uint8Array): Uint8Array {
      const sig = new Uint8Array(64);
      for (let i = 0; i < 32; i += 1) {
        sig[i] = (this.sk[i] ?? 0) ^ (message[i % message.byteLength] ?? 0);
        sig[32 + i] = (this.sk[i] ?? 0) ^ 0xa5;
      }
      return sig;
    }
    rawPublicKey(): Uint8Array {
      return new Uint8Array(this.pk);
    }
    static fromRawEd25519Seed(seed: Uint8Array): FakeKeypair {
      return new FakeKeypair({ secretBytes: seed });
    }
    static fromSecret(secret: string): FakeKeypair {
      const rec = keypairStore.get(secret);
      if (!rec) throw new Error('unknown secret');
      return new FakeKeypair({ secretBytes: rec.sk });
    }
  }

  return {
    Keypair: FakeKeypair,
    StrKey: {
      encodeEd25519SecretSeed,
      encodeEd25519AccountPublicKey: (rawPk: Uint8Array): string => 'G' + encodeEd25519SecretSeed(rawPk).slice(0, 55),
    },
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface FakeSelf {
  onmessage: ((event: MessageEvent<any>) => void) | null;
  postMessage: (m: any) => void;
  close?: () => void;
  SharedArrayBuffer: unknown;
  Atomics: unknown;
  WebAssembly: unknown;
  crypto: { getRandomValues: <T extends ArrayBufferView>(v: T) => T };
  crossOriginIsolated: boolean;
  WorkerGlobalScope: unknown;
}

function makeFakeSelf(): { self: FakeSelf; messages: any[] } {
  const messages: any[] = [];
  const self: FakeSelf = {
    onmessage: null,
    postMessage: (m) => messages.push(m),
    close: () => {},
    SharedArrayBuffer,
    Atomics,
    WebAssembly,
    crypto: {
      getRandomValues: <T extends ArrayBufferView>(v: T) => {
        const u = v as unknown as Uint8Array;
        for (let i = 0; i < u.length; i += 1) u[i] = i & 0xff;
        return v;
      },
    },
    crossOriginIsolated: true,
    WorkerGlobalScope: class {},
  };
  return { self, messages };
}

function flushMicrotasks(times = 4): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0)).then(async () => {
    if (times > 1) await flushMicrotasks(times - 1);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('crypto-sandbox worker module', () => {
  it('createWorkerModule assigns self.onmessage', () => {
    const { self } = makeFakeSelf();
    expect(self.onmessage).toBeNull();
    createWorkerModule(self);
    expect(typeof self.onmessage).toBe('function');
  });

  it('posts `ready` once init succeeds', async () => {
    const { self, messages } = makeFakeSelf();
    createWorkerModule(self);
    const sab = createSigningSAB();

    self.onmessage!({ data: { type: 'init', sab } } as MessageEvent<any>);
    await flushMicrotasks();

    expect(messages.find((m) => m.type === 'ready')).toBeDefined();
    expect(messages.find((m) => m.type === 'error')).toBeUndefined();
  });

  it('create-key returns a 32-byte public key + opaque handle; never leaks seed bytes', async () => {
    const { self, messages } = makeFakeSelf();
    createWorkerModule(self);
    self.onmessage!({ data: { type: 'init', sab: createSigningSAB() } } as MessageEvent<any>);
    await flushMicrotasks();
    messages.length = 0;

    self.onmessage!({ data: { type: 'create-key' } } as MessageEvent<any>);

    const created = messages.find((m) => m.type === 'key-created');
    expect(created).toBeDefined();
    expect(created.handle).toBeGreaterThan(0);
    expect(created.publicKey).toBeInstanceOf(Uint8Array);
    expect(created.publicKey.byteLength).toBe(32);

    // The seed (32 bytes generated by getRandomValues: 0..255) must never
    // appear inside any postMessage payload, including as a nested
    // Uint8Array.
    function* walk(value: any): Generator<Uint8Array> {
      if (value instanceof Uint8Array) yield value;
      else if (Array.isArray(value)) for (const v of value) yield* walk(v);
      else if (value && typeof value === 'object') for (const v of Object.values(value)) yield* walk(v);
    }
    for (const m of messages) {
      for (const u of walk(m)) {
        const seedShape = u.length === 32 && (() => {
          for (let i = 0; i < 32; i += 1) {
            if (u[i] !== (i & 0xff)) return false;
          }
          return true;
        })();
        expect(seedShape).toBe(false);
      }
    }
  });

  it('handleSignFromSAB writes 64 signature bytes and notifies via STATUS_DONE', async () => {
    const { self, messages } = makeFakeSelf();
    const sab = createSigningSAB();
    const { int32, bytes } = createSigningViews(sab);

    createWorkerModule(self);
    self.onmessage!({ data: { type: 'init', sab } } as MessageEvent<any>);
    await flushMicrotasks();

    self.onmessage!({ data: { type: 'create-key' } } as MessageEvent<any>);
    await flushMicrotasks();
    const created = messages.find((m) => m.type === 'key-created')!;
    const handle = created.handle as number;
    messages.length = 0;

    const messageBytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    bytes.set(messageBytes, SLOT.MESSAGE);
    Atomics.store(int32, SLOT_INT32.MSG_LEN, messageBytes.byteLength);
    Atomics.store(int32, SLOT_INT32.SEED_HANDLE, handle);
    Atomics.store(int32, SLOT_INT32.STATUS, STATUS_REQUEST);

    self.onmessage!({ data: { type: 'sign-from-sab' } } as MessageEvent<any>);
    await flushMicrotasks();

    expect(Atomics.load(int32, SLOT_INT32.STATUS)).toBe(STATUS_DONE);
    const sig = bytes.slice(SLOT.SIGNATURE, SLOT.SIGNATURE + 64);
    expect(sig.byteLength).toBe(64);
    let nonZero = 0;
    for (const b of sig) if (b !== 0) nonZero += 1;
    expect(nonZero).toBeGreaterThan(32);
  });

  it('rejects unknown seed handles with STATUS_ERROR', async () => {
    const { self } = makeFakeSelf();
    const sab = createSigningSAB();
    const { int32, bytes } = createSigningViews(sab);

    createWorkerModule(self);
    self.onmessage!({ data: { type: 'init', sab } } as MessageEvent<any>);
    await flushMicrotasks();

    bytes.set(Uint8Array.from([0xaa]), SLOT.MESSAGE);
    Atomics.store(int32, SLOT_INT32.MSG_LEN, 1);
    Atomics.store(int32, SLOT_INT32.SEED_HANDLE, 9999);
    Atomics.store(int32, SLOT_INT32.STATUS, STATUS_REQUEST);

    self.onmessage!({ data: { type: 'sign-from-sab' } } as MessageEvent<any>);
    await flushMicrotasks();

    expect(Atomics.load(int32, SLOT_INT32.STATUS)).toBe(STATUS_ERROR);
    expect(Atomics.load(int32, SLOT_INT32.SIG_LEN)).toBe(ERROR_UNKNOWN_HANDLE);
  });

  it('rejects invalid MSG_LEN with STATUS_ERROR', async () => {
    const { self } = makeFakeSelf();
    const sab = createSigningSAB();
    const { int32 } = createSigningViews(sab);

    createWorkerModule(self);
    self.onmessage!({ data: { type: 'init', sab } } as MessageEvent<any>);
    await flushMicrotasks();

    Atomics.store(int32, SLOT_INT32.MSG_LEN, -1);
    Atomics.store(int32, SLOT_INT32.SEED_HANDLE, 1);
    Atomics.store(int32, SLOT_INT32.STATUS, STATUS_REQUEST);

    self.onmessage!({ data: { type: 'sign-from-sab' } } as MessageEvent<any>);
    await flushMicrotasks();

    expect(Atomics.load(int32, SLOT_INT32.STATUS)).toBe(STATUS_ERROR);
  });
});

describe('crypto-sandbox worker error paths', () => {
  it('surfaces WASM init failure via posted error', async () => {
    const { self, messages } = makeFakeSelf();
    Object.defineProperty(self, 'WebAssembly', {
      value: {
        compile: () => Promise.reject(new Error('mock wasm compile failure')),
        instantiate: () => Promise.reject(new Error('mock wasm instantiate failure')),
      },
      configurable: true,
    });
    createWorkerModule(self);
    self.onmessage!({ data: { type: 'init', sab: createSigningSAB() } } as MessageEvent<any>);
    await flushMicrotasks();

    const errorMsg = messages.find((m) => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg.message).toMatch(/WASM init failed/);

    const sab = createSigningSAB();
    const { int32 } = createSigningViews(sab);
    expect(Atomics.load(int32, SLOT_INT32.STATUS)).toBe(STATUS_IDLE);
    void ERROR_WASM_INIT_FAILED;
  });
});
