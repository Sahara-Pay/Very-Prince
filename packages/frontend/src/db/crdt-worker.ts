import * as Y from 'yjs';

interface WorkerRequest {
  id: string;
  type: 'init' | 'applyUpdate' | 'getState' | 'merge' | 'sync' | 'destroy';
  docId?: string;
  docType?: string;
  update?: Uint8Array;
  data?: unknown;
  remoteState?: Uint8Array;
}

interface WorkerResponse {
  id: string;
  type: 'ready' | 'state' | 'update' | 'merged' | 'synced' | 'error';
  docId?: string;
  state?: Uint8Array;
  data?: unknown;
  error?: string;
}

const docs = new Map<string, Y.Doc>();

function getOrCreateDoc(docId: string): Y.Doc {
  let doc = docs.get(docId);
  if (!doc) {
    doc = new Y.Doc();
    docs.set(docId, doc);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'sync') {
        const response: WorkerResponse = {
          id: '',
          type: 'update',
          docId,
          state: update,
        };
        self.postMessage(response);
      }
    });
  }
  return doc;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  try {
    switch (req.type) {
      case 'init': {
        if (req.docId) getOrCreateDoc(req.docId);
        const response: WorkerResponse = { id: req.id, type: 'ready' };
        self.postMessage(response);
        break;
      }

      case 'applyUpdate': {
        if (!req.docId || !req.update) {
          throw new Error('applyUpdate requires docId and update');
        }
        const doc = getOrCreateDoc(req.docId);
        Y.applyUpdate(doc, req.update, 'sync');
        const response: WorkerResponse = { id: req.id, type: 'state', docId: req.docId };
        self.postMessage(response);
        break;
      }

      case 'getState': {
        if (!req.docId) throw new Error('getState requires docId');
        const doc = getOrCreateDoc(req.docId);
        const state = Y.encodeStateAsUpdate(doc);
        const map = doc.getMap('data');
        const data = map.toJSON();
        const response: WorkerResponse = {
          id: req.id,
          type: 'state',
          docId: req.docId,
          state,
          data,
        };
        self.postMessage(response);
        break;
      }

      case 'merge': {
        if (!req.docId || !req.update) {
          throw new Error('merge requires docId and update');
        }
        const doc = getOrCreateDoc(req.docId);
        Y.applyUpdate(doc, req.update, 'external');
        const state = Y.encodeStateAsUpdate(doc);
        const map = doc.getMap('data');
        const data = map.toJSON();
        const response: WorkerResponse = {
          id: req.id,
          type: 'merged',
          docId: req.docId,
          state,
          data,
        };
        self.postMessage(response);
        break;
      }

      case 'sync': {
        if (!req.docId || !req.remoteState) {
          throw new Error('sync requires docId and remoteState');
        }
        const doc = getOrCreateDoc(req.docId);
        Y.applyUpdate(doc, req.remoteState, 'sync');
        const localState = Y.encodeStateAsUpdate(doc);
        const map = doc.getMap('data');
        const data = map.toJSON();
        const response: WorkerResponse = {
          id: req.id,
          type: 'synced',
          docId: req.docId,
          state: localState,
          data,
        };
        self.postMessage(response);
        break;
      }

      case 'destroy': {
        if (req.docId) {
          const doc = docs.get(req.docId);
          if (doc) {
            doc.destroy();
            docs.delete(req.docId);
          }
        }
        const response: WorkerResponse = { id: req.id, type: 'ready' };
        self.postMessage(response);
        break;
      }

      default:
        throw new Error(`Unknown message type: ${(req as WorkerRequest).type}`);
    }
  } catch (err) {
    const response: WorkerResponse = {
      id: req.id,
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};

self.postMessage({ id: '', type: 'ready' } as WorkerResponse);
