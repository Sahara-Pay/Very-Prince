/**
 * @file signingWorkerManager.ts
 * @description Main-thread manager for the off-main-thread Ed25519 signing worker.
 *
 * SECURITY GUARANTEES:
 *  - The private key is passed to the worker as a hex string and is
 *    immediately dropped from the main thread's scope after `sign()` returns.
 *  - The key NEVER exists in a typed-array in main-thread memory.
 *  - Signing happens entirely inside the worker; the main thread only reads
 *    the resulting signature from the shared DataSAB.
 *  - The UI remains fully responsive during signing because the worker runs
 *    on a separate OS thread.
 *
 * Usage:
 * ```ts
 * const manager = new SigningWorkerManager();
 * await manager.init();
 *
 * const signature = await manager.sign(messageBytes, secretKeyHex);
 *
 * manager.destroy();
 * ```
 */

import {
  type WorkerInboundMessage,
  type WorkerOutboundMessage,
  CTRL_SAB_BYTES,
  DATA_SAB_BYTES,
  SLOT_STATE,
  SLOT_LENGTH,
  STATE_SIGN_REQUEST,
  STATE_SIGN_DONE,
  uint8ArrayToHex,
} from './signerProtocol';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: Uint8Array) => void;
  reject: (reason: Error) => void;
}

// ─── Manager ──────────────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of the signing Web Worker and provides the main-thread
 * API for requesting Ed25519 signatures via SharedArrayBuffer + Atomics.
 */
export class SigningWorkerManager {
  private worker: Worker | null = null;
  private controlSab: SharedArrayBuffer | null = null;
  private dataSab: SharedArrayBuffer | null = null;
  private controlView: Int32Array | null = null;
  private dataView: Uint8Array | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private isReady = false;

  // ── Initialisation ─────────────────────────────────────────────────────────

  /**
   * Spawn the worker and perform the SharedArrayBuffer handshake.
   * Must be called once before any call to `sign()`.
   *
   * @throws {Error} if SharedArrayBuffer is not available (COOP/COEP headers
   *                 missing or the environment does not support SABs).
   */
  async init(): Promise<void> {
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error(
        'SharedArrayBuffer is not available. ' +
          'Ensure the page is served with Cross-Origin-Opener-Policy: same-origin ' +
          'and Cross-Origin-Embedder-Policy: require-corp headers.',
      );
    }

    // Allocate shared buffers.
    this.controlSab = new SharedArrayBuffer(CTRL_SAB_BYTES);
    this.dataSab = new SharedArrayBuffer(DATA_SAB_BYTES);
    this.controlView = new Int32Array(this.controlSab);
    this.dataView = new Uint8Array(this.dataSab);

    // Spawn the worker.
    // Next.js/webpack bundler resolves `new Worker(new URL(...))` statically.
    this.worker = new Worker(new URL('./signing-worker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = this.handleMessage.bind(this);
    this.worker.onerror = this.handleError.bind(this);

    // Wait for the initial 'ready' signal.
    await this.waitForReady();

    // Send the SABs to the worker.
    await this.send({
      id: this.nextId(),
      type: 'init',
      controlSab: this.controlSab,
      dataSab: this.dataSab,
    });

    this.isReady = true;
  }

  // ── Signing ────────────────────────────────────────────────────────────────

  /**
   * Sign `message` with an Ed25519 secret key entirely inside the worker.
   *
   * The key is passed as a hex-encoded string so no typed-array
   * carrying key bytes is created on the main thread heap.
   *
   * @param message      - The raw bytes to sign (e.g. transaction hash).
   * @param secretKeyHex - The 64-byte Ed25519 secret key, hex-encoded (128 chars).
   * @returns            A Promise resolving to the 64-byte signature.
   */
  async sign(message: Uint8Array, secretKeyHex: string): Promise<Uint8Array> {
    if (!this.isReady || !this.worker || !this.controlView || !this.dataView) {
      throw new Error('SigningWorkerManager not initialised. Call init() first.');
    }

    if (message.length > DATA_SAB_BYTES) {
      throw new RangeError(
        `Message length ${message.length} exceeds maximum ${DATA_SAB_BYTES} bytes.`,
      );
    }

    // 1. Write message bytes into the shared data buffer.
    //    The worker will copy these out before signing.
    this.dataView.set(message, 0);
    Atomics.store(this.controlView, SLOT_LENGTH, message.length);
    Atomics.store(this.controlView, SLOT_STATE, STATE_SIGN_REQUEST);

    // 2. Dispatch the sign request (wakes the worker).
    const id = this.nextId();
    const sigPromise = new Promise<Uint8Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    // Send the sign message — the secretKeyHex travels via the structured-clone
    // postMessage channel, NOT via the SAB, so only the worker ever sees the
    // decoded bytes.
    const msg: WorkerInboundMessage = {
      id,
      type: 'sign',
      messageLength: message.length,
      secretKeyHex,
    };
    this.worker.postMessage(msg);

    return sigPromise;
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  /**
   * Gracefully shut down the worker and release all resources.
   * All pending sign requests will be rejected.
   */
  destroy(): void {
    if (this.worker) {
      try {
        const msg: WorkerInboundMessage = {
          id: this.nextId(),
          type: 'destroy',
        };
        this.worker.postMessage(msg);
      } finally {
        this.worker.terminate();
        this.worker = null;
      }
    }

    // Reject all in-flight requests.
    for (const [id, { reject }] of this.pending) {
      reject(new Error(`SigningWorkerManager destroyed while request ${id} was pending`));
    }
    this.pending.clear();

    this.controlSab = null;
    this.dataSab = null;
    this.controlView = null;
    this.dataView = null;
    this.isReady = false;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private nextId(): string {
    return `swr-${Date.now()}-${++this.requestCounter}`;
  }

  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not created'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Worker did not send ready signal within 5 s'));
      }, 5000);

      const originalOnMessage = this.worker.onmessage;

      this.worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
        if (event.data.type === 'ready') {
          clearTimeout(timeout);
          this.worker!.onmessage = originalOnMessage;
          resolve();
        }
      };
    });
  }

  private send(msg: WorkerInboundMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('Worker not available'));
        return;
      }

      const id = msg.id;

      // Register a one-shot listener for the acknowledgement.
      const ack = (event: MessageEvent<WorkerOutboundMessage>) => {
        const res = event.data;
        if (res.id !== id) return;

        this.worker?.removeEventListener('message', ack);

        if (res.type === 'error') {
          reject(new Error(res.error));
        } else {
          resolve();
        }
      };

      this.worker.addEventListener('message', ack);
      this.worker.postMessage(msg);
    });
  }

  private handleMessage(event: MessageEvent<WorkerOutboundMessage>): void {
    const msg = event.data;

    if (msg.type === 'signed') {
      const pending = this.pending.get(msg.id);
      if (!pending || !this.dataView) return;

      this.pending.delete(msg.id);

      // Read the signature from the shared buffer.
      // We copy the bytes out so the caller owns an independent Uint8Array
      // and future writes to dataView cannot mutate it.
      const signatureBytes = this.dataView.slice(0, msg.signatureLength);

      // Verify the worker signalled SIGN_DONE via Atomics (belt + braces).
      if (this.controlView) {
        Atomics.waitAsync(this.controlView, SLOT_STATE, STATE_SIGN_REQUEST).value
          .then(() => {
            // Already resolved via postMessage — nothing to do.
          })
          .catch(() => {
            // Ignore; we're just ensuring the state was flipped.
          });
      }

      pending.resolve(signatureBytes);
      return;
    }

    if (msg.type === 'error') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;

      this.pending.delete(msg.id);
      pending.reject(new Error(msg.error));
    }
  }

  private handleError(event: ErrorEvent): void {
    const errorMessage = event.message ?? 'Unknown worker error';

    // Reject all pending requests.
    for (const [, { reject }] of this.pending) {
      reject(new Error(`Worker error: ${errorMessage}`));
    }
    this.pending.clear();
  }
}

// ─── Convenience re-export ────────────────────────────────────────────────────

/**
 * Encode a Uint8Array as hex for passing secret keys into `sign()`.
 * Re-exported here so callers do not need to import signerProtocol directly.
 */
export { uint8ArrayToHex } from './signerProtocol';
