/**
 * @file ed25519.test.ts
 * @description Unit tests for Ed25519 cryptographic primitives.
 *
 * Uses the real tweetnacl library (available in node_modules as a transitive
 * dependency of @stellar/stellar-sdk) so tests verify actual cryptographic
 * correctness, not just mock behaviour.
 */

import { describe, it, expect } from 'vitest';
import { signMessage, verifySignature, keyPairFromSeed, secureWipe } from './ed25519';

// ─── Deterministic test seed & key pair ───────────────────────────────────────

/** A fixed 32-byte seed for reproducible test vectors. */
const SEED = new Uint8Array(32).fill(0x42);

// ─── signMessage ──────────────────────────────────────────────────────────────

describe('signMessage', () => {
  it('returns a 64-byte signature for a valid message + key', () => {
    const { secretKey } = keyPairFromSeed(SEED);
    const message = new Uint8Array([1, 2, 3]);

    const sig = signMessage(message, secretKey);

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
  });

  it('throws RangeError if secretKey is not 64 bytes', () => {
    const badKey = new Uint8Array(32); // Too short

    expect(() => signMessage(new Uint8Array([1]), badKey)).toThrowError(RangeError);
    expect(() => signMessage(new Uint8Array([1]), badKey)).toThrowError(/64 bytes/);
  });

  it('handles an empty message without throwing', () => {
    const { secretKey } = keyPairFromSeed(SEED);
    const sig = signMessage(new Uint8Array(0), secretKey);
    expect(sig.length).toBe(64);
  });

  it('produces a deterministic result for the same inputs', () => {
    const { secretKey } = keyPairFromSeed(SEED);
    const message = new Uint8Array([10, 20, 30]);

    const sig1 = signMessage(message, secretKey);
    const sig2 = signMessage(message, secretKey);

    expect(sig1).toEqual(sig2);
  });

  it('produces different signatures for different messages', () => {
    const { secretKey } = keyPairFromSeed(SEED);

    const sig1 = signMessage(new Uint8Array([1, 2, 3]), secretKey);
    const sig2 = signMessage(new Uint8Array([4, 5, 6]), secretKey);

    expect(sig1).not.toEqual(sig2);
  });
});

// ─── verifySignature ──────────────────────────────────────────────────────────

describe('verifySignature', () => {
  it('returns true for a correctly signed message', () => {
    const { publicKey, secretKey } = keyPairFromSeed(SEED);
    const message = new Uint8Array([1, 2, 3]);
    const signature = signMessage(message, secretKey);

    expect(verifySignature(message, signature, publicKey)).toBe(true);
  });

  it('returns false if the message was tampered', () => {
    const { publicKey, secretKey } = keyPairFromSeed(SEED);
    const message = new Uint8Array([1, 2, 3]);
    const signature = signMessage(message, secretKey);
    const tampered = new Uint8Array([9, 9, 9]); // different message

    expect(verifySignature(tampered, signature, publicKey)).toBe(false);
  });

  it('returns false if the signature was tampered', () => {
    const { publicKey, secretKey } = keyPairFromSeed(SEED);
    const message = new Uint8Array([1, 2, 3]);
    const signature = signMessage(message, secretKey);
    const tamperedSig = new Uint8Array(signature);
    tamperedSig[0] ^= 0xFF; // flip bits

    expect(verifySignature(message, tamperedSig, publicKey)).toBe(false);
  });

  it('returns false if publicKey has wrong length', () => {
    const message = new Uint8Array([1]);
    const signature = new Uint8Array(64);
    const badKey = new Uint8Array(16);

    expect(verifySignature(message, signature, badKey)).toBe(false);
  });

  it('returns false if signature has wrong length', () => {
    const { publicKey } = keyPairFromSeed(SEED);
    const message = new Uint8Array([1]);
    const badSig = new Uint8Array(32);

    expect(verifySignature(message, badSig, publicKey)).toBe(false);
  });
});

// ─── keyPairFromSeed ──────────────────────────────────────────────────────────

describe('keyPairFromSeed', () => {
  it('derives a key pair from a 32-byte seed', () => {
    const kp = keyPairFromSeed(SEED);

    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey.length).toBe(64);
  });

  it('derives the same key pair for the same seed', () => {
    const kp1 = keyPairFromSeed(SEED);
    const kp2 = keyPairFromSeed(SEED);

    expect(kp1.publicKey).toEqual(kp2.publicKey);
    expect(kp1.secretKey).toEqual(kp2.secretKey);
  });

  it('derives different key pairs for different seeds', () => {
    const kp1 = keyPairFromSeed(new Uint8Array(32).fill(0x01));
    const kp2 = keyPairFromSeed(new Uint8Array(32).fill(0x02));

    expect(kp1.publicKey).not.toEqual(kp2.publicKey);
  });

  it('throws RangeError if seed is not 32 bytes', () => {
    expect(() => keyPairFromSeed(new Uint8Array(16))).toThrowError(RangeError);
    expect(() => keyPairFromSeed(new Uint8Array(16))).toThrowError(/32 bytes/);
  });
});

// ─── secureWipe ───────────────────────────────────────────────────────────────

describe('secureWipe', () => {
  it('fills all bytes with zero', () => {
    const key = new Uint8Array([1, 2, 3, 4, 5]);
    secureWipe(key);
    expect(Array.from(key)).toEqual([0, 0, 0, 0, 0]);
  });

  it('handles an already-zeroed array without throwing', () => {
    const empty = new Uint8Array(8);
    expect(() => secureWipe(empty)).not.toThrow();
    expect(Array.from(empty)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('wipes a realistic 64-byte secret key', () => {
    const secretKey = new Uint8Array(64).fill(0xAB);
    secureWipe(secretKey);
    expect(secretKey.every((b) => b === 0)).toBe(true);
  });
});
