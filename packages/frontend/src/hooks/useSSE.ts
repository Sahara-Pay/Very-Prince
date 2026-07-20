/**
 * @file useSSE.ts
 * @description Server-Sent Events hook for real-time UI updates.
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export interface SSEEvent {
  type: string;
  data: any;
  timestamp: number;
}

export function useSSE(url?: string) {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const SSE_URL = url || `${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/events/stream`;
    
    const connect = () => {
      try {
        eventSourceRef.current = new EventSource(SSE_URL);

        eventSourceRef.current.onopen = () => {
          console.log('SSE connection established');
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
        };

        eventSourceRef.current.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('SSE event received:', data);

            // Handle different event types
            if (event.type === 'payout_claimed') {
              // Invalidate relevant React Query caches
              queryClient.invalidateQueries({ queryKey: ['payouts'] });
              queryClient.invalidateQueries({ queryKey: ['balance'] });
              console.log('Invalidated payout-related caches');
            }

            if (event.type === 'funds_deposited') {
              // Invalidate organization and budget caches
              queryClient.invalidateQueries({ queryKey: ['organizations'] });
              queryClient.invalidateQueries({ queryKey: ['organization'] });
              queryClient.invalidateQueries({ queryKey: ['funding-history'] });
              queryClient.invalidateQueries({ queryKey: ['budget'] });
              console.log('Invalidated fund-related caches');
            }

            if (event.type === 'blockchain_event') {
              // Invalidate all caches for any blockchain event
              queryClient.invalidateQueries();
              console.log('Invalidated all caches due to blockchain event');
            }

          } catch (error) {
            console.error('Error parsing SSE event:', error);
          }
        };

        eventSourceRef.current.onerror = (error) => {
          console.error('SSE connection error:', error);
          
          // Attempt to reconnect after 5 seconds
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
          }
          
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('Attempting to reconnect SSE...');
            connect();
          }, 5000);
        };

      } catch (error) {
        console.error('Error creating SSE connection:', error);
      }
    };

    connect();

    // Cleanup function
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [queryClient, url]);

  return {
    isConnected: typeof window !== 'undefined' && typeof EventSource !== 'undefined' && eventSourceRef.current?.readyState === EventSource.OPEN,
  };
}

/**
 * Hook that combines SSE with React Query for automatic cache invalidation.
 */
export function useSSEWithSWR(sseUrl?: string) {
  return useSSE(sseUrl);
}
