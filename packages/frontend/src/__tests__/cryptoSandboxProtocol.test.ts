/**
 * Tests for the crypto-sandbox protocol module.
 *
 * These unit-test the SAB memory layout, slot offsets, status enums, and
 * the helpers `createSigningSAB`, `createSigningViews`, and `assertSABShape`
 * defined in `src/crypto-sandbox/protocol.ts`. They are pure TypeScript and
 * do not need jsdom or a real worker.
 */
import { describe, it, expect } from 'vitest';

import {
  SAB_SIZE,
  SLOT,
  SLOT_INT32,
  MESSAGE_MAX_BYTES,
  PUBLIC_KEY_BYTES,
  PRIVATE_KEY_BYTES,
  SIGNATURE_BYTES,
  STATUS_IDLE,
  STATUS_REQUEST,
  STATUS_PROCESSING,
  STATUS_DONE,
  STATUS_ERROR,
  ERROR_NONE,
  ERROR_UNKNOWN_HANDLE,
  ERROR_INVALID_MSG_LEN,
  ERROR_SIGNING_FAILED,
  ERROR_WASM_INIT_FAILED,
  ERROR_UNSUPPORTED,
  DEFAULT_SIGN_TIMEOUT_MS,
  createSigningSAB,
  createSigningViews,
  assertSABShape,
  assertSandboxEnvironment,
} from '../crypto-sandbox/protocol';

describe('protocol slots', () => {
  it('exposes the documented SAB size', () => {
    expect(SAB_SIZE).toBe(4192);
  });

  it('places every slot at a 4-byte-aligned offset', () => {
    for (const offset of Object.values(SLOT)) {
      expect(offset % 4).toBe(0);
    }
  });

  it('keeps MESSAGE and SIGNATURE non-overlapping with the header region', () => {
    expect(SLOT.MESSAGE + MESSAGE_MAX_BYTES).toBeLessThanOrEqual(SLOT.SIGNATURE);
  });

  it('fits the signature region inside the SAB', () => {
    expect(SLOT.SIGNATURE + SIGNATURE_BYTES).toBeLessThanOrEqual(SAB_SIZE);
  });

  it('derives SLOT_INT32 indices by dividing by 4', () => {
    expect(SLOT_INT32.STATUS).toBe(SLOT.STATUS / 4);
    expect(SLOT_INT32.SEED_HANDLE).toBe(SLOT.SEED_HANDLE / 4);
    expect(SLOT_INT32.MSG_LEN).toBe(SLOT.MSG_LEN / 4);
    expect(SLOT_INT32.SIG_LEN).toBe(SLOT.SIG_LEN / 4);
  });

  it('uses well-known Ed25519 byte lengths', () => {
    expect(PUBLIC_KEY_BYTES).toBe(32);
    expect(PRIVATE_KEY_BYTES).toBe(32);
    expect(SIGNATURE_BYTES).toBe(64);
  });
});

describe('protocol status enum', () => {
  it('defines distinct status values', () => {
    const statusValues = [STATUS_IDLE, STATUS_REQUEST, STATUS_PROCESSING, STATUS_DONE, STATUS_ERROR];
    expect(new Set(statusValues).size).toBe(statusValues.length);
  });

  it('defines distinct error codes', () => {
    const errorValues = [
      ERROR_NONE,
      ERROR_UNKNOWN_HANDLE,
      ERROR_INVALID_MSG_LEN,
      ERROR_SIGNING_FAILED,
      ERROR_WASM_INIT_FAILED,
      ERROR_UNSUPPORTED,
    ];
    expect(new Set(errorValues).size).toBe(errorValues.length);
  });

  it('keeps the sign timeout sane', () => {
    expect(DEFAULT_SIGN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_SIGN_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('createSigningSAB', () => {
  it('returns a SharedArrayBuffer of the documented size', () => {
    const sab = createSigningSAB();
    expect(sab).toBeInstanceOf(SharedArrayBuffer);
    expect(sab.byteLength).toBe(SAB_SIZE);
  });

  it('initialises STATUS to IDLE', () => {
    const sab = createSigningSAB();
    const view = new Int32Array(sab);
    expect(Atomics.load(view, SLOT_INT32.STATUS)).toBe(STATUS_IDLE);
  });

  it('initialises SEED_HANDLE/MSG_LEN/SIG_LEN to zero', () => {
    const sab = createSigningSAB();
    const view = new Int32Array(sab);
    expect(Atomics.load(view, SLOT_INT32.SEED_HANDLE)).toBe(0);
    expect(Atomics.load(view, SLOT_INT32.MSG_LEN)).toBe(0);
    expect(Atomics.load(view, SLOT_INT32.SIG_LEN)).toBe(0);
  });

  it('returns a fresh buffer (no aliasing) on each call', () => {
    const a = createSigningSAB();
    const b = createSigningSAB();
    expect(a).not.toBe(b);
    // Mutating one should not affect the other.
    const va = new Int32Array(a);
    Atomics.store(va, SLOT_INT32.STATUS, STATUS_REQUEST);
    expect(Atomics.load(new Int32Array(b), SLOT_INT32.STATUS)).toBe(STATUS_IDLE);
  });
});

describe('createSigningViews', () => {
  it('returns Int32 + Uint8 views over the same memory', () => {
    const sab = createSigningSAB();
    const { int32, bytes } = createSigningViews(sab);
    expect(int32.byteLength).toBe(SAB_SIZE / 4);
    expect(bytes.byteLength).toBe(SAB_SIZE);
    // Writing through bytes shows up in int32 and vice-versa.
    const int32Bytes = new Uint8Array(int32.buffer);
    expect(int32Bytes.byteLength).toBe(SAB_SIZE);
  });
});

describe('assertSABShape', () => {
  it('accepts buffers of exactly SAB_SIZE', () => {
    expect(() => assertSABShape(createSigningSAB())).not.toThrow();
  });

  it('rejects buffers that are too small', () => {
    const bad = new SharedArrayBuffer(SAB_SIZE - 8);
    expect(() => assertSABShape(bad)).toThrow(RangeError);
  });

  it('rejects buffers that are too large', () => {
    const bad = new SharedArrayBuffer(SAB_SIZE + 8);
    expect(() => assertSABShape(bad)).toThrow(RangeError);
  });

  it('rejects plain ArrayBuffer with a TypeError', () => {
    const arr = new ArrayBuffer(SAB_SIZE);
    expect(() => assertSABShape(arr as unknown as SharedArrayBuffer)).toThrow(TypeError);
  });
});

describe('assertSandboxEnvironment', () => {
  it('is satisfied when SAB + Atomics + crossOriginIsolated are all true', () => {
    expect(() =>
      assertSandboxEnvironment({
        SharedArrayBuffer: class {} as unknown as SharedArrayBufferConstructor,
        Atomics: {},
        crossOriginIsolated: true,
      }),
    ).not.toThrow();
  });

  it('rejects when crossOriginIsolated is false (the most common deployment trap)', () => {
    expect(() =>
      assertSandboxEnvironment({
        SharedArrayBuffer: class {} as unknown as SharedArrayBufferConstructor,
        Atomics: {},
        crossOriginIsolated: false,
      }),
    ).toThrow(/crossOriginIsolated/);
  });

  it('rejects when SharedArrayBuffer is missing', () => {
    expect(() => assertSandboxEnvironment({ Atomics: {}, crossOriginIsolated: true })).toThrow(
      /SharedArrayBuffer/,
    );
  });
});
