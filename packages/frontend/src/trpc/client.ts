import { createTRPCProxyClient, httpBatchLink, splitLink, wsLink, createWSClient } from '@trpc/client';

const getBaseUrl = () => {
  if (typeof window !== 'undefined') {
    return '';
  }
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL.replace('/api/v1/contract', '');
  }
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

export const trpcClient = createTRPCProxyClient<any>({
  links: [
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: wsLink({ client: wsClient! }),
      false: httpBatchLink({
        url: getBaseUrl() + '/trpc',
        headers: () => ({}),
      }),
    }),
  ],
}) as any;

export default trpcClient;
