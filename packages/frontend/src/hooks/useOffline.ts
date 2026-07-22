'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { db } from '@/db/db';
import { persistDocument, getDocument, queryDocuments, deleteDocument, initDocument } from '@/db/crdtManager';
import { startSyncEngine, stopSyncEngine, onSyncStatusChange, syncNow, getSyncStatus } from '@/db/syncEngine';
import { trpcClient } from '@/trpc/client';
import type { OrganizationCRDT, MaintainerCRDT, PendingTransactionCRDT, SyncState } from '@/lib/crdtTypes';

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
