/**
 * @file crypto-sandbox-client.ts
 * @description Main-thread browser client for the off-main-thread signing
 * sandbox defined in `./crypto-sandbox-protocol.ts` and
 * `./crypto-sandbox-worker.ts`.
 *
 * Responsibilities:
 *
 *   1. Lazily create the dedicated `Worker` on first use and transfer the
 *      `SharedArrayBuffer` over to it.
 *   2. Provide a clean `async` API: `createKey()`, `sign(handle, message)`,
 *      `disposeKey(handle)`, `dispose()`.
 *   3. Coordinate sign requests purely through `SharedArrayBuffer` +
 *      `Atomics.wait` / `Atomics.notify`, *not* through postMessage payload
 *      copying — large messages would otherwise be duplicated.
 *   4. Hold zero private-key material on the main thread. Only opaque
 *      integer handles ever cross the worker boundary in the inbound
 *      direction.
 */

import {
  SAB_SIZE,
  SLOT,
  SLOT_INT32,
  STATUS_DONE,
  STATUS_IDLE,
  STATUS_REQUEST,
  DEFAULT_SIGN_TIMEOUT_MS,
  MESSAGE_MAX_BYTES,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  assertSandboxEnvironment,
  createSigningSAB,
  createSigningViews,
  type SigningViews,
  type WorkerOutboundMessage,
} from './protocol';

// ── Public types ─────────────────────────────────────────────────────────────

export interface SandboxKey {
  /** Opaque handle — never sent across wire; only used locally. */
  handle: number;
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
}

export interface CryptoSandboxOptions {
  signTimeoutMs?: number;
}

// ── Overrides type (used by tests to inject a fake Worker) ──────────────────

export interface ClientOverrides {
  workerCtor: typeof Worker | null;
  workerURL: URL | null;
}

// ── Lazy-browser-only singleton accessor ────────────────────────────────────

/** Holds the lazily-created singleton (browser only). */
let cached: CryptoSandboxClient | null = null;

/**
 * Returns a lazily-instantiated sandbox bound to `window`. Only exists in
 * the browser (`typeof window !== 'undefined'`). Throws clearly on SSR.
 */
export async function getCryptoSandbox(options: CryptoSandboxOptions = {}): Promise<CryptoSandboxClient> {
  if (typeof window === 'undefined') {
    throw new Error('CryptoSandbox is browser-only.');
  }
  if (!cached) {
    cached = new CryptoSandboxClient(options);
    await cached.initialize();
  }
  return cached;
}

export function hasCryptoSandbox(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (typeof Atomics === 'undefined') return false;
  // `crossOriginIsolated` is a boolean on the browser `self` once the
  // page is served with the required COOP/COEP headers.
  return Boolean((window as { crossOriginIsolated?: boolean }).crossOriginIsolated);
}

// ── Client ──────────────────────────────────────────────────────────────────

export class CryptoSandboxClient {
  private readonly signTimeoutMs: number;
  private worker: Worker | null = null;
  private readonly workerCtor: typeof Worker | null;
  private readonly workerURL: URL | null;
  private views: SigningViews | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly inflight: Map<string, { resolve: (v: WorkerOutboundMessage) => void; reject: (e: Error) => void }> = new Map();
  private ready = false;
  private disposed = false;
  // Stored handler so it can route messages while initPromise waits to resolve.
  private pendingInit: { resolve: () => void; reject: (err: Error) => void } | null = null;

  constructor(options: CryptoSandboxOptions = {}, overrides: Partial<ClientOverrides> = {}) {
    this.signTimeoutMs = options.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
    this.workerCtor = overrides.workerCtor ?? (typeof Worker !== 'undefined' ? Worker : null);
    this.workerURL = overrides.workerURL ?? (typeof URL !== 'undefined' ? new URL('./crypto-sandbox-worker.ts', import.meta.url) : null);
  }

  /** Detects whether `crossOriginIsolated` + `SharedArrayBuffer` are available. */
  static isAvailable(): boolean {
    return hasCryptoSandbox();
  }

  /** Total bytes occupied by the shared memory region. */
  static get bufferSize(): number {
    return SAB_SIZE;
  }

  /** Initialise the worker + SAB. Safe to call multiple times. */
  initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.boot();
    return this.initPromise;
  }

  private boot(): Promise<void> {
    if (typeof window === 'undefined') return Promise.reject(new Error('CryptoSandbox is browser-only.'));
    try {
      assertSandboxEnvironment(window as unknown as Parameters<typeof assertSandboxEnvironment>[0]);
    } catch (err) {
      return Promise.reject(err);
    }

    if (!this.workerCtor || !this.workerURL) {
      return Promise.reject(new Error('Worker constructor or URL unavailable in this environment.'));
    }

    // We must allocate the SAB *before* creating the worker so we can
    // transfer it in the init message.
    const sab = createSigningSAB();
    this.views = createSigningViews(sab);

    const ctor = this.workerCtor;
    const worker = new ctor(this.workerURL, { type: 'module' });
    this.worker = worker;

    return new Promise<void>((resolve, reject) => {
      this.pendingInit = { resolve, reject };
      worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => this.onWorkerMessage(event.data);
      worker.onerror = (event: ErrorEvent) => {
        const err = new Error(`Signing worker error: ${event.message || 'unknown'}`);
        this.rejectAllInflight(err);
        if (this.pendingInit) {
          this.pendingInit.reject(err);
          this.pendingInit = null;
        }
      };

      worker.postMessage({ type: 'init', sab }, [sab]);
    });
  }

  private onWorkerMessage(msg: WorkerOutboundMessage): void {
    // Boot-time `ready` resolves the init promise exactly once.
    if (msg.type === 'ready') {
      if (this.pendingInit) {
        this.pendingInit.resolve();
        this.pendingInit = null;
      }
      this.ready = true;
      return;
    }
    if (this.pendingInit && msg.type === 'error') {
      this.pendingInit.reject(new Error(`Signing worker failed to boot: ${msg.message}`));
      this.pendingInit = null;
      return;
    }

    if (msg.type === 'key-created' && this.inflight.has('create-key')) {
      const pending = this.inflight.get('create-key')!;
      this.inflight.delete('create-key');
      pending.resolve(msg);
      return;
    }
    if (msg.type === 'error') {
      const err = new Error(msg.message);
      this.rejectAllInflight(err);
      return;
    }
    // Defensive fallback: should not reach here in v1.
    const _exhaustive: never = msg;
    void _exhaustive;
  }

  // ── Public async API ────────────────────────────────────────────────────

  /**
   * Generate an Ed25519 keypair inside the worker. Returns an opaque
   * handle + the 32-byte public key. The seed (and the `Keypair` object)
   * never enter main thread memory.
   */
  async createKey(): Promise<SandboxKey> {
    await this.initialize();
    if (this.disposed) throw new Error('CryptoSandbox has been disposed.');
    if (!this.worker) throw new Error('Worker not initialised.');
    const result = await new Promise<WorkerOutboundMessage>((resolve, reject) => {
      this.inflight.set('create-key', { resolve, reject });
      this.worker!.postMessage({ type: 'create-key' });
    });
    if (result.type !== 'key-created') {
      // The worker reported an unexpected response; surface as error.
      const pending = Array.from(this.inflight.values());
      this.inflight.clear();
      for (const p of pending) p.reject(new Error('Expected key-created response.'));
      throw new Error('Expected key-created response.');
    }
    return { handle: result.handle, publicKey: result.publicKey };
  }

  /**
   * Sign a message using the key identified by `handle`. The signature
   * never leaves the worker; only the signature bytes are returned to the
   * caller.
   */
  async sign(handle: number, message: Uint8Array): Promise<Uint8Array> {
    await this.initialize();
    if (this.disposed) throw new Error('CryptoSandbox has been disposed.');
    if (!this.views) throw new Error('Sandbox views not initialised.');
    if (!this.worker) throw new Error('Worker not initialised.');
    if (message.byteLength > MESSAGE_MAX_BYTES) {
      throw new RangeError(`Message too large: ${message.byteLength} > ${MESSAGE_MAX_BYTES}`);
    }
    const views = this.views;

    // Reset the SAB to a known-good state.
    Atomics.store(views.int32, SLOT_INT32.STATUS, STATUS_IDLE);
    Atomics.store(views.int32, SLOT_INT32.SEED_HANDLE, handle);
    Atomics.store(views.int32, SLOT_INT32.MSG_LEN, message.byteLength);
    Atomics.store(views.int32, SLOT_INT32.SIG_LEN, 0);
    views.bytes.set(message, SLOT.MESSAGE);

    // Hand control to the worker.
    Atomics.store(views.int32, SLOT_INT32.STATUS, STATUS_REQUEST);
    this.worker.postMessage({ type: 'sign-from-sab' });

    // Block the main thread until the worker notifies us — yields via
    // `Atomics.wait`, so the browser holds no JS frames.
    const waitResult = Atomics.wait(views.int32, SLOT_INT32.STATUS, STATUS_REQUEST, this.signTimeoutMs);
    if (waitResult === 'timed-out') {
      Atomics.store(views.int32, SLOT_INT32.STATUS, STATUS_IDLE);
      throw new Error(`Signing timed out after ${this.signTimeoutMs} ms`);
    }
    const status = Atomics.load(views.int32, SLOT_INT32.STATUS);
    if (status === STATUS_DONE) {
      const sig = views.bytes.slice(SLOT.SIGNATURE, SLOT.SIGNATURE + SIGNATURE_BYTES);
      Atomics.store(views.int32, SLOT_INT32.STATUS, STATUS_IDLE);
      return sig;
    }
    const errorCode = Atomics.load(views.int32, SLOT_INT32.SIG_LEN);
    Atomics.store(views.int32, SLOT_INT32.STATUS, STATUS_IDLE);
    throw new Error(`Signing failed (status=${status}, code=${errorCode})`);
  }

  async disposeKey(handle: number): Promise<void> {
    await this.initialize();
    if (!this.worker) return;
    this.worker.postMessage({ type: 'dispose-key', handle });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.worker?.postMessage({ type: 'dispose' });
    } catch {
      // ignore — worker may already be gone.
    }
    try {
      this.worker?.terminate?.();
    } catch {
      // ignore.
    }
    cached = null;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private rejectAllInflight(err: Error): void {
    for (const [, pending] of this.inflight) {
      pending.reject(err);
    }
    this.inflight.clear();
  }
}
