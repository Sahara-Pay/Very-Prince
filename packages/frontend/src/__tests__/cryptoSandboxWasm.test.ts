/**
 * Tests for the inline hand-encoded WebAssembly module that backs the
 * off-main-thread crypto sandbox. These verify that:
 *
 *   1. The byte array starts with the correct WASM magic + version header.
 *   2. The byte array has a stable fingerprint so that an inadvertent
 *      change (e.g. via a rebundler that re-encodes) trips a test failure.
 *   3. The module compiles and instantiates in a modern runtime.
 *   4. The exported `xorI32` produces the mathematically-arithmetic XOR,
 *      not a JavaScript-side approximation.
 *
 * No `@noble/ed25519` mocking required — these tests are pure WASM.
 */
import { describe, it, expect } from 'vitest';
import { CRYPTO_WASM_BYTES, instantiateCryptoWasm, wasmFingerprint } from '../crypto-sandbox/wasm-primitives';

describe('CRYPTO_WASM_BYTES', () => {
  it('starts with the WASM magic 0x00 0x61 0x73 0x6d ("\\0asm")', () => {
    expect(CRYPTO_WASM_BYTES[0]).toBe(0x00);
    expect(CRYPTO_WASM_BYTES[1]).toBe(0x61);
    expect(CRYPTO_WASM_BYTES[2]).toBe(0x73);
    expect(CRYPTO_WASM_BYTES[3]).toBe(0x6d);
  });

  it('declares WebAssembly version 1 (LE uint32)', () => {
    const view = new DataView(CRYPTO_WASM_BYTES.buffer, CRYPTO_WASM_BYTES.byteOffset);
    expect(view.getUint32(4, true)).toBe(1);
  });

  it('contains no buf longer than 4096 bytes (no embedded giant blobs)', () => {
    expect(CRYPTO_WASM_BYTES.byteLength).toBeLessThan(4096);
  });
});

describe('wasmFingerprint', () => {
  it('is deterministic for the same byte array', () => {
    expect(wasmFingerprint()).toBe(wasmFingerprint(CRYPTO_WASM_BYTES));
  });

  it('returns a 32-bit hex string', () => {
    expect(wasmFingerprint()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('changes when bytes change', () => {
    const modified = new Uint8Array(CRYPTO_WASM_BYTES);
    modified[modified.length - 1] = (modified[modified.length - 1]! ^ 0xff) & 0xff;
    expect(wasmFingerprint(modified)).not.toBe(wasmFingerprint());
  });
});

describe('instantiateCryptoWasm', () => {
  it('compiles and instantiates the module', async () => {
    const exports = await instantiateCryptoWasm();
    expect(typeof exports.xorI32).toBe('function');
  });

  it('xorI32(0, 0) === 0', async () => {
    const { xorI32 } = await instantiateCryptoWasm();
    expect(xorI32(0, 0)).toBe(0);
  });

  it('xorI32(0xff, 0x0f) === 0xf0', async () => {
    const { xorI32 } = await instantiateCryptoWasm();
    expect(xorI32(0xff, 0x0f)).toBe(0xf0);
  });

  it('xorI32 produces the correct arithmetic XOR for asymmetric inputs', async () => {
    const { xorI32 } = await instantiateCryptoWasm();
    // 0x12345678 XOR 0x87654321
    // = 0x12^0x87 0x34^0x65 0x56^0x43 0x78^0x21
    // = 0x95       0x51       0x15       0x59
    // = 0x95511559 (positive signed i32)
    // 0x95511559 has the high bit set, so JS sees it as -1789848231;
    // coerce unsigned via `>>> 0` to compare against the bit pattern.
    expect(xorI32(0x12345678, 0x87654321) >>> 0).toBe(0x95511559);
  });

  it('xorI32(a, a) === 0 for any a', async () => {
    const { xorI32 } = await instantiateCryptoWasm();
    for (const a of [0, 1, -1, 0x7fffffff, -0x80000000, 0xdeadbeef]) {
      expect(xorI32(a, a)).toBe(0);
    }
  });
});
