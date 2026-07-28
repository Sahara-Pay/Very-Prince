/**
 * @file syncEngine.ts
 * @description Network-recovery sync engine.
 *
 * Responsibilities:
 *  1. Push pending (unsynced) CRDT updates to the backend tRPC sync.push
 *     endpoint when the browser comes back online.
 *  2. Pull remote CRDT changesets from sync.pull and merge them into local
 *     Yjs documents via the CRDT worker.
 *  3. Expose real-time sync status (online / syncing / pending count) to
 *     React hooks via a lightweight listener pattern.
 *
 * The engine is started once at application mount (see useSyncEngine in
 * useOffline.ts) and automatically handles network recovery.
 */

import { db } from './db';
import { getPendingUpdates, markUpdateSynced, mergeRemoteUpdate } from './crdtManager';
import { trpcClient } from '@/trpc/client';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SyncStatus {
  online: boolean;
  syncing: boolean;
  pendingChanges: number;
}

type SyncStatusListener = (status: SyncStatus) => void;

// ── Module state ───────────────────────────────────────────────────────────

const listeners = new Set<SyncStatusListener>();
let isSyncing = false;

// ── Internal helpers ───────────────────────────────────────────────────────

async function getPendingCount(): Promise<number> {
  try {
    return await db.crdtUpdates.where('synced').equals(0).count();
  } catch {
    return 0;
  }
}

async function buildStatus(): Promise<SyncStatus> {
  return {
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    syncing: isSyncing,
    pendingChanges: await getPendingCount(),
  };
}

async function notifyListeners(): Promise<void> {
  const status = await buildStatus();
  for (const listener of listeners) {
    listener(status);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Synchronous snapshot of the current sync status.
 * `pendingChanges` may lag by one tick; use `onSyncStatusChange` for
 * reactive updates.
 */
export function getSyncStatus(): SyncStatus {
  return {
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    syncing: isSyncing,
    pendingChanges: 0, // populated async; subscribe for live value
  };
}

export function onSyncStatusChange(listener: SyncStatusListener): () => void {
  listeners.add(listener);
  // Immediately deliver the current status to the new subscriber.
  buildStatus().then(listener).catch(() => {});
  return () => listeners.delete(listener);
}

export function startSyncEngine(): void {
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  if (navigator.onLine) {
    syncNow().catch(() => {});
  }
}

export function stopSyncEngine(): void {
  window.removeEventListener('online', handleOnline);
  window.removeEventListener('offline', handleOffline);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
}

// ── Event handlers ─────────────────────────────────────────────────────────

async function handleOnline(): Promise<void> {
  await notifyListeners();
  await syncNow();
}

async function handleOffline(): Promise<void> {
  await notifyListeners();
}

async function handleVisibilityChange(): Promise<void> {
  if (document.visibilityState === 'visible' && navigator.onLine) {
    await syncNow();
  }
}

// ── Core sync logic ────────────────────────────────────────────────────────

/**
 * Run a full push-then-pull cycle.  Re-entrant calls are silently dropped so
 * multiple `online` events don't stack up.
 */
export async function syncNow(): Promise<void> {
  if (isSyncing || !navigator.onLine) return;
  isSyncing = true;
  await notifyListeners();

  try {
    await pushPendingChanges();
    await pullRemoteChanges();
  } catch (err) {
    console.error('[syncEngine] Sync cycle error:', err);
  } finally {
    isSyncing = false;
    await notifyListeners();
  }
}

/**
 * Push all unsynced CRDT update rows to the backend.
 * Individual failures are logged but do not abort the remaining rows so that
 * a single bad document doesn't block the whole queue.
 */
async function pushPendingChanges(): Promise<void> {
  const pending = await getPendingUpdates();
  if (pending.length === 0) return;

  for (const row of pending) {
    try {
      await trpcClient.sync.push.mutate({
        docId: row.docId,
        docType: row.docType,
        update: row.update,        // already number[]
        timestamp: row.timestamp,
      });
      await markUpdateSynced(row.id);
    } catch (err) {
      console.error(`[syncEngine] Failed to push update for doc ${row.docId}:`, err);
    }
  }
}

/**
 * Pull remote changesets from the backend and merge them into local Yjs docs.
 * Uses the persisted `lastPullTime` so we only fetch deltas, not the full history.
 */
async function pullRemoteChanges(): Promise<void> {
  try {
    // Use the stored last-pull timestamp so we don't re-fetch old changesets.
    const lastPull = await db.syncState.toCollection().last();
    const since = lastPull?.lastPullTime ?? Date.now() - 60 * 60 * 1000; // fallback: 1 h

    const response = await trpcClient.sync.pull.query({ since });

    for (const changeset of response.changesets ?? []) {
      const update = new Uint8Array(changeset.update);
      await mergeRemoteUpdate(changeset.docId, update);
    }

    // Record the server's timestamp so the next pull delta starts here.
    const serverTime: number = (response as { serverTime?: number }).serverTime ?? Date.now();
    await db.syncState.put({
      lastPullTime: serverTime,
      lastPushTime: Date.now(),
      pendingChanges: 0,
      isSyncing: false,
    });
  } catch (err) {
    console.error('[syncEngine] Failed to pull remote changes:', err);
  }
}
