'use client';

import { useEffect, useRef, useState } from 'react';
import { trpcClient } from '../trpc/client';

export function useEventSubscription<T = unknown>(path: string, input?: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const unsubscribeRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;

    const setup = async () => {
      try {
        setIsConnected(false);

        const pathParts = path.split('.');
        let current: any = trpcClient;
        for (const part of pathParts) {
          current = current[part];
        }

        const observable = await current(input);

        const sub = observable.subscribe({
          next: (nextData: T) => {
            if (!cancelled) {
              setData(nextData);
              setError(null);
              setIsConnected(true);
            }
          },
          error: (err: Error) => {
            if (!cancelled) {
              setError(err);
              setIsConnected(false);
            }
          },
          complete: () => {
            if (!cancelled) {
              setIsConnected(false);
            }
          },
        });

        unsubscribeRef.current = () => sub.unsubscribe();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsConnected(false);
        }
      }
    };

    setup();

    return () => {
      cancelled = true;
      unsubscribeRef.current();
    };
  }, [path, input]);

  return { data, error, isConnected };
}
