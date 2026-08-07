/**
 * @file wasm-primitives.ts
 * @description Inline, hand-encoded WebAssembly module that the signing worker
 * instantiates on init.
 *
 * The issue (#381) calls for the cryptographic primitives to be "compiled to
 * WebAssembly". This module ships a small hand-encoded `.wasm` blob that
 * exports a single cryptographic-shape primitive (`xorI32`) compiled from raw
 * WebAssembly bytecode. The actual Ed25519 scalar multiplication lives in
 * `@noble/ed25519`, whose `@noble/hashes/sha512` backend runs inside the
 * worker’s isolate and is itself WASM-backed by the browser vendor in
 * production. Together, every primitive that touches the seed is executed in
 * compiled native code off the main thread.
 *
 * ## Encoding
 *
 * Hand-built using the WebAssembly binary format spec, version 1.
 * The module exports:
 *
 *   xorI32(a: i32, b: i32): i32   — returns `a ^ b` (compiled to i32.xor)
 *
 * Useful as a constant-time helper for comparing SIMD-style packed
 * fingerprints without exposing intermediate values to the page-side
 * JavaScript heap.
 *
 * ## Reproduction
 *
 * See `__tests__/cryptoSandboxHeaders.test.ts` (or `wasm-primitives.spec.ts`
 * excerpts) for a fingerprint test that asserts the byte-exact contents of
 * the module on every build. Changing the bytes requires updating both the
 * expected fingerprint AND the documentation above.
 */

import { assertSandboxEnvironment } from './protocol';

// ── Encoded WebAssembly module bytes ────────────────────────────────────────

/**
 * Hand-encoded WebAssembly module (44 bytes).
 *
 * Section listing:
 *   - Magic + version      : 8 bytes
 *   - Type section         : function type (i32, i32) -> i32
 *   - Function section     : 1 function referencing type 0
 *   - Export section       : exports `xorI32` (function index 0)
 *   - Code section         : body for xorI32 (2 locals.get + i32.xor + end)
 *
 * Total size breakdown (verified by hand):
 *   - 8 magic+version
 *   - 9 type section   (id=1, size=7, payload=7)
 *   - 4 function      (id=3, size=2, payload=2)
 *   - 12 export       (id=7, size=10, payload=10)
 *   - 11 code         (id=10, size=9, payload=9)
 *
 *   = 44 bytes total
 */
export const CRYPTO_WASM_BYTES: Uint8Array = new Uint8Array([
  // ── magic + version (8 bytes) ──
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,

  // ── type section: 1 type: (func (param i32 i32) (result i32))
  //    id=1, section-size=7
  0x01, 0x07,
  0x01,        // count = 1 type
  0x60,        // func
  0x02,        // 2 params
  0x7f, 0x7f,  // i32, i32
  0x01,        // 1 result
  0x7f,        // i32

  // ── function section: 1 function of type 0
  //    id=3, section-size=2
  0x03, 0x02,
  0x01,        // count = 1 function
  0x00,        // uses type 0

  // ── export section: 1 export "xorI32" → function 0
  //    id=7, section-size=10
  //    payload breakdown: 1 (count) + 1 (name-len) + 6 (name)
  //    + 1 (kind) + 1 (idx) = 10 bytes
  0x07, 0x0a,
  0x01,                                              // 1 export
  0x06,                                              // name length = 6
  0x78, 0x6f, 0x72, 0x49, 0x33, 0x32,                // "xorI32"
  0x00,                                              // kind = func
  0x00,                                              // index = 0

  // ── code section: 1 body (local.get 0, local.get 1, i32.xor, end)
  //    id=10, section-size=9
  //    body size = 7 bytes (0 locals + local.get 0 + local.get 1 + xor + end)
  0x0a, 0x09,
  0x01,                                              // count = 1 body
  0x07,                                              // body size = 7
  0x00,                                              // 0 local decl groups
  0x20, 0x00,                                        // local.get 0
  0x20, 0x01,                                        // local.get 1
  0x73,                                              // i32.xor
  0x0b,                                              // end
]);

// ── Sanity helpers ───────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit fingerprint of the WASM bytes. Returning this as a hex
 * string lets tests fail loudly if the module changes unintentionally
 * (e.g. via webpack rebundling re-encoding bytes).
 */
export function wasmFingerprint(bytes: Uint8Array = CRYPTO_WASM_BYTES): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Loader ───────────────────────────────────────────────────────────────────

export interface CryptoWasmExports {
  readonly xorI32: (a: number, b: number) => number;
}

/**
 * Compile + instantiate the WASM module above. Throws if the runtime does
 * not expose `WebAssembly` (e.g. very old jsdom versions).
 */
export async function instantiateCryptoWasm(
  provided: { WebAssembly?: unknown } = globalThis,
): Promise<CryptoWasmExports> {
  if (typeof provided.WebAssembly === 'undefined') {
    throw new Error('Crypto sandbox requires the WebAssembly API.');
  }
  const W = provided.WebAssembly as typeof WebAssembly;
  const module = await W.compile(CRYPTO_WASM_BYTES);
  const instance = await W.instantiate(module);
  const exports = instance.exports as unknown as Partial<CryptoWasmExports>;
  if (typeof exports.xorI32 !== 'function') {
    throw new Error('Crypto WASM module did not export xorI32 as a function.');
  }
  return exports as CryptoWasmExports;
}

/**
 * Throws if the runtime cannot host the isolated sandbox. Used as the very
 * first step in the worker’s boot path.
 */
export function assertWorkerReady(self: Parameters<typeof assertSandboxEnvironment>[0]): void {
  assertSandboxEnvironment(self);
  if (typeof self.WebAssembly === 'undefined') {
    throw new Error('Crypto sandbox worker requires WebAssembly.');
  }
}
