/**
 * @file signingWorkerManager.test.ts
 * @description Unit tests for the SigningWorkerManager class.
 *
 * The actual Worker is mocked so these tests run in jsdom without needing
 * a real browser Worker implementation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DATA_SAB_BYTES } from './signerProtocol';

// ─── Globals needed before module import ──────────────────────────────────────

// Provide a SharedArrayBuffer that actually works by subclassing ArrayBuffer.
// Vitest/jsdom doesn't always have SAB enabled, so we shim it with a real
// ArrayBuffer so that TypedArray views (Int32Array, Uint8Array) work on it.
class FakeSharedArrayBuffer extends ArrayBuffer {
  constructor(size: number) {
    super(size);
  }
}

vi.stubGlobal('SharedArrayBuffer', FakeSharedArrayBuffer);

vi.stubGlobal('Atomics', {
  store: vi.fn(),
  notify: vi.fn(),
  waitAsync: vi.fn(() => ({ value: Promise.resolve('ok') })),
});

// ─── Mock Worker ──────────────────────────────────────────────────────────────

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private _extraListeners: Array<(event: MessageEvent) => void> = [];

  sentMessages: unknown[] = [];

  constructor(_url: unknown, _opts?: unknown) {
    super();
    FakeWorker.instances.push(this);
    // Emit the initial 'ready' signal asynchronously.
    Promise.resolve().then(() => this.emitMessage({ id: '', type: 'ready' }));
  }

  postMessage(data: unknown): void {
    this.sentMessages.push(data);

    // Auto-ack 'init' with 'ready'.
    if ((data as { type: string }).type === 'init') {
      Promise.resolve().then(() =>
        this.emitMessage({ id: (data as { id: string }).id, type: 'ready' }),
      );
    }
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message') {
      this._extraListeners.push(listener as (event: MessageEvent) => void);
    }
    super.addEventListener(type, listener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message') {
      this._extraListeners = this._extraListeners.filter((l) => l !== listener);
    }
    super.removeEventListener(type, listener);
  }

  terminate(): void { /* no-op */ }

  emitMessage(data: unknown): void {
    const event = new MessageEvent('message', { data });
    if (this.onmessage) this.onmessage(event);
    for (const l of this._extraListeners) l(event);
    this.dispatchEvent(event);
  }

  emitError(message: string): void {
    const event = new ErrorEvent('error', { message });
    if (this.onerror) this.onerror(event);
  }
}

vi.stubGlobal('Worker', FakeWorker);

// ─── Import after globals are set ─────────────────────────────────────────────

import { SigningWorkerManager, uint8ArrayToHex } from './signingWorkerManager';

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  FakeWorker.instances = [];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SigningWorkerManager', () => {
  describe('init()', () => {
    it('throws when SharedArrayBuffer is not available', async () => {
      vi.stubGlobal('SharedArrayBuffer', undefined);

      const manager = new SigningWorkerManager();
      await expect(manager.init()).rejects.toThrow(/SharedArrayBuffer is not available/);

      // Restore for subsequent tests.
      vi.stubGlobal('SharedArrayBuffer', FakeSharedArrayBuffer);
    });

    it('initialises successfully when SAB is available', async () => {
      const manager = new SigningWorkerManager();
      await expect(manager.init()).resolves.toBeUndefined();
      manager.destroy();
    });

    it('sends an init message to the worker with both SABs', async () => {
      const manager = new SigningWorkerManager();
      await manager.init();

      const worker = FakeWorker.instances[0]!;
      const initMsg = worker.sentMessages.find(
        (m) => (m as { type: string }).type === 'init',
      ) as { type: string; controlSab: unknown; dataSab: unknown } | undefined;

      expect(initMsg).toBeDefined();
      expect(initMsg?.controlSab).toBeDefined();
      expect(initMsg?.dataSab).toBeDefined();

      manager.destroy();
    });
  });

  describe('sign()', () => {
    it('rejects if called before init()', async () => {
      const manager = new SigningWorkerManager();

      await expect(
        manager.sign(new Uint8Array([1, 2, 3]), 'aabbcc'),
      ).rejects.toThrow(/not initialised/i);
    });

    it('rejects if message is too large', async () => {
      const manager = new SigningWorkerManager();
      await manager.init();

      const bigMessage = new Uint8Array(DATA_SAB_BYTES + 1);
      await expect(manager.sign(bigMessage, 'aabbcc')).rejects.toThrow(/exceeds maximum/i);

      manager.destroy();
    });

    it('resolves with signature bytes from the worker', async () => {
      const manager = new SigningWorkerManager();
      await manager.init();

      const worker = FakeWorker.instances[0]!;
      const message = new Uint8Array([10, 20, 30]);
      const fakeSignature = new Uint8Array(64).fill(0xAB);

      // Override postMessage to intercept 'sign' and emit a 'signed' response.
      const origPost = worker.postMessage.bind(worker);
      worker.postMessage = (data: unknown) => {
        origPost(data);
        const msg = data as { type: string; id: string };
        if (msg.type === 'sign') {
          // Directly set the manager's dataView to our fake signature bytes
          // so that slice(0, signatureLength) returns them.
          const mgr = manager as unknown as { dataView: Uint8Array | null };
          mgr.dataView = fakeSignature;

          Promise.resolve().then(() =>
            worker.emitMessage({ id: msg.id, type: 'signed', signatureLength: 64 }),
          );
        }
      };

      const sig = await manager.sign(message, 'aa'.repeat(64));
      expect(sig).toBeInstanceOf(Uint8Array);
      expect(sig.length).toBe(64);

      manager.destroy();
    });

    it('rejects when the worker returns an error message', async () => {
      const manager = new SigningWorkerManager();
      await manager.init();

      const worker = FakeWorker.instances[0]!;
      const origPost = worker.postMessage.bind(worker);
      worker.postMessage = (data: unknown) => {
        origPost(data);
        const msg = data as { type: string; id: string };
        if (msg.type === 'sign') {
          Promise.resolve().then(() =>
            worker.emitMessage({
              id: msg.id,
              type: 'error',
              error: 'Signing failed: invalid key',
            }),
          );
        }
      };

      await expect(
        manager.sign(new Uint8Array([1]), 'deadbeef'),
      ).rejects.toThrow('Signing failed: invalid key');

      manager.destroy();
    });
  });

  describe('destroy()', () => {
    it('terminates the worker and rejects pending requests', async () => {
      const manager = new SigningWorkerManager();
      await manager.init();

      // Start a sign that will never be resolved by the worker.
      const signPromise = manager.sign(new Uint8Array([1]), 'aa'.repeat(64));

      // Destroy immediately.
      manager.destroy();

      await expect(signPromise).rejects.toThrow(/destroyed/i);
    });

    it('can be called multiple times without throwing', () => {
      const manager = new SigningWorkerManager();
      expect(() => {
        manager.destroy();
        manager.destroy();
      }).not.toThrow();
    });
  });
});

// ─── uint8ArrayToHex (re-export) ──────────────────────────────────────────────

describe('uint8ArrayToHex (re-export)', () => {
  it('encodes bytes to hex string', () => {
    expect(uint8ArrayToHex(new Uint8Array([0, 255]))).toBe('00ff');
  });
});
