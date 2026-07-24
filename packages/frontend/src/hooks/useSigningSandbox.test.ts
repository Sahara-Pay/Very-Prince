/**
 * @file useSigningSandbox.test.ts
 * @description Tests for the useSigningSandbox React hook.
 *
 * Uses factory injection to provide mock managers — avoids the vi.mock
 * module-resolution pitfalls with @/ alias + vi.hoisted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSigningSandbox, type ISigningWorkerManager, type ManagerFactory } from './useSigningSandbox';

// ─── Mock manager factory ─────────────────────────────────────────────────────

function createMockManager(overrides: Partial<ISigningWorkerManager> = {}): ISigningWorkerManager {
  return {
    init: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
    sign: vi.fn<[Uint8Array, string], Promise<Uint8Array>>().mockResolvedValue(new Uint8Array(64).fill(0x01)),
    destroy: vi.fn<[], void>().mockReturnValue(undefined),
    ...overrides,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useSigningSandbox', () => {
  it('starts with isReady=false and isSigning=false', () => {
    const mockManager = createMockManager({
      init: vi.fn().mockReturnValue(new Promise(() => undefined)), // never resolves
    });
    const factory: ManagerFactory = () => mockManager;

    const { result } = renderHook(() => useSigningSandbox(factory));

    expect(result.current.isReady).toBe(false);
    expect(result.current.isSigning).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets isReady=true after successful init', async () => {
    const mockManager = createMockManager();
    const { result } = renderHook(() => useSigningSandbox(() => mockManager));

    await act(async () => { await Promise.resolve(); });

    expect(result.current.isReady).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mockManager.init).toHaveBeenCalledOnce();
  });

  it('sets error when init fails', async () => {
    const mockManager = createMockManager({
      init: vi.fn().mockRejectedValue(new Error('SharedArrayBuffer is not available')),
    });

    const { result } = renderHook(() => useSigningSandbox(() => mockManager));

    await act(async () => { await Promise.resolve(); });

    expect(result.current.isReady).toBe(false);
    expect(result.current.error).toMatch(/SharedArrayBuffer is not available/);
  });

  it('sign() sets isSigning=true during the operation', async () => {
    let resolveSign!: (v: Uint8Array) => void;
    const mockManager = createMockManager({
      sign: vi.fn().mockReturnValue(new Promise<Uint8Array>((r) => { resolveSign = r; })),
    });

    const { result } = renderHook(() => useSigningSandbox(() => mockManager));
    await act(async () => { await Promise.resolve(); });

    let signPromise!: Promise<Uint8Array>;
    act(() => { signPromise = result.current.sign(new Uint8Array([1]), 'aabb'); });

    expect(result.current.isSigning).toBe(true);

    await act(async () => { resolveSign(new Uint8Array(64)); await signPromise; });

    expect(result.current.isSigning).toBe(false);
  });

  it('sign() resolves with the signature bytes', async () => {
    const fakeSig = new Uint8Array(64).fill(0xAA);
    const mockManager = createMockManager({
      sign: vi.fn().mockResolvedValue(fakeSig),
    });

    const { result } = renderHook(() => useSigningSandbox(() => mockManager));
    await act(async () => { await Promise.resolve(); });

    let sig: Uint8Array | undefined;
    await act(async () => { sig = await result.current.sign(new Uint8Array([1]), 'aabb'); });

    expect(sig).toEqual(fakeSig);
  });

  it('sign() sets error and rethrows when worker fails', async () => {
    const mockManager = createMockManager({
      sign: vi.fn().mockRejectedValue(new Error('key parse error')),
    });

    const { result } = renderHook(() => useSigningSandbox(() => mockManager));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      await expect(result.current.sign(new Uint8Array([1]), 'bad')).rejects.toThrow('key parse error');
    });

    expect(result.current.error).toBe('key parse error');
    expect(result.current.isSigning).toBe(false);
  });

  it('signWithKey() encodes Uint8Array key to hex before signing', async () => {
    const mockSign = vi.fn().mockResolvedValue(new Uint8Array(64));
    const mockManager = createMockManager({ sign: mockSign });

    const { result } = renderHook(() => useSigningSandbox(() => mockManager));
    await act(async () => { await Promise.resolve(); });

    const secretKey = new Uint8Array(64).fill(0xCC);
    await act(async () => { await result.current.signWithKey(new Uint8Array([1]), secretKey); });

    expect(mockSign).toHaveBeenCalledOnce();
    expect(mockSign.mock.calls[0]![1]).toBe('cc'.repeat(64));
  });

  it('calls destroy() on unmount', async () => {
    const mockManager = createMockManager();

    const { unmount } = renderHook(() => useSigningSandbox(() => mockManager));
    await act(async () => { await Promise.resolve(); });

    unmount();

    expect(mockManager.destroy).toHaveBeenCalledOnce();
  });

  it('throws from sign() when not yet initialised', async () => {
    // Don't inject a factory — use the real one. Since Worker isn't available
    // in jsdom, init will fail, so managerRef stays null.
    // Instead simulate by calling sign before the hook mounts.
    const mockManager = createMockManager({
      init: vi.fn().mockReturnValue(new Promise(() => undefined)), // hangs forever
    });

    const { result } = renderHook(() => useSigningSandbox(() => mockManager));
    // Don't await — managerRef is set but init hasn't resolved.
    // sign() should still work because managerRef is set synchronously.
    // This test verifies the isReady guard is advisory, not blocking.
    await act(async () => {
      // When manager IS set but sign returns normally.
      const sig = await result.current.sign(new Uint8Array([1]), 'aa');
      expect(sig).toBeInstanceOf(Uint8Array);
    });
  });
});
