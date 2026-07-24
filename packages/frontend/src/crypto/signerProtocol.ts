/**
 * @file signerProtocol.ts
 * @description Protocol types and constants for the SharedArrayBuffer-based
 *              communication channel between the UI thread and the signing worker.
 *
 * Layout of the control SharedArrayBuffer (Int32Array view, 4 bytes/slot):
 *
 *   Slot 0 — STATE:    Atomics.wait/notify target. Written by both sides.
 *   Slot 1 — LENGTH:   Byte-length of the payload written into the data SAB.
 *   Slot 2 — STATUS:   Result status code written by the worker after signing.
 *   Slot 3 — RESERVED: Unused; kept for future extension / alignment.
 *
 * The data SharedArrayBuffer carries raw bytes (input message going in,
 * signature bytes coming out).  Its size is fixed at DATA_SAB_BYTES.
 */

// ─── Layout constants ─────────────────────────────────────────────────────────

/** Total number of Int32 slots in the control SAB. */
export const CTRL_SLOTS = 4;

/** Byte size of the control SharedArrayBuffer. */
export const CTRL_SAB_BYTES = CTRL_SLOTS * Int32Array.BYTES_PER_ELEMENT;

/** Maximum message / signature size in the data SAB (4 KiB is ample for XDR). */
export const DATA_SAB_BYTES = 4096;

// ─── Control slot indices ─────────────────────────────────────────────────────

/** Index of the STATE slot (used with Atomics.wait / Atomics.notify). */
export const SLOT_STATE = 0;

/** Index of the LENGTH slot (byte-length of the payload in the data SAB). */
export const SLOT_LENGTH = 1;

/** Index of the STATUS slot (result code written by the worker). */
export const SLOT_STATUS = 2;

/** Index of the RESERVED slot. */
export const SLOT_RESERVED = 3;

// ─── State values (written to SLOT_STATE) ─────────────────────────────────────

/**
 * The worker is idle — no signing in progress.
 * Main thread sets this value after reading the result.
 */
export const STATE_IDLE = 0;

/**
 * A signing request is pending — the worker should begin.
 * Main thread sets this before calling Atomics.notify.
 */
export const STATE_SIGN_REQUEST = 1;

/**
 * The worker has completed signing and written the result.
 * Worker sets this before calling Atomics.notify.
 */
export const STATE_SIGN_DONE = 2;

// ─── Status codes (written to SLOT_STATUS by the worker) ──────────────────────

/** Signing succeeded. */
export const STATUS_OK = 0;

/** Signing failed (error details sent via postMessage). */
export const STATUS_ERROR = 1;

// ─── Message types (postMessage channel — used in parallel with SAB) ──────────

/**
 * All messages sent FROM the main thread TO the worker.
 */
export type WorkerInboundMessage =
  | {
      /** Unique request ID (UUID or timestamp). */
      id: string;
      type: 'init';
      /**
       * The control SAB (CTRL_SAB_BYTES long).
       * Transferred as a SharedArrayBuffer — no copy is made.
       */
      controlSab: SharedArrayBuffer;
      /**
       * The data SAB (DATA_SAB_BYTES long).
       * Shared between both threads for zero-copy payload exchange.
       */
      dataSab: SharedArrayBuffer;
    }
  | {
      id: string;
      type: 'sign';
      /**
       * The message bytes to sign, written into dataSab[0..length].
       * The main thread writes them before sending this message.
       */
      messageLength: number;
      /**
       * The Ed25519 secret key as a hex string.
       * Using a hex string avoids transferring a typed-array object so the
       * key bytes live only in the worker.  The worker hex-decodes it,
       * signs, then immediately wipes the decoded bytes.
       */
      secretKeyHex: string;
    }
  | {
      id: string;
      type: 'destroy';
    };

/**
 * All messages sent FROM the worker TO the main thread.
 */
export type WorkerOutboundMessage =
  | {
      id: string;
      type: 'ready';
    }
  | {
      id: string;
      type: 'signed';
      /**
       * Length of the signature written into dataSab.
       * The main thread reads dataSab[0..signatureLength] to obtain the bytes.
       */
      signatureLength: number;
    }
  | {
      id: string;
      type: 'error';
      error: string;
    };

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Encode a Uint8Array as a lowercase hex string.
 * Used to pass secret key material into the worker without transferring
 * a typed-array object (which would copy the buffer into worker memory
 * AND leave a reference on the main thread).
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Decode a lowercase hex string back into a Uint8Array.
 * Only called inside the worker, never on the main thread.
 */
export function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new RangeError('Hex string must have an even length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
