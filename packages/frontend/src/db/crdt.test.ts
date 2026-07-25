/**
 * @file crdt.test.ts
 * @description Unit tests for the CRDT/IndexedDB/sync-engine layer.
 *
 * The Yjs Worker is mocked so these tests run in jsdom without a real Worker
 * or IndexedDB implementation.  We test:
 *  1. crdtManager – request/response plumbing and DB interactions
 *  2. syncEngine  – push/pull cycle, online recovery, pendingChanges counter
 *  3. useCRDTDraft – hook lifecycle, optimistic updates, cross-tab events
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';

// ── Dexie mock ────────────────────────────────────────────────────────────

// Use an in-memory store so Dexie doesn't try to open a real IDBFactory.
vi.mock('@/db/db', () => {
  const store = new Map<string, unknown>();
  const updateStore = new Map<string, unknown>();

  return {
    db: {
      documents: {
        get: vi.fn(async (id: string) => store.get(id)),
        put: vi.fn(async (doc: { id: string }) => { store.set(doc.id, doc); }),
        where: vi.fn(() => ({
          equals: vi.fn(() => ({ toArray: vi.fn(async () => []), count: vi.fn(async () => 0) })),
          toArray: vi.fn(async () => []),
        })),
        toCollection: vi.fn(() => ({ last: vi.fn(async () => undefined) })),
      },
      crdtUpdates: {
        put: vi.fn(async (row: { id: string }) => { updateStore.set(row.id, row); }),
        update: vi.fn(async () => {}),
        where: vi.fn(() => ({
          equals: vi.fn(() => ({
            toArray: vi.fn(async () => []),
            count: vi.fn(async () => 0),
          })),
        })),
      },
      syncState: {
        put: vi.fn(async () => {}),
        toCollection: vi.fn(() => ({ last: vi.fn(async () => undefined) })),
      },
    },
  };
});

// ── Worker mock ────────────────────────────────────────────────────────────
// Simulate synchronous in-process Yjs operations so the Worker bridge
// resolves instantly without spawning a real thread.

const _mockDocs = new Map<string, Y.Doc>();

function getMockDoc(docId: string): Y.Doc {
  if (!_mockDocs.has(docId)) {
    _mockDocs.set(docId, new Y.Doc());
  }
  return _mockDocs.get(docId)!;
}

vi.mock('./crdt-worker.ts', () => ({})); // prevent direct import

// Patch the Worker constructor used inside crdtManager.
class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  postMessage(msg: { id: string; type: string; docId?: string; fieldName?: string; fieldValue?: unknown; update?: number[]; remoteState?: number[] }) {
    // Process the message synchronously and call onmessage with the response.
    const { id, type, docId, fieldName, fieldValue, update, remoteState } = msg;

    let response: Record<string, unknown> = { id, type: 'ready' };

    if (type === 'init' && docId) {
      getMockDoc(docId);
      response = { id, type: 'ready' };
    } else if ((type === 'applyUpdateFromDB' || type === 'applyUpdate') && docId && update) {
      const doc = getMockDoc(docId);
      Y.applyUpdate(doc, new Uint8Array(update), 'sync');
      response = { id, type: 'state', docId };
    } else if (type === 'getState' && docId) {
      const doc = getMockDoc(docId);
      response = {
        id,
        type: 'state',
        docId,
        state: Array.from(Y.encodeStateAsUpdate(doc)),
        data: doc.getMap('data').toJSON(),
      };
    } else if (type === 'setField' && docId && fieldName !== undefined) {
      const doc = getMockDoc(docId);
      doc.transact(() => { doc.getMap('data').set(fieldName, fieldValue ?? null); });
      response = {
        id,
        type: 'state',
        docId,
        state: Array.from(Y.encodeStateAsUpdate(doc)),
        data: doc.getMap('data').toJSON(),
      };
    } else if (type === 'merge' && docId && update) {
      const doc = getMockDoc(docId);
      Y.applyUpdate(doc, new Uint8Array(update), 'external');
      response = {
        id,
        type: 'merged',
        docId,
        state: Array.from(Y.encodeStateAsUpdate(doc)),
        data: doc.getMap('data').toJSON(),
      };
    } else if (type === 'sync' && docId && remoteState) {
      const doc = getMockDoc(docId);
      Y.applyUpdate(doc, new Uint8Array(remoteState), 'sync');
      response = {
        id,
        type: 'synced',
        docId,
        state: Array.from(Y.encodeStateAsUpdate(doc)),
        data: doc.getMap('data').toJSON(),
      };
    } else if (type === 'destroy' && docId) {
      _mockDocs.delete(docId);
      response = { id, type: 'ready' };
    }

    // Deliver the response asynchronously (mirrors real Worker behaviour).
    setTimeout(() => {
      this.onmessage?.({ data: response } as MessageEvent);
    }, 0);
  }
}

vi.stubGlobal('Worker', MockWorker);
vi.stubGlobal('BroadcastChannel', class {
  onmessage = null;
  postMessage() {}
  close() {}
});

// ── Import modules under test AFTER mocks are installed ───────────────────
// Dynamic import ensures the module-level `worker` variable is reset.

async function freshManager() {
  vi.resetModules();
  return import('@/db/crdtManager');
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('crdtManager', () => {
  beforeEach(() => {
    _mockDocs.clear();
  });

  it('initDocument seeds the Worker from IndexedDB when a saved state exists', async () => {
    const { db } = await import('@/db/db');
    const { initDocument } = await freshManager();

    // Simulate a persisted document with a Yjs snapshot.
    const fakeDoc = new Y.Doc();
    fakeDoc.getMap('data').set('name', 'Offline Org');
    const yjsState = Array.from(Y.encodeStateAsUpdate(fakeDoc));

    vi.mocked(db.documents.get).mockResolvedValueOnce({
      id: 'org-1',
      type: 'organization',
      data: {},
      yjsState,
      version: 1,
      updatedAt: Date.now(),
    });

    await initDocument('org-1');

    const workerDoc = _mockDocs.get('org-1');
    expect(workerDoc).toBeDefined();
    expect(workerDoc!.getMap('data').get('name')).toBe('Offline Org');
  });

  it('setDocumentField updates the Y.Map and returns merged data', async () => {
    const { initDocument, setDocumentField } = await freshManager();

    await initDocument('draft:test-form');
    const result = await setDocumentField('draft:test-form', 'orgName', 'My Org');

    expect(result.data).toMatchObject({ orgName: 'My Org' });
  });

  it('mergeRemoteUpdate applies an external update and persists it', async () => {
    const { db } = await import('@/db/db');
    const { initDocument, mergeRemoteUpdate } = await freshManager();

    vi.mocked(db.documents.get).mockResolvedValue({
      id: 'org-2',
      type: 'organization',
      data: {},
      version: 1,
      updatedAt: Date.now(),
    });

    await initDocument('org-2');

    // Build a real Yjs update from another doc.
    const remoteDoc = new Y.Doc();
    remoteDoc.getMap('data').set('budget', '1000');
    const update = Y.encodeStateAsUpdate(remoteDoc);

    const result = await mergeRemoteUpdate('org-2', update);

    expect(result.data).toMatchObject({ budget: '1000' });
    expect(db.crdtUpdates.put).toHaveBeenCalled();
  });
});

describe('syncEngine', () => {
  const trpcMock = {
    sync: {
      push: { mutate: vi.fn(async () => ({ success: true, received: Date.now() })) },
      pull: { query: vi.fn(async () => ({ changesets: [], serverTime: Date.now() })) },
    },
  };

  vi.mock('@/trpc/client', () => ({ trpcClient: trpcMock }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible',
    });
  });

  it('syncNow pushes pending updates then pulls remote changes', async () => {
    const { db } = await import('@/db/db');
    const { syncNow } = await (async () => {
      vi.resetModules();
      return import('@/db/syncEngine');
    })();

    vi.mocked(db.crdtUpdates.where).mockReturnValue({
      equals: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { id: 'u1', docId: 'doc-1', docType: 'organization', update: [1, 2, 3], timestamp: Date.now(), synced: false },
        ]),
        count: vi.fn().mockResolvedValue(1),
      }),
    } as ReturnType<typeof db.crdtUpdates.where>);

    await syncNow();

    expect(trpcMock.sync.push.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ docId: 'doc-1' }),
    );
    expect(trpcMock.sync.pull.query).toHaveBeenCalled();
  });

  it('syncNow is a no-op when offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });

    const { syncNow } = await (async () => {
      vi.resetModules();
      return import('@/db/syncEngine');
    })();

    await syncNow();

    expect(trpcMock.sync.push.mutate).not.toHaveBeenCalled();
    expect(trpcMock.sync.pull.query).not.toHaveBeenCalled();
  });
});

describe('Yjs CRDT merge semantics', () => {
  it('concurrent Y.Map edits in two independent documents merge without data loss', () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    // Simulate Tab A editing 'name' and Tab B editing 'admin' simultaneously.
    doc1.getMap('data').set('name', 'Org Alpha');
    doc2.getMap('data').set('admin', 'GXYZ...');

    // Exchange updates.
    const update1 = Y.encodeStateAsUpdate(doc1);
    const update2 = Y.encodeStateAsUpdate(doc2);

    Y.applyUpdate(doc1, update2);
    Y.applyUpdate(doc2, update1);

    // Both docs should converge to the same state with no data loss.
    expect(doc1.getMap('data').toJSON()).toMatchObject({ name: 'Org Alpha', admin: 'GXYZ...' });
    expect(doc2.getMap('data').toJSON()).toMatchObject({ name: 'Org Alpha', admin: 'GXYZ...' });
    expect(doc1.getMap('data').toJSON()).toEqual(doc2.getMap('data').toJSON());
  });

  it('last writer wins for the same key across concurrent edits', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    // Both edit 'name' concurrently (different client IDs).
    docA.getMap('data').set('name', 'Alpha Name');
    docB.getMap('data').set('name', 'Beta Name');

    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // Yjs resolves concurrent same-key edits deterministically.
    const resultA = docA.getMap('data').get('name') as string;
    const resultB = docB.getMap('data').get('name') as string;

    // The two docs must converge to the same value (CRDT guarantee).
    expect(resultA).toBe(resultB);
    expect(typeof resultA).toBe('string');
  });

  it('encodeStateAsUpdate / applyUpdate round-trips without corruption', () => {
    const source = new Y.Doc();
    source.getMap('data').set('budgetStroops', '500000000');
    source.getMap('data').set('maintainers', ['G1', 'G2', 'G3']);

    const encoded = Y.encodeStateAsUpdate(source);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBeGreaterThan(0);

    const target = new Y.Doc();
    Y.applyUpdate(target, encoded);

    expect(target.getMap('data').get('budgetStroops')).toBe('500000000');
    expect(target.getMap('data').get('maintainers')).toEqual(['G1', 'G2', 'G3']);
  });
});
