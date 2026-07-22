import { db } from './db';
import type { CRDTDocument, CRDTUpdate } from '@/lib/crdtTypes';

type WorkerMessageHandler = (data: unknown) => void;

let worker: Worker | null = null;
let requestId = 0;
const pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const updateListeners = new Map<string, Set<WorkerMessageHandler>>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./crdt-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const response = event.data;
      if (response.id && pendingRequests.has(response.id)) {
        const pending = pendingRequests.get(response.id)!;
        pendingRequests.delete(response.id);
        if (response.type === 'error') {
          pending.reject(new Error(response.error));
        } else {
          pending.resolve(response);
        }
      }
      if (response.docId && response.type === 'update') {
        const listeners = updateListeners.get(response.docId);
        if (listeners) {
          for (const listener of listeners) {
            listener(response);
          }
        }
      }
    };
  }
  return worker;
}

function sendRequest(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = String(++requestId);
    const msg = { id, type, ...payload };
    pendingRequests.set(id, { resolve, reject });
    getWorker().postMessage(msg);
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('CRDT worker request timed out'));
      }
    }, 10_000);
  });
}

export async function initDocument(docId: string): Promise<void> {
  await sendRequest('init', { docId });
  const existing = await db.documents.get(docId);
  if (existing) {
    await sendRequest('applyUpdate', { docId, update: new Uint8Array() });
  }
}

export async function getDocumentState<T = unknown>(docId: string): Promise<{ data: T; state: Uint8Array }> {
  const result = await sendRequest('getState', { docId }) as { data: T; state: Uint8Array };
  return result;
}

export async function mergeRemoteUpdate(docId: string, update: Uint8Array): Promise<{ data: unknown; state: Uint8Array }> {
  const result = await sendRequest('merge', { docId, update }) as { data: unknown; state: Uint8Array };
  await persistUpdate(docId, update);
  return result;
}

export async function syncWithRemote(docId: string, remoteState: Uint8Array): Promise<{ data: unknown; state: Uint8Array }> {
  const result = await sendRequest('sync', { docId, remoteState }) as { data: unknown; state: Uint8Array };
  return result;
}

export async function destroyDocument(docId: string): Promise<void> {
  await sendRequest('destroy', { docId });
}

export function onUpdate(docId: string, handler: WorkerMessageHandler): () => void {
  if (!updateListeners.has(docId)) {
    updateListeners.set(docId, new Set());
  }
  updateListeners.get(docId)!.add(handler);
  return () => {
    updateListeners.get(docId)?.delete(handler);
  };
}

function generateId(): string {
  return crypto.randomUUID();
}

export async function persistDocument<T>(type: CRDTDocument['type'], id: string, data: T): Promise<void> {
  const existing = await db.documents.get(id);
  const now = Date.now();
  const doc: CRDTDocument<T> = {
    id,
    type,
    data,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now,
  };
  await db.documents.put(doc);

  const updateId = generateId();
  await db.crdtUpdates.put({
    id: updateId,
    docId: id,
    docType: type,
    update: new TextEncoder().encode(JSON.stringify(data)),
    timestamp: now,
    synced: false,
  });
}

export async function getDocument<T = unknown>(id: string): Promise<CRDTDocument<T> | undefined> {
  const doc = await db.documents.get(id);
  if (doc && !doc.deleted) {
    return doc as CRDTDocument<T>;
  }
  return undefined;
}

export async function queryDocuments<T = unknown>(type: CRDTDocument['type']): Promise<CRDTDocument<T>[]> {
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

export async function getPendingUpdates() {
  return db.crdtUpdates.where('synced').equals(0).toArray();
}

export async function markUpdateSynced(updateId: string): Promise<void> {
  await db.crdtUpdates.update(updateId, { synced: true });
}

async function persistUpdate(docId: string, update: Uint8Array): Promise<void> {
  const existing = await db.documents.get(docId);
  if (existing) {
    existing.version += 1;
    existing.updatedAt = Date.now();
    await db.documents.put(existing);
  }
}
