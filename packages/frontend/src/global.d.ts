declare module '*?worker' {
  const workerConstructor: { new (): Worker };
  export default workerConstructor;
}

declare module '*.worker.ts' {
  const workerConstructor: { new (): Worker };
  export default workerConstructor;
}

interface Window {
  freighter?: {
    isConnected: () => Promise<boolean>;
    getPublicKey: () => Promise<{ address: string }>;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
    signTransaction: (xdr: string, opts?: { network: string; networkPassphrase?: string }) => Promise<string>;
    on: (event: string, callback: (...args: any[]) => void) => void;
    off?: (event: string, callback: (...args: any[]) => void) => void;
  };
}
