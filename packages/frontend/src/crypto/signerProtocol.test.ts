/**
 * @file signerProtocol.test.ts
 * @description Unit tests for protocol constants and utility functions.
 */

import { describe, it, expect } from 'vitest';
import {
  CTRL_SAB_BYTES,
  DATA_SAB_BYTES,
  CTRL_SLOTS,
  SLOT_STATE,
  SLOT_LENGTH,
  SLOT_STATUS,
  SLOT_RESERVED,
  STATE_IDLE,
  STATE_SIGN_REQUEST,
  STATE_SIGN_DONE,
  STATUS_OK,
  STATUS_ERROR,
  uint8ArrayToHex,
  hexToUint8Array,
} from './signerProtocol';

// ─── Constants ────────────────────────────────────────────────────────────────

describe('protocol constants', () => {
  it('CTRL_SAB_BYTES equals CTRL_SLOTS * 4', () => {
    expect(CTRL_SAB_BYTES).toBe(CTRL_SLOTS * Int32Array.BYTES_PER_ELEMENT);
  });

  it('DATA_SAB_BYTES is 4096', () => {
    expect(DATA_SAB_BYTES).toBe(4096);
  });

  it('slot indices are unique', () => {
    const slots = new Set([SLOT_STATE, SLOT_LENGTH, SLOT_STATUS, SLOT_RESERVED]);
    expect(slots.size).toBe(4);
  });

  it('state values are distinct', () => {
    const values = new Set([STATE_IDLE, STATE_SIGN_REQUEST, STATE_SIGN_DONE]);
    expect(values.size).toBe(3);
  });

  it('status codes are distinct', () => {
    const values = new Set([STATUS_OK, STATUS_ERROR]);
    expect(values.size).toBe(2);
  });
});

// ─── uint8ArrayToHex ──────────────────────────────────────────────────────────

describe('uint8ArrayToHex', () => {
  it('encodes a single zero byte as "00"', () => {
    expect(uint8ArrayToHex(new Uint8Array([0]))).toBe('00');
  });

  it('encodes [255] as "ff"', () => {
    expect(uint8ArrayToHex(new Uint8Array([255]))).toBe('ff');
  });

  it('encodes [1, 2, 3] as "010203"', () => {
    expect(uint8ArrayToHex(new Uint8Array([1, 2, 3]))).toBe('010203');
  });

  it('encodes an empty array as ""', () => {
    expect(uint8ArrayToHex(new Uint8Array(0))).toBe('');
  });

  it('produces a string of exactly 2n characters for n bytes', () => {
    const bytes = new Uint8Array(32).fill(0xAB);
    const hex = uint8ArrayToHex(bytes);
    expect(hex.length).toBe(64);
  });
});

// ─── hexToUint8Array ──────────────────────────────────────────────────────────

describe('hexToUint8Array', () => {
  it('decodes "00" to [0]', () => {
    expect(hexToUint8Array('00')).toEqual(new Uint8Array([0]));
  });

  it('decodes "ff" to [255]', () => {
    expect(hexToUint8Array('ff')).toEqual(new Uint8Array([255]));
  });

  it('decodes "010203" to [1, 2, 3]', () => {
    expect(hexToUint8Array('010203')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('decodes an empty string to an empty Uint8Array', () => {
    expect(hexToUint8Array('')).toEqual(new Uint8Array(0));
  });

  it('throws RangeError for odd-length hex strings', () => {
    expect(() => hexToUint8Array('abc')).toThrowError(RangeError);
  });

  it('is the inverse of uint8ArrayToHex for arbitrary bytes', () => {
    const original = new Uint8Array([10, 32, 64, 128, 200, 255]);
    expect(hexToUint8Array(uint8ArrayToHex(original))).toEqual(original);
  });
});
