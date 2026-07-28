/**
 * @file crdt-worker.ts
 * @description Dedicated Web Worker that owns all Yjs CRDT documents.
 *
 * Running Yjs inside a Worker keeps CRDT merge calculations off the main UI
 * thread, satisfying the requirement for zero main-thread overhead.
 *
 * Cross-tab synchronisation uses the BroadcastChannel API so that parallel
 * browser tabs sharing the same origin automatically exchange Yjs incremental
 * updates without going through the server.  This resolves the multi-tab
 * merge scenario described in issue #360.
 *
 * Protocol
 * ─────────
 * Main thread  → Worker  :  WorkerRequest   (via postMessage)
 * Worker       → Main    :  WorkerResponse  (via postMessage)
 * Tab A Worker ↔ Tab B Worker : BroadcastChannel 'crdt-sync'
 */

import * as Y from 'yjs';

// ── Message types ──────────────────────────────────────────────────────────

interface WorkerRequest {
  id: string;
  type:
    | 'init'
    | 'applyUpdate'
    | 'applyUpdateFromDB'
    | 'getState'
    | 'merge'
    | 'sync'
    | 'setField'
    | 'destroy';
  docId?: string;
  docType?: string;
  /** Incremental Yjs update as a plain number[] (serialisation-safe). */
  update?: number[];
  /** Full Yjs state vector as number[] for sync handshake. */
  remoteState?: number[];
  /** Field name (used by 'setField'). */
  fieldName?: string;
  /** Field value (used by 'setField'). */
  fieldValue?: unknown;
}

interface WorkerResponse {
  id: string;
  type: 'ready' | 'state' | 'update' | 'merged' | 'synced' | 'error';
  docId?: string;
  /** Full Yjs state encoded as number[] for persistence in IndexedDB. */
  state?: number[];
  data?: unknown;
  error?: string;
}

// ── In-worker state ────────────────────────────────────────────────────────

const docs = new Map<string, Y.Doc>();

/**
 * BroadcastChannel shared across all tabs.  Each tab's Worker instance
 * subscribes to this channel so an update produced in Tab A is automatically
 * applied to Tab B without a server round-trip.
 */
const bc = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('very-prince:crdt-sync')
  : null;

// ── Helpers ────────────────────────────────────────────────────────────────

function toUint8(arr: number[] | Uint8Array): Uint8Array {
  return arr instanceof Uint8Array ? arr : new Uint8Array(arr);
}

function toNumberArray(u8: Uint8Array): number[] {
  return Array.from(u8);
}

function getOrCreateDoc(docId: string): Y.Doc {
  let doc = docs.get(docId);
  if (!doc) {
    doc = new Y.Doc();
    docs.set(docId, doc);

    // Emit incremental updates to the main thread for IndexedDB persistence
    // and to the BroadcastChannel for cross-tab propagation.
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Don't re-broadcast updates that already came from another tab or a
      // server sync — avoids infinite echo loops.
      if (origin === 'remote-tab' || origin === 'sync' || origin === 'external') {
        return;
      }

      const updateArr = toNumberArray(update);

      // Notify the main thread so it can persist to IndexedDB.
      const response: WorkerResponse = {
        id: '',
        type: 'update',
        docId,
        state: updateArr,
      };
      self.postMessage(response);

      // Broadcast to other tabs.
      bc?.postMessage({ type: 'update', docId, update: updateArr });
    });
  }
  return doc;
}

function buildStateResponse(id: string, type: WorkerResponse['type'], docId: string, doc: Y.Doc): WorkerResponse {
  const state = Y.encodeStateAsUpdate(doc);
  const map = doc.getMap<unknown>('data');
  return {
    id,
    type,
    docId,
    state: toNumberArray(state),
    data: map.toJSON(),
  };
}

// ── BroadcastChannel handler (cross-tab updates) ───────────────────────────

if (bc) {
  bc.onmessage = (event: MessageEvent<{ type: string; docId: string; update: number[] }>) => {
    const { type, docId, update } = event.data;
    if (type !== 'update' || !docId || !update) return;

    const doc = docs.get(docId);
    if (!doc) return; // this tab hasn't opened the document yet — skip

    try {
      Y.applyUpdate(doc, toUint8(update), 'remote-tab');
      // Notify the main thread that data changed so React can re-render.
      const response: WorkerResponse = {
        id: '',
        type: 'update',
        docId,
        state: toNumberArray(Y.encodeStateAsUpdate(doc)),
        data: doc.getMap<unknown>('data').toJSON(),
      };
      self.postMessage(response);
    } catch {
      // Malformed update from another tab — silently discard.
    }
  };
}

// ── Main message handler ───────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  try {
    switch (req.type) {
      // ── init ──────────────────────────────────────────────────────────────
      case 'init': {
        if (req.docId) getOrCreateDoc(req.docId);
        self.postMessage({ id: req.id, type: 'ready' } as WorkerResponse);
        break;
      }

      // ── applyUpdate: apply a raw incremental Yjs update ──────────────────
      case 'applyUpdate': {
        if (!req.docId || !req.update) {
          throw new Error('applyUpdate requires docId and update');
        }
        const doc = getOrCreateDoc(req.docId);
        Y.applyUpdate(doc, toUint8(req.update), 'sync');
        self.postMessage({ id: req.id, type: 'state', docId: req.docId } as WorkerResponse);
        break;
      }

      // ── applyUpdateFromDB: restore persisted full state into the doc ──────
      // Used by crdtManager.initDocument to seed the in-memory Yjs doc from
      // the IndexedDB snapshot so that offline edits continue from where they
      // left off after a page reload.
      case 'applyUpdateFromDB': {
        if (!req.docId || !req.update) {
          throw new Error('applyUpdateFromDB requires docId and update');
        }
        const doc = getOrCreateDoc(req.docId);
        Y.applyUpdate(doc, toUint8(req.update), 'sync');
        self.postMessage(buildStateResponse(req.id, 'state', req.docId, doc));
        break;
      }

      // ── getState: return the current full Yjs state ───────────────────────
      case 'getState': {
        if (!req.docId) throw new Error('getState requires docId');
        const doc = getOrCreateDoc(req.docId);
        self.postMessage(buildStateResponse(req.id, 'state', req.docId, doc));
        break;
      }

      // ── setField: mutate a single field in the 'data' Y.Map ─────────────
      // This is the primary entry point for form-field edits — each keystroke
      // produces a tiny Yjs delta rather than a full document snapshot.
      case 'setField': {
        if (!req.docId || req.fieldName === undefined) {
          throw new Error('setField requires docId and fieldName');
        }
        const doc = getOrCreateDoc(req.docId);
        doc.transact(() => {
          doc.getMap<unknown>('data').set(req.fieldName!, req.fieldValue ?? null);
        }, 'local');
        self.postMessage(buildStateResponse(req.id, 'state', req.docId, doc));
        break;
      }

      // ── merge: apply an external incremental update (e.g. from server) ───
      case 'merge': {
        if (!req.docId || !req.update) {
          throw new Error('merge requires docId and update');
        }
        const doc = getOrCreateDoc(req.docId);
        Y.applyUpdate(doc, toUint8(req.update), 'external');
        self.postMessage(buildStateResponse(req.id, 'merged', req.docId, doc));
        break;
      }

      // ── sync: two-way state exchange with the server ──────────────────────
      case 'sync': {
        if (!req.docId || !req.remoteState) {
          throw new Error('sync requires docId and remoteState');
        }
        const doc = getOrCreateDoc(req.docId);
        Y.applyUpdate(doc, toUint8(req.remoteState), 'sync');
        self.postMessage(buildStateResponse(req.id, 'synced', req.docId, doc));
        break;
      }

      // ── destroy: free memory when a document is no longer needed ─────────
      case 'destroy': {
        if (req.docId) {
          const doc = docs.get(req.docId);
          if (doc) {
            doc.destroy();
            docs.delete(req.docId);
          }
        }
        self.postMessage({ id: req.id, type: 'ready' } as WorkerResponse);
        break;
      }

      default:
        throw new Error(`Unknown message type: ${(req as WorkerRequest).type}`);
    }
  } catch (err) {
    self.postMessage({
      id: req.id,
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    } as WorkerResponse);
  }
};

// Signal that the worker is alive.
self.postMessage({ id: '', type: 'ready' } as WorkerResponse);
