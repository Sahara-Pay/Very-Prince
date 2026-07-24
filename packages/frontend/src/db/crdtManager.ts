/**
 * @file crdtManager.ts
 * @description Bridge between the main thread and the CRDT Web Worker.
 *
 * All Yjs document operations are delegated to the dedicated Worker so that
 * merge calculations never block the React render cycle.  This file exposes a
 * Promise-based API that the sync engine and React hooks consume.
 *
 * IndexedDB persistence (via Dexie) is handled here so the Worker stays
 * stateless with respect to storage — it only holds in-memory Yjs documents.
 */

import { db, type CRDTUpdateRow } from './db';
import type { CRDTDocument } from '@/lib/crdtTypes';

// ── Types mirrored from the worker ─────────────────────────────────────────

type WorkerMessageHandler = (data: WorkerUpdateEvent) => void;

export interface WorkerUpdateEvent {
  type: string;
  docId?: string;
  state?: number[];
  data?: unknown;
  error?: string;
}

// ── Singleton worker + request book-keeping ────────────────────────────────

let worker: Worker | null = null;
let requestId = 0;
const pendingRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

/**
 * Listeners keyed by docId. Called whenever the Worker emits an 'update'
 * event for that document (local edits or cross-tab BroadcastChannel updates).
 */
const updateListeners = new Map<string, Set<WorkerMessageHandler>>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./crdt-worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<WorkerUpdateEvent>) => {
      const response = event.data;

      // Resolve a pending request.
      if (response.id && pendingRequests.has(response.id as string)) {
        const pending = pendingRequests.get(response.id as string)!;
        pendingRequests.delete(response.id as string);
        if (response.type === 'error') {
          pending.reject(new Error(response.error ?? 'Unknown CRDT worker error'));
        } else {
          pending.resolve(response);
        }
      }

      // Notify update listeners (cross-tab merge or local edit).
      if (response.docId && response.type === 'update') {
        const listeners = updateListeners.get(response.docId);
        if (listeners) {
          for (const listener of listeners) {
            listener(response);
          }
        }

        // Persist the incremental update to IndexedDB so it survives reloads.
        if (response.state) {
          _persistIncrementalUpdate(response.docId, response.state).catch(() => {});
        }
      }
    };

    worker.onerror = (err) => {
      console.error('[crdt-worker] Uncaught error:', err);
    };
  }
  return worker;
}

function sendRequest(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<WorkerUpdateEvent> {
  return new Promise((resolve, reject) => {
    const id = String(++requestId);
    pendingRequests.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    getWorker().postMessage({ id, type, ...payload });

    // 10 s timeout — generous for offline scenarios.
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`CRDT worker request timed out (type=${type})`));
      }
    }, 10_000);
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialise a Yjs document in the Worker.  If a persisted state snapshot
 * exists in IndexedDB it is loaded into the Worker so offline edits resume
 * exactly where they left off (fixes the gap in the original implementation).
 */
export async function initDocument(docId: string): Promise<void> {
  await sendRequest('init', { docId });

  const existing = await db.documents.get(docId);
  if (existing?.yjsState && existing.yjsState.length > 0) {
    // Restore the full Yjs state from IndexedDB into the Worker's in-memory doc.
    await sendRequest('applyUpdateFromDB', {
      docId,
      update: existing.yjsState,
    });
  }
}

/**
 * Return the current document state from the Worker.
 */
export async function getDocumentState<T = unknown>(
  docId: string,
): Promise<{ data: T; state: number[] }> {
  const result = await sendRequest('getState', { docId });
  return result as { data: T; state: number[] };
}

/**
 * Set a single field inside a document's Y.Map.
 * This is the low-level primitive used by `useCRDTDraft` so that every
 * keystroke produces a tiny incremental Yjs update rather than a full snapshot.
 */
export async function setDocumentField(
  docId: string,
  fieldName: string,
  fieldValue: unknown,
): Promise<{ data: unknown; state: number[] }> {
  const result = await sendRequest('setField', { docId, fieldName, fieldValue });
  return result as { data: unknown; state: number[] };
}

/**
 * Apply a remote incremental Yjs update (from the server pull) and persist it.
 */
export async function mergeRemoteUpdate(
  docId: string,
  update: Uint8Array,
): Promise<{ data: unknown; state: number[] }> {
  const updateArr = Array.from(update);
  const result = await sendRequest('merge', { docId, update: updateArr });
  await _persistIncrementalUpdate(docId, updateArr);
  return result as { data: unknown; state: number[] };
}

/**
 * Two-way sync: apply a full remote state vector and return the merged result.
 */
export async function syncWithRemote(
  docId: string,
  remoteState: Uint8Array,
): Promise<{ data: unknown; state: number[] }> {
  const result = await sendRequest('sync', {
    docId,
    remoteState: Array.from(remoteState),
  });
  return result as { data: unknown; state: number[] };
}

/**
 * Destroy the in-memory Yjs document inside the Worker to free memory.
 */
export async function destroyDocument(docId: string): Promise<void> {
  await sendRequest('destroy', { docId });
}

/**
 * Subscribe to update events emitted by the Worker for a specific document.
 * Returns an unsubscribe function.
 */
export function onUpdate(
  docId: string,
  handler: WorkerMessageHandler,
): () => void {
  if (!updateListeners.has(docId)) {
    updateListeners.set(docId, new Set());
  }
  updateListeners.get(docId)!.add(handler);
  return () => {
    updateListeners.get(docId)?.delete(handler);
  };
}

// ── IndexedDB helpers ──────────────────────────────────────────────────────

/**
 * Persist a high-level document snapshot (keyed by type + id) into the
 * `documents` table and queue an unsynced update row.
 */
export async function persistDocument<T>(
  type: CRDTDocument['type'],
  id: string,
  data: T,
  yjsState?: number[],
): Promise<void> {
  const existing = await db.documents.get(id);
  const now = Date.now();
  const doc: CRDTDocument<T> = {
    id,
    type,
    data,
    yjsState,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now,
  };
  await db.documents.put(doc);

  const updateId = crypto.randomUUID();
  await db.crdtUpdates.put({
    id: updateId,
    docId: id,
    docType: type,
    // Encode as number[] for IndexedDB compatibility.
    update: yjsState ?? Array.from(new TextEncoder().encode(JSON.stringify(data))),
    timestamp: now,
    synced: false,
  });
}

export async function getDocument<T = unknown>(
  id: string,
): Promise<CRDTDocument<T> | undefined> {
  const doc = await db.documents.get(id);
  if (doc && !doc.deleted) {
    return doc as CRDTDocument<T>;
  }
  return undefined;
}

export async function queryDocuments<T = unknown>(
  type: CRDTDocument['type'],
): Promise<CRDTDocument<T>[]> {
  const docs = await db.documents.where({ type, deleted: 0 }).toArray();
  return docs as CRDTDocument<T>[];
}

export async function deleteDocument(id: string): Promise<void> {
  const existing = await db.documents.get(id);
  if (existing) {
    existing.deleted = true;
    existing.version += 1;
    existing.updatedAt = Date.now();
    await db.documents.put(existing);
  }
}

export async function getPendingUpdates(): Promise<CRDTUpdateRow[]> {
  return db.crdtUpdates.where('synced').equals(0).toArray();
}

export async function markUpdateSynced(updateId: string): Promise<void> {
  await db.crdtUpdates.update(updateId, { synced: true });
}

/**
 * Persist an incremental Yjs update to the `documents` table (yjsState) and
 * queue it as an unsynced `crdtUpdates` row.
 *
 * @internal Called automatically from the Worker `onmessage` handler whenever
 * an 'update' event is received — callers should not call this directly.
 */
async function _persistIncrementalUpdate(
  docId: string,
  updateArr: number[],
): Promise<void> {
  const existing = await db.documents.get(docId);
  if (!existing) return;

  existing.yjsState = updateArr;
  existing.version += 1;
  existing.updatedAt = Date.now();
  await db.documents.put(existing);

  const updateId = crypto.randomUUID();
  await db.crdtUpdates.put({
    id: updateId,
    docId,
    docType: existing.type,
    update: updateArr,
    timestamp: Date.now(),
    synced: false,
  });
}
