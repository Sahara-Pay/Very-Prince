'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { db } from '@/db/db';
import {
  persistDocument,
  getDocument,
  queryDocuments,
  deleteDocument,
  initDocument,
  setDocumentField,
  getDocumentState,
  onUpdate,
  type WorkerUpdateEvent,
} from '@/db/crdtManager';
import { startSyncEngine, stopSyncEngine, onSyncStatusChange, syncNow, getSyncStatus } from '@/db/syncEngine';
import { trpcClient } from '@/trpc/client';
import type { OrganizationCRDT, MaintainerCRDT, PendingTransactionCRDT, DraftCRDT } from '@/lib/crdtTypes';

export function useSyncEngine() {
  const [status, setStatus] = useState(getSyncStatus());

  useEffect(() => {
    startSyncEngine();
    const unsub = onSyncStatusChange(setStatus);
    return () => {
      unsub();
      stopSyncEngine();
    };
  }, []);

  return status;
}

export function useOfflineOrganization(orgId: string | undefined) {
  const queryClient = useQueryClient();

  const { data: onlineData, ...onlineQuery } = useQuery({
    queryKey: ['organization', orgId],
    queryFn: () => trpcClient.organization.get.query({ id: orgId! }),
    enabled: !!orgId && navigator.onLine,
    staleTime: 30_000,
  });

  const { data: cachedData } = useQuery({
    queryKey: ['offline-organization', orgId],
    queryFn: async () => {
      if (!orgId) return null;
      await initDocument(orgId);
      const doc = await getDocument<OrganizationCRDT>(orgId);
      return doc?.data ?? null;
    },
    enabled: !!orgId,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (onlineData && orgId) {
      persistDocument('organization', orgId, onlineData as unknown as OrganizationCRDT)
        .then(() => queryClient.invalidateQueries({ queryKey: ['offline-organization', orgId] }))
        .catch(() => {});
    }
  }, [onlineData, orgId, queryClient]);

  const data = navigator.onLine ? onlineData : cachedData;

  return { data, isLoading: onlineQuery.isLoading, isOffline: !navigator.onLine };
}

export function useOfflineOrganizationList() {
  const { data: onlineData, ...onlineQuery } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => trpcClient.organization.list.query({}),
    enabled: navigator.onLine,
    staleTime: 60_000,
  });

  const { data: cachedList } = useQuery({
    queryKey: ['offline-organizations-list'],
    queryFn: () => queryDocuments<OrganizationCRDT>('organization'),
    staleTime: Infinity,
  });

  const data = navigator.onLine ? onlineData : cachedList?.map((d) => d.data);

  return { data, isLoading: onlineQuery.isLoading, isOffline: !navigator.onLine };
}

export interface OfflineMutationOptions<TInput, TOutput> {
  mutationFn: (input: TInput) => Promise<TOutput>;
  offlineTransform?: (input: TInput) => OrganizationCRDT | MaintainerCRDT | PendingTransactionCRDT;
  docType: 'organization' | 'maintainer' | 'transaction' | 'draft';
  docIdKey: keyof TInput & string;
  invalidateQueries?: string[][];
}

export function useOfflineMutation<TInput extends Record<string, unknown>, TOutput = unknown>(
  opts: OfflineMutationOptions<TInput, TOutput>,
) {
  const queryClient = useQueryClient();
  const isOnline = useRef(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => { isOnline.current = true; };
    const handleOffline = () => { isOnline.current = false; };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const mutation = useMutation({
    mutationFn: async (input: TInput) => {
      if (!navigator.onLine) {
        throw new Error('OFFLINE');
      }
      return opts.mutationFn(input);
    },
    onError: async (err, input) => {
      if (err.message === 'OFFLINE' && opts.offlineTransform) {
        const docId = String(input[opts.docIdKey]);
        const data = opts.offlineTransform(input);
        await persistDocument(opts.docType, docId, data);

        for (const key of opts.invalidateQueries ?? []) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }
    },
    onSuccess: async (result, input) => {
      const docId = String(input[opts.docIdKey]);
      if (opts.offlineTransform) {
        await persistDocument(opts.docType, docId, opts.offlineTransform(input));
      }
      for (const key of opts.invalidateQueries ?? []) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });

  return mutation;
}

export function usePendingTransactions() {
  return useQuery({
    queryKey: ['offline-pending-transactions'],
    queryFn: () => queryDocuments<PendingTransactionCRDT>('transaction'),
    staleTime: Infinity,
  });
}

export function useFlushPending() {
  const [isFlushing, setIsFlushing] = useState(false);

  const flush = useCallback(async () => {
    setIsFlushing(true);
    try {
      await syncNow();
    } finally {
      setIsFlushing(false);
    }
  }, []);

  return { flush, isFlushing };
}

/**
 * useCRDTDraft
 * ─────────────────────────────────────────────────────────────────────────────
 * A CRDT-backed draft hook for form state that needs to survive offline use and
 * merge correctly when the same form is edited concurrently across multiple
 * browser tabs or devices.
 *
 * Architecture:
 *  • The Yjs document lives inside the dedicated Web Worker (crdt-worker.ts).
 *  • Each field write is a tiny incremental Y.Map update — not a full snapshot.
 *  • Local changes are persisted to IndexedDB via crdtManager immediately.
 *  • Cross-tab updates arrive via the BroadcastChannel inside the Worker and
 *    are forwarded to this hook through the `onUpdate` listener.
 *  • When the browser comes back online the sync engine pushes the pending
 *    updates to the backend automatically.
 *
 * @param draftKey - Stable identifier for this draft (e.g. "register-org" or
 *                   "allocate-payout-<orgId>"). Used as the Yjs document ID.
 *
 * @example
 * ```tsx
 * const { fields, setField, isSynced, clearDraft } = useCRDTDraft('register-org');
 * <input value={fields.name ?? ''} onChange={e => setField('name', e.target.value)} />
 * ```
 */
export function useCRDTDraft<TFields extends Record<string, unknown> = Record<string, unknown>>(
  draftKey: string,
) {
  const [fields, setFields] = useState<Partial<TFields>>({});
  const [isReady, setIsReady] = useState(false);
  const docId = `draft:${draftKey}`;

  // ── Initialise: load persisted state from IndexedDB into the Worker ───────
  useEffect(() => {
    let cancelled = false;

    async function init() {
      await initDocument(docId);
      if (cancelled) return;

      // Seed React state from what the Worker reconstructed off of IndexedDB.
      try {
        const { data } = await getDocumentState<TFields>(docId);
        if (!cancelled) {
          setFields((data as Partial<TFields>) ?? {});
          setIsReady(true);
        }
      } catch {
        if (!cancelled) setIsReady(true);
      }
    }

    init().catch(console.error);
    return () => { cancelled = true; };
  }, [docId]);

  // ── Subscribe to Worker update events (local + cross-tab BroadcastChannel) ─
  useEffect(() => {
    if (!isReady) return;

    const unsub = onUpdate(docId, (event: WorkerUpdateEvent) => {
      if (event.data && typeof event.data === 'object') {
        setFields(event.data as Partial<TFields>);
      }
    });

    return unsub;
  }, [docId, isReady]);

  // ── setField: write a single field through the Worker ─────────────────────
  const setField = useCallback(
    async (fieldName: keyof TFields & string, value: TFields[keyof TFields]) => {
      // Optimistic update — keep the UI snappy.
      setFields((prev) => ({ ...prev, [fieldName]: value }));

      try {
        const { data, state } = await setDocumentField(docId, fieldName, value);

        // Persist the Yjs state snapshot + draft data to IndexedDB.
        await persistDocument<DraftCRDT>(
          'draft',
          docId,
          { draftKey, fields: data as Record<string, unknown>, savedAt: Date.now() },
          state,
        );

        // Reflect any CRDT-merged result (may differ from optimistic value
        // in case of concurrent edits from another tab).
        if (data && typeof data === 'object') {
          setFields(data as Partial<TFields>);
        }
      } catch (err) {
        console.error('[useCRDTDraft] setField error:', err);
      }
    },
    [docId, draftKey],
  );

  // ── clearDraft: delete the doc from IndexedDB and reset Worker state ───────
  const clearDraft = useCallback(async () => {
    setFields({});
    try {
      await deleteDocument(docId);
    } catch {
      // Ignore — the UI is already cleared.
    }
  }, [docId]);

  // ── isSynced: true when there are no pending unsynced updates ─────────────
  const [isSynced, setIsSynced] = useState(true);

  useEffect(() => {
    let alive = true;

    async function check() {
      const count = await db.crdtUpdates
        .where({ docId, synced: 0 })
        .count()
        .catch(() => 0);
      if (alive) setIsSynced(count === 0);
    }

    check().catch(() => {});
    const interval = setInterval(check, 5_000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [docId]);

  return {
    /** Current field values, merged from all CRDT sources. */
    fields,
    /** Write a single field. Triggers a Yjs delta and IndexedDB persist. */
    setField,
    /** Delete the draft from IndexedDB and reset the Worker state. */
    clearDraft,
    /** True once the initial IndexedDB state has been loaded into the Worker. */
    isReady,
    /** True when all local changes have been pushed to the backend. */
    isSynced,
  };
}
