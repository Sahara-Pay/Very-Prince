/**
 * @file client.ts
 * @description tRPC client configuration for the Very-prince frontend.
 */

import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';

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

// Create the tRPC client
export const trpcClient = createTRPCProxyClient<any>({
  links: [
    httpBatchLink({
      url: `${getBaseUrl()}/trpc`,
      headers: () => {
        // Add any necessary headers here
        return {};
      },
    }),
  ],
}) as any;

// Export the client for use in components
export default trpcClient;
