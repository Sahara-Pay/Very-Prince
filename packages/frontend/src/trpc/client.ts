/**
 * @file client.ts
 * @description tRPC client configuration for the Very-prince frontend, with differential synchronization link.
 */

import { createTRPCProxyClient, httpLink, splitLink, wsLink, createWSClient, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { AppRouter } from '@backend/trpc/router';
import { applyPatch } from './diff.js';

// Client-side cache to hold the last known states and their hashes
const clientStateCache: Record<string, { hash: string; data: any }> = {};

/**
 * Custom tRPC link that handles differential synchronization by tracking state hashes,
 * appending the 'x-state-hash' header to requests, and applying RFC 6902 JSON patches to responses.
 */
export const diffSyncLink: TRPCLink<AppRouter> = () => {
  return ({ next, op }) => {
    return observable((observer) => {
      // Determine a unique cache key based on procedure path and input parameters
      const cacheKey = `${op.path}:${JSON.stringify(op.input)}`;
      const cached = clientStateCache[cacheKey];
      
      // If we have a last known state for this query, append the state hash header
      if (cached) {
        op.context = {
          ...op.context,
          headers: {
            ...op.context.headers,
            'x-state-hash': cached.hash,
          },
        };
      }
      
      return next(op).subscribe({
        next(value) {
          const res = value.result;
          
          if (res && res.data && typeof res.data === 'object' && 'status' in res.data) {
            const envelope = res.data as any;
            
            if (envelope.status === 'no_change') {
              if (cached) {
                // Reconstruct the response with cached data
                res.data = cached.data;
              }
            } else if (envelope.status === 'diff') {
              if (cached) {
                // Apply the patch to the old state to get the new state
                const newData = applyPatch(cached.data, envelope.patch);
                // Update client cache
                clientStateCache[cacheKey] = { hash: envelope.hash, data: newData };
                res.data = newData;
              } else {
                console.warn(`Received 'diff' status but had no cached state for ${cacheKey}.`);
              }
            } else if (envelope.status === 'full') {
              // Store the new state in cache
              clientStateCache[cacheKey] = { hash: envelope.hash, data: envelope.data };
              res.data = envelope.data;
            }
          }
          
          observer.next(value);
        },
        error(err) {
          observer.error(err);
        },
        complete() {
          observer.complete();
        },
      });
    });
  };
};

// Get the backend URL from environment variables
const getBaseUrl = () => {
  if (typeof window !== 'undefined') {
    // Browser should use relative URL
    return '';
  }
  
  // Server-side rendering should use the backend URL
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL.replace('/api/v1/contract', '');
  }
  
  // Default to localhost for development
  return 'http://localhost:3001';
};

const getWsUrl = () => {
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = process.env.NEXT_PUBLIC_WS_URL || (protocol + '//localhost:3002');
    return host;
  }
  return process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3002';
};

const wsClient = typeof window !== 'undefined'
  ? createWSClient({ url: getWsUrl() })
  : null;

// Create the tRPC client
export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: [
    diffSyncLink,
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: wsLink({ client: wsClient! }),
      false: httpLink({
        url: `${getBaseUrl()}/trpc`,
        headers: () => {
          return {};
        },
      }),
    }),
  ],
});

// Export the client for use in components
export default trpcClient;
