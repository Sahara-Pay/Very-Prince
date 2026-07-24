/**
 * @file signing-worker.ts
 * @description Off-main-thread Ed25519 signing worker.
 *
 * SECURITY CONTRACT:
 *  - Private key bytes NEVER leave this worker.
 *  - After each signing operation the decoded key bytes are securely wiped.
 *  - No key material is ever posted back to the main thread via postMessage.
 *  - The signature result is written directly into the shared DataSAB so the
 *    main thread can read it without a copy being passed through the message
 *    queue (where it could be observed by other scripts).
 *
 * Communication protocol:
 *  1. Main thread sends `init` message carrying two SharedArrayBuffers:
 *       controlSab — Int32Array (4 slots) for Atomics signalling.
 *       dataSab    — Uint8Array (4 KiB) for zero-copy payload exchange.
 *  2. For each signing request the main thread:
 *       a. Writes message bytes into dataSab[0..messageLength].
 *       b. Atomics.store(ctrl, SLOT_LENGTH, messageLength).
 *       c. Atomics.store(ctrl, SLOT_STATE, STATE_SIGN_REQUEST).
 *       d. Sends `sign` postMessage (wakes worker if it is sleeping).
 *  3. The worker:
 *       a. Reads messageLength from SLOT_LENGTH.
 *       b. Copies message bytes out of dataSab.
 *       c. Signs with the provided secret key hex, then immediately wipes key.
 *       d. Writes 64-byte signature into dataSab[0..64].
 *       e. Atomics.store(ctrl, SLOT_STATUS, STATUS_OK).
 *       f. Atomics.store(ctrl, SLOT_STATE, STATE_SIGN_DONE).
 *       g. Atomics.notify(ctrl, SLOT_STATE, 1).
 *       h. Posts `signed` message with signatureLength.
 */

import {
  type WorkerInboundMessage,
  type WorkerOutboundMessage,
  SLOT_STATE,
  SLOT_LENGTH,
  SLOT_STATUS,
  STATE_SIGN_DONE,
  STATUS_OK,
  STATUS_ERROR,
  hexToUint8Array,
} from './signerProtocol';
import { signMessage, secureWipe } from './ed25519';

// ─── Worker state ─────────────────────────────────────────────────────────────

let controlView: Int32Array | null = null;
let dataView: Uint8Array | null = null;

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'init': {
      controlView = new Int32Array(msg.controlSab);
      dataView = new Uint8Array(msg.dataSab);

      const response: WorkerOutboundMessage = { id: msg.id, type: 'ready' };
      self.postMessage(response);
      break;
    }

    case 'sign': {
      if (!controlView || !dataView) {
        const response: WorkerOutboundMessage = {
          id: msg.id,
          type: 'error',
          error: 'Worker not initialised — send init message first',
        };
        self.postMessage(response);
        return;
      }

      let secretKey: Uint8Array | null = null;

      try {
        const messageLength = msg.messageLength;

        if (messageLength <= 0 || messageLength > dataView.byteLength) {
          throw new RangeError(
            `messageLength ${messageLength} is out of bounds (max ${dataView.byteLength})`,
          );
        }

        // 1. Copy message bytes out of the shared buffer into a local Uint8Array.
        //    We copy rather than view so that the main thread cannot mutate
        //    the bytes mid-signing (time-of-check vs time-of-use protection).
        const message = dataView.slice(0, messageLength);

        // 2. Decode secret key from hex — key bytes now exist ONLY in this
        //    worker's local variable; they never touched the main thread heap.
        secretKey = hexToUint8Array(msg.secretKeyHex);

        // 3. Sign — Ed25519 via tweetnacl (pure JS, no network calls).
        const signature = signMessage(message, secretKey);

        // 4. Write signature back into the shared data buffer.
        dataView.set(signature, 0);

        // 5. Update control buffer so the main thread can Atomics.wait for done.
        Atomics.store(controlView, SLOT_STATUS, STATUS_OK);
        Atomics.store(controlView, SLOT_LENGTH, signature.length);
        Atomics.store(controlView, SLOT_STATE, STATE_SIGN_DONE);
        Atomics.notify(controlView, SLOT_STATE, 1);

        // 6. Also post a message for environments where Atomics.wait is not
        //    available on the main thread (e.g. main browser thread — MUST use
        //    Atomics.waitAsync or postMessage; the SAB still carries the bytes).
        const response: WorkerOutboundMessage = {
          id: msg.id,
          type: 'signed',
          signatureLength: signature.length,
        };
        self.postMessage(response);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (controlView) {
          Atomics.store(controlView, SLOT_STATUS, STATUS_ERROR);
          Atomics.store(controlView, SLOT_STATE, STATE_SIGN_DONE);
          Atomics.notify(controlView, SLOT_STATE, 1);
        }

        const response: WorkerOutboundMessage = {
          id: msg.id,
          type: 'error',
          error: errorMessage,
        };
        self.postMessage(response);
      } finally {
        // 7. Securely wipe the decoded secret key bytes from worker memory.
        if (secretKey) {
          secureWipe(secretKey);
          secretKey = null;
        }
      }
      break;
    }

    case 'destroy': {
      // Clean up references and allow GC to collect SAB backing stores.
      controlView = null;
      dataView = null;

      const response: WorkerOutboundMessage = { id: msg.id, type: 'ready' };
      self.postMessage(response);
      break;
    }

    default: {
      // Exhaustiveness guard — TS will error if a case is missing.
      const _exhaustive: never = msg;
      console.error('[signing-worker] Unknown message type', _exhaustive);
    }
  }
};

// Signal readiness immediately so the manager knows the worker script loaded.
self.postMessage({ id: '', type: 'ready' } satisfies WorkerOutboundMessage);
