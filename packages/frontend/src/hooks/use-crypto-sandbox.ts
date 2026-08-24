/**
 * @file use-crypto-sandbox.ts
 * @description React hook for the off-main-thread crypto-signing sandbox.
 *
 * Integrates the CryptoSandboxClient with React's lifecycle, providing
 * automatic initialization, cleanup, and error handling for App Router
 * components that need Web3 signing capabilities.
 *
 * Maintains 60FPS by ensuring all cryptographic operations run off the
 * main thread via SharedArrayBuffer + Atomics.wait.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CryptoSandboxClient,
  getCryptoSandbox,
  hasCryptoSandbox,
  type SandboxKey,
} from '@/crypto-sandbox';

export interface UseCryptoSandboxOptions {
  /** Auto-initialize the sandbox on mount. Default: true */
  autoInit?: boolean;
  /** Sign timeout in milliseconds. Default: 30000 */
  signTimeoutMs?: number;
}

export interface UseCryptoSandboxReturn {
  /** Whether the crypto sandbox is available in this browser */
  isAvailable: boolean;
  /** Whether the sandbox is currently initialized and ready */
  isReady: boolean;
  /** Whether an operation is currently in progress */
  isLoading: boolean;
  /** Any error that occurred during initialization or operations */
  error: Error | null;
  /** Initialize the sandbox (called automatically if autoInit=true) */
  initialize: () => Promise<void>;
  /** Generate a new Ed25519 keypair in the sandbox */
  createKey: () => Promise<SandboxKey>;
  /** Sign a message using the specified key handle */
  sign: (handle: number, message: Uint8Array) => Promise<Uint8Array>;
  /** Dispose of a key (releases memory in the worker) */
  disposeKey: (handle: number) => Promise<void>;
  /** Dispose of the entire sandbox */
  dispose: () => void;
}

/**
 * React hook for the off-main-thread crypto-signing sandbox.
 *
 * @example
 * ```tsx
 * function WalletSigner() {
 *   const { isAvailable, isReady, createKey, sign } = useCryptoSandbox();
 *
 *   const handleSign = async () => {
 *     const key = await createKey();
 *     const signature = await sign(key.handle, new TextEncoder().encode('hello'));
 *     console.log('Signature:', signature);
 *   };
 *
 *   if (!isAvailable) return <div>Cross-origin isolation required</div>;
 *   if (!isReady) return <div>Loading crypto sandbox...</div>;
 *
 *   return <button onClick={handleSign}>Sign Message</button>;
 * }
 * ```
 */
export function useCryptoSandbox(
  options: UseCryptoSandboxOptions = {},
): UseCryptoSandboxReturn {
  const { autoInit = true, signTimeoutMs } = options;

  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const clientRef = useRef<CryptoSandboxClient | null>(null);
  const mountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Auto-initialize on mount
  useEffect(() => {
    if (!autoInit || !hasCryptoSandbox()) return;

    let cancelled = false;

    const init = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const client = await getCryptoSandbox({ signTimeoutMs });
        if (cancelled) return;

        clientRef.current = client;
        setIsReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [autoInit, signTimeoutMs]);

  const initialize = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const client = await getCryptoSandbox({ signTimeoutMs });
      if (!mountedRef.current) return;

      clientRef.current = client;
      setIsReady(true);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [signTimeoutMs]);

  const createKey = useCallback(async (): Promise<SandboxKey> => {
    if (!clientRef.current) {
      throw new Error('Crypto sandbox not initialized. Call initialize() first.');
    }
    return clientRef.current.createKey();
  }, []);

  const sign = useCallback(
    async (handle: number, message: Uint8Array): Promise<Uint8Array> => {
      if (!clientRef.current) {
        throw new Error('Crypto sandbox not initialized. Call initialize() first.');
      }
      return clientRef.current.sign(handle, message);
    },
    [],
  );

  const disposeKey = useCallback(async (handle: number): Promise<void> => {
    if (!clientRef.current) return;
    return clientRef.current.disposeKey(handle);
  }, []);

  const dispose = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.dispose();
      clientRef.current = null;
      setIsReady(false);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clientRef.current) {
        clientRef.current.dispose();
        clientRef.current = null;
      }
    };
  }, []);

  return {
    isAvailable: hasCryptoSandbox(),
    isReady,
    isLoading,
    error,
    initialize,
    createKey,
    sign,
    disposeKey,
    dispose,
  };
}
