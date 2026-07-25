/**
 * @file etag.test.ts
 * @description Tests for deterministic JSON canonicalization + SHA-1 ETag
 * hashing used by the tRPC ETag caching plugin.
 */

import { describe, it, expect } from "vitest";
import { canonicalStringify, computeEtag, ifNoneMatchSatisfied } from "./etag.js";

describe("canonicalStringify", () => {
  it("produces identical output for objects with different key insertion order", () => {
    const a = { b: 2, a: 1, c: 3 };
    const b = { c: 3, a: 1, b: 2 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("sorts keys alphabetically at every nesting level", () => {
    const value = { z: 1, a: { d: 4, b: 2, c: 3 } };
    expect(canonicalStringify(value)).toBe('{"a":{"b":2,"c":3,"d":4},"z":1}');
  });

  it("preserves array element order", () => {
    const value = { list: [3, 1, 2] };
    expect(canonicalStringify(value)).toBe('{"list":[3,1,2]}');
  });

  it("sorts keys of objects nested inside arrays", () => {
    const value = [{ b: 1, a: 2 }, { d: 3, c: 4 }];
    expect(canonicalStringify(value)).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  it("handles primitives, null, and empty containers", () => {
    expect(canonicalStringify(42)).toBe("42");
    expect(canonicalStringify("hi")).toBe('"hi"');
    expect(canonicalStringify(null)).toBe("null");
    expect(canonicalStringify({})).toBe("{}");
    expect(canonicalStringify([])).toBe("[]");
  });

  it("produces different output when values differ", () => {
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify({ a: 2 }));
  });
});

describe("computeEtag", () => {
  it("is deterministic for the same canonical payload", () => {
    const payload = canonicalStringify({ orgId: "stellar", budget: "1000" });
    expect(computeEtag(payload)).toBe(computeEtag(payload));
  });

  it("produces different hashes for different payloads", () => {
    const a = computeEtag(canonicalStringify({ orgId: "stellar" }));
    const b = computeEtag(canonicalStringify({ orgId: "other" }));
    expect(a).not.toBe(b);
  });

  it("is insensitive to source key ordering (via canonicalStringify)", () => {
    const a = computeEtag(canonicalStringify({ x: 1, y: 2 }));
    const b = computeEtag(canonicalStringify({ y: 2, x: 1 }));
    expect(a).toBe(b);
  });

  it("returns a quoted 40-character hex SHA-1 digest", () => {
    const etag = computeEtag(canonicalStringify({ a: 1 }));
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
  });
});

describe("ifNoneMatchSatisfied", () => {
  it("matches an exact single ETag", () => {
    expect(ifNoneMatchSatisfied('"abc123"', '"abc123"')).toBe(true);
  });

  it("does not match a different ETag", () => {
    expect(ifNoneMatchSatisfied('"abc123"', '"def456"')).toBe(false);
  });

  it("matches one entry within a comma-separated list", () => {
    expect(ifNoneMatchSatisfied('"aaa", "bbb", "ccc"', '"bbb"')).toBe(true);
  });

  it("matches weak validators by ignoring the W/ prefix", () => {
    expect(ifNoneMatchSatisfied('W/"abc123"', '"abc123"')).toBe(true);
  });

  it("treats a bare * as matching any ETag", () => {
    expect(ifNoneMatchSatisfied("*", '"anything"')).toBe(true);
  });
});
