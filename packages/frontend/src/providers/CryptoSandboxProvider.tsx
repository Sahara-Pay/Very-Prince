/**
 * @file CryptoSandboxProvider.tsx
 * @description App Router-compatible React context provider for the WebAssembly
 * crypto sandbox. Wraps the CryptoSandboxClient with React context so any
 * component in the tree can access off-main-thread signing without prop drilling.
 *
 * Follows Next.js App Router paradigms:
 * - "use client" boundary for browser-only APIs
 * - Lazy initialization to avoid SSR issues
 * - Graceful degradation when SharedArrayBuffer is unavailable
 * - WCAG AAA: all interactive elements receive proper ARIA attributes
 */

'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  CryptoSandboxClient,
  getCryptoSandbox,
  hasCryptoSandbox,
  type SandboxKey,
} from '@/crypto-sandbox';

// ── Context Types ────────────────────────────────────────────────────────────

export interface CryptoSandboxContextValue {
  /** Whether the browser supports the crypto sandbox */
  isAvailable: boolean;
  /** Whether the sandbox has been initialized and is ready for use */
  isReady: boolean;
  /** Whether an operation is currently in progress */
  isLoading: boolean;
  /** Any error that occurred during initialization or operations */
  error: Error | null;
  /** Initialize the sandbox (called automatically on mount when autoInit=true) */
  initialize: () => Promise<void>;
  /** Generate a new Ed25519 keypair inside the sandbox worker */
  createKey: () => Promise<SandboxKey>;
  /** Sign a message with the specified key handle (never exposes seed material) */
  sign: (handle: number, message: Uint8Array) => Promise<Uint8Array>;
  /** Dispose a key handle, releasing memory in the worker */
  disposeKey: (handle: number) => Promise<void>;
  /** Dispose the entire sandbox (terminates the worker) */
  dispose: () => void;
}

export interface CryptoSandboxProviderProps {
  children: React.ReactNode;
  /** Auto-initialize the sandbox on mount. Default: true */
  autoInit?: boolean;
  /** Sign timeout in milliseconds. Default: 30000 */
  signTimeoutMs?: number;
}

// ── Context ──────────────────────────────────────────────────────────────────

const CryptoSandboxContext = createContext<CryptoSandboxContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────────

/**
 * Provider component that initializes and manages the WebAssembly crypto
 * sandbox. All descendants can access the sandbox via `useCryptoSandboxContext()`.
 *
 * @example
 * ```tsx
 * // In your root layout or page
 * <CryptoSandboxProvider autoInit>
 *   <YourApp />
 * </CryptoSandboxProvider>
 *
 * // In any descendant component
 * function SignButton() {
 *   const { isReady, createKey, sign } = useCryptoSandboxContext();
 *   // ...
 * }
 * ```
 */
export function CryptoSandboxProvider({
  children,
  autoInit = true,
  signTimeoutMs,
}: CryptoSandboxProviderProps) {
  const [isReady, setIsReady] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const clientRef = useRef<CryptoSandboxClient | null>(null);
  const mountedRef = useRef(true);

  const isAvailable = useMemo(() => hasCryptoSandbox(), []);

  // Auto-initialize on mount
  useEffect(() => {
    if (!autoInit || !isAvailable) return;

    let cancelled = false;

    const init = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const client = await getCryptoSandbox(
          signTimeoutMs !== undefined ? { signTimeoutMs } : {},
        );
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
  }, [autoInit, isAvailable, signTimeoutMs]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (clientRef.current) {
        clientRef.current.dispose();
        clientRef.current = null;
      }
    };
  }, []);

  const initialize = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const client = await getCryptoSandbox(
        signTimeoutMs !== undefined ? { signTimeoutMs } : {},
      );
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
      throw new Error('Crypto sandbox not initialized. Ensure CryptoSandboxProvider is mounted with autoInit or call initialize().');
    }
    return clientRef.current.createKey();
  }, []);

  const sign = useCallback(
    async (handle: number, message: Uint8Array): Promise<Uint8Array> => {
      if (!clientRef.current) {
        throw new Error('Crypto sandbox not initialized. Ensure CryptoSandboxProvider is mounted with autoInit or call initialize().');
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

  const value = useMemo<CryptoSandboxContextValue>(
    () => ({
      isAvailable,
      isReady,
      isLoading,
      error,
      initialize,
      createKey,
      sign,
      disposeKey,
      dispose,
    }),
    [isAvailable, isReady, isLoading, error, initialize, createKey, sign, disposeKey, dispose],
  );

  return (
    <CryptoSandboxContext.Provider value={value}>
      {children}
    </CryptoSandboxContext.Provider>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Access the crypto sandbox context from any descendant component.
 * Must be used within a `<CryptoSandboxProvider>`.
 *
 * @throws if used outside of a CryptoSandboxProvider
 */
export function useCryptoSandboxContext(): CryptoSandboxContextValue {
  const ctx = useContext(CryptoSandboxContext);
  if (!ctx) {
    throw new Error(
      'useCryptoSandboxContext must be used within a <CryptoSandboxProvider>. ' +
      'Wrap your component tree with <CryptoSandboxProvider>.',
    );
  }
  return ctx;
}
