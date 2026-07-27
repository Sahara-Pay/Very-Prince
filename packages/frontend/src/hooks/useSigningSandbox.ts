/**
 * @file useSigningSandbox.ts
 * @description React hook that exposes the WASM crypto-signing sandbox to UI components.
 *
 * The hook manages the lifecycle of the SigningWorkerManager, initialises it
 * lazily on first use, and provides a `sign` callback that is safe to call
 * from event handlers without blocking the React render cycle.
 *
 * SECURITY NOTES:
 *  - The hook never stores a private key in React state.
 *  - The `sign` function accepts the secret key as a transient argument;
 *    the caller is responsible for keeping it out of state/refs.
 *  - All actual cryptography runs inside the worker (off the main thread).
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { SigningWorkerManager, uint8ArrayToHex } from '@/crypto/signingWorkerManager';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SigningSandboxState {
  /** True once the worker has been initialised and is ready to sign. */
  isReady: boolean;
  /** True while a signing operation is in progress. */
  isSigning: boolean;
  /** Last error from the signing sandbox, if any. */
  error: string | null;
}

export interface SigningSandboxActions {
  /**
   * Sign `message` with an Ed25519 secret key inside the isolated worker.
   *
   * @param message      - Raw bytes to sign.
   * @param secretKeyHex - 64-byte Ed25519 secret key, hex-encoded.
   * @returns            The 64-byte signature as a Uint8Array.
   */
  sign: (message: Uint8Array, secretKeyHex: string) => Promise<Uint8Array>;

  /**
   * Convenience overload: accept a raw Uint8Array for the secret key and
   * encode it to hex before passing it to the worker so no key bytes remain
   * in main-thread typed-array objects after this call returns.
   */
  signWithKey: (message: Uint8Array, secretKey: Uint8Array) => Promise<Uint8Array>;
}

export type UseSigningSandboxResult = SigningSandboxState & SigningSandboxActions;

/** Interface for manager objects the hook depends on — used for injection in tests. */
export interface ISigningWorkerManager {
  init(): Promise<void>;
  sign(message: Uint8Array, secretKeyHex: string): Promise<Uint8Array>;
  destroy(): void;
}

/** Factory type for creating a manager instance. */
export type ManagerFactory = () => ISigningWorkerManager;

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Provides an isolated, off-main-thread Ed25519 signing sandbox.
 *
 * @param createManager - Optional factory for creating the worker manager.
 *   Defaults to `() => new SigningWorkerManager()`. Pass a custom factory
 *   in tests to inject a mock without wrestling with module mocking.
 */
export function useSigningSandbox(
  createManager: ManagerFactory = () => new SigningWorkerManager(),
): UseSigningSandboxResult {
  const managerRef = useRef<ISigningWorkerManager | null>(null);

  const [state, setState] = useState<SigningSandboxState>({
    isReady: false,
    isSigning: false,
    error: null,
  });

  // ── Initialise worker ──────────────────────────────────────────────────────

  useEffect(() => {
    // Only run in the browser; Next.js SSR has no Worker API.
    if (typeof window === 'undefined') return;

    const manager = createManager();
    managerRef.current = manager;

    manager
      .init()
      .then(() => {
        setState((prev) => ({ ...prev, isReady: true, error: null }));
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, isReady: false, error: message }));
      });

    return () => {
      manager.destroy();
      managerRef.current = null;
    };
    // createManager is intentionally excluded — it's a factory, not a reactive dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sign (hex key) ─────────────────────────────────────────────────────────

  const sign = useCallback(
    async (message: Uint8Array, secretKeyHex: string): Promise<Uint8Array> => {
      const manager = managerRef.current;
      if (!manager) {
        throw new Error('Signing sandbox is not initialised.');
      }

      setState((prev) => ({ ...prev, isSigning: true, error: null }));

      try {
        return await manager.sign(message, secretKeyHex);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, error: errorMessage }));
        throw err;
      } finally {
        setState((prev) => ({ ...prev, isSigning: false }));
      }
    },
    [],
  );

  // ── Sign (Uint8Array key — convenience) ────────────────────────────────────

  const signWithKey = useCallback(
    async (message: Uint8Array, secretKey: Uint8Array): Promise<Uint8Array> => {
      const hexKey = uint8ArrayToHex(secretKey);
      return sign(message, hexKey);
    },
    [sign],
  );

  return {
    ...state,
    sign,
    signWithKey,
  };
}
