/**
 * @file ed25519.ts
 * @description Ed25519 cryptographic primitives for use inside the Web Worker.
 *
 * This module provides the signing operations that run entirely off-main-thread.
 * It uses tweetnacl (a well-audited, pure-JS library that ships as a transitive
 * dependency of @stellar/stellar-sdk) so no additional bundle is required.
 *
 * Design rules:
 *  - This file MUST only be imported from within the signing worker.
 *  - Private key bytes MUST never be transferred out of the worker.
 *  - All signing results are returned as Uint8Array or hex strings — never keys.
 */

// tweetnacl is a CommonJS module; use require() for reliable Worker compat.
// The eslint rule is not configured in this project's ESLint setup.
const nacl = require('tweetnacl') as typeof import('tweetnacl'); // eslint-disable-line

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Sign a message with an Ed25519 secret key.
 *
 * @param message    - The raw bytes to sign.
 * @param secretKey  - A 64-byte Ed25519 secret key (seed ++ public key).
 * @returns          A 64-byte Ed25519 signature.
 *
 * @throws {RangeError} if secretKey is not exactly 64 bytes.
 */
export function signMessage(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== nacl.sign.secretKeyLength) {
    throw new RangeError(
      `Ed25519 secret key must be ${nacl.sign.secretKeyLength} bytes, got ${secretKey.length}`,
    );
  }
  return nacl.sign.detached(message, secretKey);
}

/**
 * Verify an Ed25519 signature.
 *
 * @param message    - The original message bytes.
 * @param signature  - The 64-byte signature to verify.
 * @param publicKey  - The 32-byte Ed25519 public key.
 * @returns          `true` if the signature is valid, `false` otherwise.
 */
export function verifySignature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (publicKey.length !== nacl.sign.publicKeyLength) {
    return false;
  }
  if (signature.length !== nacl.sign.signatureLength) {
    return false;
  }
  return nacl.sign.detached.verify(message, signature, publicKey);
}

/**
 * Derive an Ed25519 key-pair from a 32-byte seed.
 * Only used for testing purposes — in production the secret key comes from the
 * Freighter wallet and never enters this module as a raw seed.
 *
 * @param seed - 32-byte seed value.
 * @returns    An object with `publicKey` (32 bytes) and `secretKey` (64 bytes).
 */
export function keyPairFromSeed(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  if (seed.length !== nacl.sign.seedLength) {
    throw new RangeError(
      `Seed must be ${nacl.sign.seedLength} bytes, got ${seed.length}`,
    );
  }
  return nacl.sign.keyPair.fromSeed(seed);
}

/**
 * Securely wipe a byte array to prevent secret key material lingering in
 * worker memory after use.
 *
 * @param bytes - The byte array to overwrite with zeros.
 */
export function secureWipe(bytes: Uint8Array): void {
  bytes.fill(0);
}
