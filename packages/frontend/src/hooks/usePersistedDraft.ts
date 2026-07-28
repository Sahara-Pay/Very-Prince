/**
 * @file usePersistedDraft.ts
 * @description Persists an in-progress transaction draft (e.g. a built/signed
 * XDR and its form state) to localStorage, keyed per action, so it survives
 * a page reload or accidental navigation before the user submits.
 *
 * Entries older than `ttlMs` are treated as stale and purged rather than
 * resurrected — an unsigned transaction from an hour ago is more likely
 * invalid (sequence number drift, expired ledger bounds) than still usable.
 */

import { useCallback, useEffect, useState } from "react";

const STORAGE_PREFIX = "very-prince:draft:";

interface StoredDraft<T> {
  data: T;
  savedAt: number;
}

export function usePersistedDraft<T>(key: string, ttlMs: number = 10 * 60 * 1000) {
  const storageKey = `${STORAGE_PREFIX}${key}`;
  const [draft, setDraftState] = useState<T | null>(null);

  // Load and validate on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;

      const parsed: StoredDraft<T> = JSON.parse(raw);
      const isExpired = Date.now() - parsed.savedAt > ttlMs;

      if (isExpired) {
        window.localStorage.removeItem(storageKey);
        return;
      }

      setDraftState(parsed.data);
    } catch {
      // Corrupted entry — purge rather than risk resurrecting bad data.
      window.localStorage.removeItem(storageKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const saveDraft = useCallback(
    (data: T) => {
      setDraftState(data);
      try {
        const entry: StoredDraft<T> = { data, savedAt: Date.now() };
        window.localStorage.setItem(storageKey, JSON.stringify(entry));
      } catch {
        // localStorage full or unavailable — draft still works in-memory
        // for this session, just won't survive a reload.
      }
    },
    [storageKey]
  );

  const clearDraft = useCallback(() => {
    setDraftState(null);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }, [storageKey]);

  return { draft, saveDraft, clearDraft };
}/**
 * @file usePersistedDraft.ts
 * @description Persists an in-progress transaction draft (e.g. a built/signed
 * XDR and its form state) to localStorage, keyed per action, so it survives
 * a page reload or accidental navigation before the user submits.
 *
 * Entries older than `ttlMs` are treated as stale and purged rather than
 * resurrected — an unsigned transaction from an hour ago is more likely
 * invalid (sequence number drift, expired ledger bounds) than still usable.
 */

import { useCallback, useEffect, useState } from "react";

const STORAGE_PREFIX = "very-prince:draft:";

interface StoredDraft<T> {
  data: T;
  savedAt: number;
}

export function usePersistedDraft<T>(key: string, ttlMs: number = 10 * 60 * 1000) {
  const storageKey = `${STORAGE_PREFIX}${key}`;
  const [draft, setDraftState] = useState<T | null>(null);

  // Load and validate on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;

      const parsed: StoredDraft<T> = JSON.parse(raw);
      const isExpired = Date.now() - parsed.savedAt > ttlMs;

      if (isExpired) {
        window.localStorage.removeItem(storageKey);
        return;
      }

      setDraftState(parsed.data);
    } catch {
      // Corrupted entry — purge rather than risk resurrecting bad data.
      window.localStorage.removeItem(storageKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const saveDraft = useCallback(
    (data: T) => {
      setDraftState(data);
      try {
        const entry: StoredDraft<T> = { data, savedAt: Date.now() };
        window.localStorage.setItem(storageKey, JSON.stringify(entry));
      } catch {
        // localStorage full or unavailable — draft still works in-memory
        // for this session, just won't survive a reload.
      }
    },
    [storageKey]
  );

  const clearDraft = useCallback(() => {
    setDraftState(null);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
  }, [storageKey]);

  return { draft, saveDraft, clearDraft };
}