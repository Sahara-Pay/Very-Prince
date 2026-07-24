/**
 * @file protocol.ts
 * @description SharedArrayBuffer memory layout and constants used by the
 * off-main-thread signing sandbox.
 *
 * The sandbox uses a single `SharedArrayBuffer` allocated on the main thread
 * and transferred (once) to the dedicated worker. Both threads keep a
 * reference to it afterwards. All subsequent cross-thread signalling is
 * performed via the `STATUS` slot using `Atomics.store` / `Atomics.wait` /
 * `Atomics.notify`, while larger payloads travel through the typed slots
 * declared below.
 *
 * The shared memory is intentionally one-directional in any given phase:
 *
 *  - PHASE A — main → worker:
 *      main writes `SEED_HANDLE`, `MSG_LEN`, then the message bytes into
 *      `MESSAGE`, sets `STATUS = STATUS_REQUEST`, then posts a control event
 *      to the worker via `postMessage` so it can run a polling pass.
 *
 *  - PHASE B — worker → main:
 *      worker reads `SEED_HANDLE, MSG_LEN, MESSAGE`, performs the signing,
 *      writes 64 bytes of signature into `SIGNATURE`, sets `SIG_LEN`, then
 *      sets `STATUS = STATUS_DONE` (and `Atomics.notify`s the main thread).
 *
 * Nothing else writes to the buffer — the seed itself never crosses the
 * thread boundary: the worker owns it.
 *
 * ## Layout (4192 bytes total)
 *
 * | Offset      | Size  | Slot            | Notes                            |
 * | ----------- | ----- | --------------- | -------------------------------- |
 * | 0x0000      | 4     | `STATUS`        | Atomic i32 — see `STATUS_*`      |
 * | 0x0004      | 4     | `SEED_HANDLE`   | Opaque i32 handle                |
 * | 0x0008      | 4     | `MSG_LEN`       | Bytes of message                 |
 * | 0x000C      | 4     | `SIG_LEN`       | Bytes of signature (= 64)        |
 * | 0x0010      | 16    | `RESERVED`      | Future use (always zero)         |
 * | 0x0020      | 4096  | `MESSAGE`       | Raw message bytes                |
 * | 0x1020      | 64    | `SIGNATURE`     | Raw signature bytes              |
 *
 * The slots are derived by dividing the listed byte offsets by `BYTES_PER_INT32`
 * (`4`), so any `Int32Array(this.sab)` access uses them directly.
 */

// ── Identity / sizing ────────────────────────────────────────────────────────

/** Total size of the shared memory region in bytes. */
export const SAB_SIZE = 4192;

/** Number of bytes occupied by each aligned 32-bit slot. */
export const BYTES_PER_INT32 = 4;

/** Convenience: integer index of a byte offset within an `Int32Array`. */
function slotIndex(byteOffset: number): number {
  if (byteOffset % BYTES_PER_INT32 !== 0) {
    throw new Error(`slot offset 0x${byteOffset.toString(16)} is not 4-byte aligned`);
  }
  return byteOffset / BYTES_PER_INT32;
}

// ── Slot offsets ─────────────────────────────────────────────────────────────

export const SLOT = {
  /** Atomic i32 — owned cooperatively by both threads, written last in any phase. */
  STATUS: 0x0000,
  /** Opaque i32 handle to a seed stored exclusively inside the worker. */
  SEED_HANDLE: 0x0004,
  /** Bytes of message payload present in `MESSAGE`. */
  MSG_LEN: 0x0008,
  /** Bytes of signature present in `SIGNATURE` (always `SIGNATURE_BYTES`). */
  SIG_LEN: 0x000c,
  /** Reserved — kept zero by both threads. */
  RESERVED: 0x0010,
  /** Message bytes (max `MESSAGE_MAX_BYTES`). */
  MESSAGE: 0x0020,
  /** Signature bytes (always `SIGNATURE_BYTES`). */
  SIGNATURE: 0x1020,
} as const;

/** Pre-computed `Int32Array` slot indices — use with `Atomics.*`. */
export const SLOT_INT32 = {
  STATUS: slotIndex(SLOT.STATUS),
  SEED_HANDLE: slotIndex(SLOT.SEED_HANDLE),
  MSG_LEN: slotIndex(SLOT.MSG_LEN),
  SIG_LEN: slotIndex(SLOT.SIG_LEN),
} as const;

// ── Bounds ────────────────────────────────────────────────────────────────────

/** Maximum message size supported by the default `MESSAGE` buffer. */
export const MESSAGE_MAX_BYTES = 4096;

/** Length of an Ed25519 signature (R || S). */
export const SIGNATURE_BYTES = 64;

/** Length of an Ed25519 public key. */
export const PUBLIC_KEY_BYTES = 32;

/** Length of an Ed25519 private seed. Held only inside the worker. */
export const PRIVATE_KEY_BYTES = 32;

// ── Status values (cooperative state machine) ─────────────────────────────────
//
// The pattern is:
//   main  stores → STATUS_REQUEST, posts a postMessage wake-up to the worker,
//   worker reads the slots, signs, stores → STATUS_DONE, Atomics.notify(main),
//   main  Atomics.wait(...) returns, reads SIGNATURE.
//
// `STATUS_ERROR` is reached if the worker detects a malformed request; see
// the `MSG_LEN` slot for a machine-readable error code (see `ERROR_*`).

export const STATUS_IDLE = 0;
export const STATUS_REQUEST = 1;
/** Set by the worker after it has consumed the request and is signing. */
export const STATUS_PROCESSING = 2;
export const STATUS_DONE = 3;
export const STATUS_ERROR = 4;

// ── Error codes written into the `SIG_LEN` slot on failure ───────────────────

export const ERROR_NONE = 0;
export const ERROR_UNKNOWN_HANDLE = 1;
export const ERROR_INVALID_MSG_LEN = 2;
export const ERROR_SIGNING_FAILED = 3;
export const ERROR_WASM_INIT_FAILED = 4;
export const ERROR_UNSUPPORTED = 5;

// ── Timing ────────────────────────────────────────────────────────────────────

/** How long the main thread waits for the worker to complete a sign request. */
export const DEFAULT_SIGN_TIMEOUT_MS = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fresh `SharedArrayBuffer` initialised to IDLE. */
export function createSigningSAB(): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(SAB_SIZE);
  const view = new Int32Array(sab);
  Atomics.store(view, SLOT_INT32.STATUS, STATUS_IDLE);
  Atomics.store(view, SLOT_INT32.SEED_HANDLE, 0);
  Atomics.store(view, SLOT_INT32.MSG_LEN, 0);
  Atomics.store(view, SLOT_INT32.SIG_LEN, 0);
  return sab;
}

/** Build the dual views used by the main thread. */
export function createSigningViews(sab: SharedArrayBuffer): {
  int32: Int32Array;
  bytes: Uint8Array;
} {
  return {
    int32: new Int32Array(sab),
    bytes: new Uint8Array(sab),
  };
}

export interface SigningViews {
  int32: Int32Array;
  bytes: Uint8Array;
}

// ── Request / response types exchanged over `postMessage` ──────────────────
//
// The shared buffer carries the *data*. These messages are the *control plane*.

/** Worker-bound messages — shape is `{ type, ... }`. */
export type WorkerInboundMessage =
  | { type: 'init'; sab: SharedArrayBuffer }
  | { type: 'create-key' }
  | { type: 'dispose-key'; handle: number }
  | { type: 'sign-from-sab' }
  | { type: 'dispose' };

/** Worker → main messages — used for control responses and lazy key creation. */
export type WorkerOutboundMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'key-created'; handle: number; publicKey: Uint8Array };

// ── Sanity helpers (used by tests and worker boot) ────────────────────────────

/**
 * Verify that `sab` is exactly `SAB_SIZE` bytes. Throws otherwise so any
 * corrupted buffer is caught at the boundary, not deep inside the worker.
 */
export function assertSABShape(sab: SharedArrayBuffer): void {
  if (!(sab instanceof SharedArrayBuffer)) {
    throw new TypeError(`expected SharedArrayBuffer, got ${sab?.constructor?.name}`);
  }
  if (sab.byteLength !== SAB_SIZE) {
    throw new RangeError(`bad SAB size: got ${sab.byteLength}, want ${SAB_SIZE}`);
  }
}

/**
 * Verify the runtime exposes everything required for sandboxed cross-thread
 * signing. Throws with a helpful error message if not.
 */
export function assertSandboxEnvironment(self: {
  SharedArrayBuffer?: unknown;
  Atomics?: unknown;
  crossOriginIsolated?: boolean;
}): void {
  if (typeof self.SharedArrayBuffer === 'undefined') {
    throw new Error(
      'Crypto sandbox requires SharedArrayBuffer. Ensure the page is served with the COOP/COEP headers required for cross-origin isolation.',
    );
  }
  if (typeof self.Atomics === 'undefined') {
    throw new Error('Crypto sandbox requires Atomics. Use a modern browser (Chrome 92+, Firefox 89+, Safari 15.2+).');
  }
  if (self.crossOriginIsolated === false) {
    throw new Error(
      'Crypto sandbox requires crossOriginIsolated=true. The page is missing Cross-Origin-Opener-Policy: same-origin and/or Cross-Origin-Embedder-Policy: require-corp headers.',
    );
  }
}
