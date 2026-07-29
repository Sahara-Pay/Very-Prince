// React hook for OPFS-based historical data storage with delta sync
import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  getOPFSClient, 
  syncWithDelta, 
  toCandlestickData, 
  fromCandlestickData,
  StorageQuota 
} from '@/lib/opfsStorage';

interface UseOPFSStorageOptions {
  enabled?: boolean;
  staleTime?: number; // Time in ms before data is considered stale
  refetchInterval?: number; // Interval in ms to refetch data
}

interface UseOPFSStorageResult<T> {
  data: T[] | null;
  isLoading: boolean;
  error: Error | null;
  fromCache: boolean;
  hasNewData: boolean;
  quota: StorageQuota | null;
  refetch: () => Promise<void>;
  clearCache: () => Promise<void>;
}

export function useOPFSStorage<T>(
  key: string,
  fetchFn: (fromTimestamp?: number) => Promise<T[]>,
  options: UseOPFSStorageOptions = {}
): UseOPFSStorageResult<T> {
  const {
    enabled = true,
    staleTime = 5 * 60 * 1000, // 5 minutes default
    refetchInterval,
  } = options;

  const [data, setData] = useState<T[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [hasNewData, setHasNewData] = useState(false);
  const [quota, setQuota] = useState<StorageQuota | null>(null);
  
  const lastFetchTime = useRef<number>(0);
  const abortController = useRef<AbortController | null>(null);

  const clearCache = useCallback(async () => {
    try {
      const client = getOPFSClient();
      await client.delete(key);
      setData(null);
      setFromCache(false);
      setHasNewData(false);
    } catch (err) {
      console.error('Failed to clear cache:', err);
    }
  }, [key]);

  const fetchData = useCallback(async (forceRefetch = false) => {
    if (!enabled) return;
    
    // Cancel any ongoing request
    if (abortController.current) {
      abortController.current.abort();
    }
    
    abortController.current = new AbortController();
    const signal = abortController.current.signal;

    // Check if data is still fresh
    const now = Date.now();
    if (!forceRefetch && data && lastFetchTime.current && (now - lastFetchTime.current) < staleTime) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const client = getOPFSClient();
      
      // Get quota info
      try {
        const quotaInfo = await client.getQuota();
        setQuota(quotaInfo);
      } catch (e) {
        // Quota check failed, but continue with fetch
        console.warn('Failed to get quota:', e);
      }

      // Perform delta sync
      const result = await syncWithDelta(key, async (fromTimestamp) => {
        if (signal.aborted) throw new Error('Request aborted');
        
        const rawData = await fetchFn(fromTimestamp);
        return toCandlestickData(rawData as any[]);
      });

      if (signal.aborted) return;

      // Convert back to original format
      const convertedData = fromCandlestickData(result.data) as T[];
      
      setData(convertedData);
      setFromCache(result.fromCache);
      setHasNewData(result.hasNewData);
      lastFetchTime.current = now;
    } catch (err) {
      if (signal.aborted) return;
      
      const error = err instanceof Error ? err : new Error('Failed to fetch data');
      setError(error);
      
      // If OPFS fails, fallback to direct fetch
      try {
        const fallbackData = await fetchFn();
        setData(fallbackData);
        setFromCache(false);
        setHasNewData(false);
        lastFetchTime.current = now;
      } catch (fallbackErr) {
        setError(fallbackErr instanceof Error ? fallbackErr : new Error('Fallback fetch failed'));
      }
    } finally {
      setIsLoading(false);
    }
  }, [key, fetchFn, enabled, staleTime, data]);

  const refetch = useCallback(() => {
    return fetchData(true);
  }, [fetchData]);

  // Initial fetch
  useEffect(() => {
    fetchData();
    
    return () => {
      if (abortController.current) {
        abortController.current.abort();
      }
    };
  }, [fetchData]);

  // Refetch interval
  useEffect(() => {
    if (!refetchInterval) return;

    const interval = setInterval(() => {
      fetchData(true);
    }, refetchInterval);

    return () => clearInterval(interval);
  }, [fetchData, refetchInterval]);

  return {
    data,
    isLoading,
    error,
    fromCache,
    hasNewData,
    quota,
    refetch,
    clearCache,
  };
}

// Specialized hook for funding history data
export function useFundingHistoryOPFS(
  orgId: string,
  fetchFn: (fromTimestamp?: number) => Promise<any[]>,
  options?: UseOPFSStorageOptions
) {
  const key = `funding-history-${orgId}`;
  
  return useOPFSStorage(key, fetchFn, {
    ...options,
    staleTime: options?.staleTime || 5 * 60 * 1000, // 5 minutes default for funding history
  });
}
