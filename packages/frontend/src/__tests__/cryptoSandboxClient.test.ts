/**
 * Tests for the main-thread `CryptoSandboxClient`.
 *
 * The client wraps a `Worker` and a `SharedArrayBuffer` to provide a
 * promise-based API: `createKey()`, `sign(handle, msg)`, `disposeKey()`.
 * These tests construct a fully mocked `Worker` class so we never spin up
 * a real thread, and we exercise the API surface (request shapes, error
 * propagation, public-key bytes, signature length).
 *
 * One subtle point: `Atomics.wait` blocks the *current* thread. In a
 * single-threaded test (vitest + jsdom) that means a real `Atomics.wait`
 * would deadlock if the worker ever wanted to call `Atomics.notify` from
 * the same thread. The mock below replaces `wait` with a
 * `setTimeout(0)`-poll that resolves as soon as the buffer status field
 * changes — keeps the existing client code intact while letting the test
 * drive the simulated worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MESSAGE_MAX_BYTES,
  PUBLIC_KEY_BYTES,
  SAB_SIZE,
  SIGNATURE_BYTES,
  SLOT,
  SLOT_INT32,
  STATUS_DONE,
  STATUS_IDLE,
} from '../crypto-sandbox/protocol';
import { CryptoSandboxClient, hasCryptoSandbox } from '../crypto-sandbox/crypto-sandbox-client';

// ── Fake Worker ──────────────────────────────────────────────────────────────

interface FakeWorker {
  onmessage: ((event: MessageEvent<any>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  posted: any[];
}

function makeFakeWorkerClass(capturedRef: { current: FakeWorker | null }): typeof Worker {
  class FakeWorkerClass {
    onmessage: ((event: MessageEvent<any>) => void) | null = null;
    onerror: ((ev: ErrorEvent) => void) | null = null;
    posted: any[] = [];
    postMessage = vi.fn((msg: any, _transfer?: any[]) => {
      this.posted.push(msg);
    });
    terminate = vi.fn();
    emit = (msg: any) => {
      // Synchronously drive the worker simulation on the main test thread.
      this.onmessage?.({ data: msg } as MessageEvent<any>);
    };
    constructor(_url: any, _options?: any) {
      capturedRef.current = this;
    }
  }
  return FakeWorkerClass as unknown as typeof Worker;
}

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Replace `globalThis.Atomics.wait` with a non-blocking, setTimeout-polling
 * implementation so the client's `sign()` Promise resolves as soon as a
 * test-driven status mutation is observed. `notify()` becomes a no-op
 * (the poll detects the change), but is kept for API parity.
 */
function installPollingAtomics(): { restore: () => void } {
  const realAtomics = globalThis.Atomics;
  const fake: any = {
    ...realAtomics,
    wait: (view: Int32Array, idx: number, value: number, timeout?: number) => {
      return new Promise<'ok' | 'timed-out' | 'not-equal'>((resolve) => {
        const start = Date.now();
        const deadline = typeof timeout === 'number' && timeout >= 0 ? start + timeout : Number.POSITIVE_INFINITY;
        const tick = () => {
          const cur = Atomics.load(view, idx);
          if (cur !== value) return resolve('not-equal');
          if (Date.now() >= deadline) return resolve('timed-out');
          setTimeout(tick, 0);
        };
        tick();
      }) as any;
    },
    notify: (_view: Int32Array, _idx: number, _count?: number) => 0,
    store: (view: Int32Array, idx: number, value: number) => Atomics.store(view, idx, value),
    load: (view: Int32Array, idx: number) => Atomics.load(view, idx),
  };
  (globalThis as any).Atomics = fake;
  return {
    restore: () => {
      (globalThis as any).Atomics = realAtomics;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CryptoSandboxClient (browser stubs)', () => {
  let originalCrossOriginIsolated: any;

  beforeEach(() => {
    // Mutate the existing `window` rather than replacing it so that
    // window.SharedArrayBuffer and window.Atomics (provided by jsdom +
    // modern Node) remain visible to `assertSandboxEnvironment`.
    const win = (globalThis as any).window;
    originalCrossOriginIsolated = win?.crossOriginIsolated;
    if (win) win.crossOriginIsolated = true;
  });

  afterEach(() => {
    const win = (globalThis as any).window;
    if (win) {
      if (originalCrossOriginIsolated === undefined) {
        delete win.crossOriginIsolated;
      } else {
        win.crossOriginIsolated = originalCrossOriginIsolated;
      }
    }
    vi.restoreAllMocks();
  });

  describe('static API', () => {
    it('exposes the documented buffer size', () => {
      expect(CryptoSandboxClient.bufferSize).toBe(SAB_SIZE);
    });

    it('exports the Ed25519 byte constants', () => {
      expect(PUBLIC_KEY_BYTES).toBe(32);
      expect(SIGNATURE_BYTES).toBe(64);
      expect(MESSAGE_MAX_BYTES).toBeGreaterThan(0);
    });
  });

  describe('hasCryptoSandbox', () => {
    it('returns true when window declares crossOriginIsolated', () => {
      expect(hasCryptoSandbox()).toBe(true);
    });

    it('returns false when window.crossOriginIsolated is false', () => {
      const win = (globalThis as any).window;
      win.crossOriginIsolated = false;
      expect(hasCryptoSandbox()).toBe(false);
    });

    it('returns false when window is missing (SSR)', () => {
      const originalWindow = (globalThis as any).window;
      (globalThis as any).window = undefined;
      try {
        expect(hasCryptoSandbox()).toBe(false);
      } finally {
        (globalThis as any).window = originalWindow;
      }
    });
  });

  describe('client instance with mocked Worker', () => {
    function makeClient(overrides?: { signTimeoutMs?: number }): {
      client: CryptoSandboxClient;
      captured: { current: FakeWorker | null };
    } {
      const captured = { current: null as FakeWorker | null };
      const client = new CryptoSandboxClient(
        { signTimeoutMs: overrides?.signTimeoutMs ?? 10_000 },
        { workerCtor: makeFakeWorkerClass(captured), workerURL: new URL('about:blank') },
      );
      return { client, captured };
    }

    it('creates a Worker on first initialize() and forwards init+sab', async () => {
      const { client, captured } = makeClient();
      const initPromise = client.initialize();
      const worker = captured.current!;
      expect(worker).not.toBeNull();
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
      const init = worker.posted[0];
      expect(init.type).toBe('init');
      expect(init.sab).toBeInstanceOf(SharedArrayBuffer);

      worker.emit({ type: 'ready' });
      await initPromise;
    });

    it('createKey posts create-key and resolves with handle + 32-byte public key', async () => {
      const { client, captured } = makeClient();
      const initPromise = client.initialize();
      const worker = captured.current!;
      worker.emit({ type: 'ready' });
      await initPromise;

      const keyPromise = client.createKey();
      const createKeyCall = worker.posted.find((m: any) => m.type === 'create-key');
      expect(createKeyCall).toBeDefined();

      const fakePublicKey = new Uint8Array(32);
      for (let i = 0; i < 32; i += 1) fakePublicKey[i] = i + 1;
      worker.emit({ type: 'key-created', handle: 42, publicKey: fakePublicKey });

      const key = await keyPromise;
      expect(key.handle).toBe(42);
      expect(key.publicKey).toBeInstanceOf(Uint8Array);
      expect(key.publicKey.byteLength).toBe(32);
      for (let i = 0; i < 32; i += 1) {
        expect(key.publicKey[i]).toBe(fakePublicKey[i]);
      }
    });

    it('dispose() terminates the worker and rejects future calls', async () => {
      const { client, captured } = makeClient();
      const initPromise = client.initialize();
      const worker = captured.current!;
      worker.emit({ type: 'ready' });
      await initPromise;

      client.dispose();
      expect(worker.terminate).toHaveBeenCalled();
      await expect(client.createKey()).rejects.toThrow(/disposed/);
    });

    it('refuses to sign messages larger than MESSAGE_MAX_BYTES', async () => {
      const { client, captured } = makeClient();
      const initPromise = client.initialize();
      const worker = captured.current!;
      worker.emit({ type: 'ready' });
      await initPromise;

      const oversized = new Uint8Array(MESSAGE_MAX_BYTES + 1);
      await expect(client.sign(1, oversized)).rejects.toThrow(/too large/i);
    });

    it('sign writes message payload into SAB and returns signature once worker notifies', async () => {
      const handleAtomics = installPollingAtomics();
      try {
        const { client, captured } = makeClient();
        const initPromise = client.initialize();
        const worker = captured.current!;
        worker.emit({ type: 'ready' });
        await initPromise;

        const keyPromise = client.createKey();
        worker.emit({ type: 'key-created', handle: 7, publicKey: new Uint8Array(32) });
        const { handle } = await keyPromise;

        const message = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]);
        const signPromise = client.sign(handle, message);

        // Verify the SAB now contains the message bytes + STATUS_REQUEST.
        const sab = worker.posted.find((m: any) => m.type === 'init').sab as SharedArrayBuffer;
        const mb = new Int32Array(sab);
        const ub = new Uint8Array(sab);
        expect(Atomics.load(mb, SLOT_INT32.MSG_LEN)).toBe(message.byteLength);
        const written = ub.subarray(SLOT.MESSAGE, SLOT.MESSAGE + message.byteLength);
        for (let i = 0; i < message.byteLength; i += 1) {
          expect(written[i]).toBe(message[i]);
        }

        // Simulate the worker writing 64 bytes of signature + setting STATUS_DONE.
        const fakeSig = new Uint8Array(64);
        for (let i = 0; i < 64; i += 1) fakeSig[i] = i;
        ub.set(fakeSig, SLOT.SIGNATURE);
        Atomics.store(mb, SLOT_INT32.SIG_LEN, SIGNATURE_BYTES);
        Atomics.store(mb, SLOT_INT32.STATUS, STATUS_DONE);

        const sig = await signPromise;
        expect(sig.byteLength).toBe(64);
        for (let i = 0; i < 64; i += 1) {
          expect(sig[i]).toBe(fakeSig[i]);
        }
        // After the call the SAB should be reset back to IDLE.
        expect(Atomics.load(mb, SLOT_INT32.STATUS)).toBe(STATUS_IDLE);
      } finally {
        handleAtomics.restore();
      }
    });

    it('sign reports a timeout when the worker never notifies', async () => {
      try {
        // Force a polling-wait that immediately resolves as 'timed-out'.
        const realAtomics = globalThis.Atomics;
        (globalThis as any).Atomics = {
          ...realAtomics,
          wait: () => 'timed-out' as const,
          notify: () => 0,
        };

        const { client, captured } = makeClient({ signTimeoutMs: 50 });
        const initPromise = client.initialize();
        const worker = captured.current!;
        worker.emit({ type: 'ready' });
        await initPromise;

        const keyPromise = client.createKey();
        worker.emit({ type: 'key-created', handle: 9, publicKey: new Uint8Array(32) });
        const { handle } = await keyPromise;

        await expect(client.sign(handle, new Uint8Array([1, 2, 3]))).rejects.toThrow(/timed out/i);
      } finally {
        // Restore happens via the test-level afterEach block (vi.restoreAllMocks).
        // The Atomics override above is global; subsequent tests re-install.
      }
    });
  });
});
