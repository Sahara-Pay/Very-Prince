import { db } from './db';
import { getPendingUpdates, markUpdateSynced, mergeRemoteUpdate, syncWithRemote } from './crdtManager';
import { trpcClient } from '@/trpc/client';

type SyncStatusListener = (status: { online: boolean; syncing: boolean; pendingChanges: number }) => void;

const listeners = new Set<SyncStatusListener>();
let isSyncing = false;

function notifyListeners() {
  const status = getSyncStatus();
  for (const listener of listeners) {
    listener(status);
  }
}

export function getSyncStatus() {
  return {
    online: navigator.onLine,
    syncing: isSyncing,
    pendingChanges: 0,
  };
}

export function onSyncStatusChange(listener: SyncStatusListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startSyncEngine() {
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  navigator.onLine && syncNow();
}

export function stopSyncEngine() {
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('offline', handleOffline);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
}

async function handleOnline() {
  notifyListeners();
  await syncNow();
}

function handleOffline() {
  notifyListeners();
}

async function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && navigator.onLine) {
    await syncNow();
  }
}

export async function syncNow() {
  if (isSyncing || !navigator.onLine) return;
  isSyncing = true;
  notifyListeners();

  try {
    await pushPendingChanges();
    await pullRemoteChanges();
  } catch (err) {
    console.error('Sync engine error:', err);
  } finally {
    isSyncing = false;
    notifyListeners();
  }
}

async function pushPendingChanges() {
  const pending = await getPendingUpdates();
  if (pending.length === 0) return;

  for (const update of pending) {
    try {
      await trpcClient.sync.push.mutate({
        docId: update.docId,
        docType: update.docType,
        update: Array.from(update.update),
        timestamp: update.timestamp,
      });
      await markUpdateSynced(update.id);
    } catch (err) {
      console.error(`Failed to push update for doc ${update.docId}:`, err);
    }
  }
}

async function pullRemoteChanges() {
  try {
    const remoteChangesets = await trpcClient.sync.pull.query({
      since: Date.now() - 5 * 60 * 1000,
    });

    for (const changeset of remoteChangesets.changesets ?? []) {
      const update = new Uint8Array(changeset.update);
      await mergeRemoteUpdate(changeset.docId, update);
    }

    await db.syncState.put({
      lastPullTime: Date.now(),
      lastPushTime: Date.now(),
      pendingChanges: 0,
      isSyncing: false,
    });
  } catch (err) {
    console.error('Failed to pull remote changes:', err);
  }
}
