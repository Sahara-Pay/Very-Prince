/**
 * @file etag.ts
 * @description Deterministic JSON canonicalization + SHA-1 hashing used to
 * derive stable ETags for tRPC query responses.
 *
 * Object key insertion order is irrelevant to callers (they parse JSON), but
 * it flips `JSON.stringify` output byte-for-byte, which would make two
 * semantically identical responses hash to two different ETags. Sorting keys
 * before stringifying makes the hash depend only on the actual data.
 */

import { createHash } from "node:crypto";

/**
 * Recursively rebuilds plain objects with alphabetically sorted keys.
 * Arrays keep their order (order is significant there); non-plain objects
 * (e.g. class instances) are left as-is since sorting their keys would not
 * reliably round-trip through JSON.stringify anyway.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (value !== null && typeof value === "object" && value.constructor === Object) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      // eslint-disable-next-line security/detect-object-injection
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

/**
 * Serializes `value` to JSON with object keys sorted alphabetically at every
 * nesting level, so the same logical payload always produces the same bytes.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Computes a quoted, strong-validator ETag (`"<sha1-hex>"`) for a canonical
 * JSON string. SHA-1 is sufficient here — this is a change-detection
 * fingerprint, not a security boundary.
 */
export function computeEtag(canonicalPayload: string): string {
  const digest = createHash("sha1").update(canonicalPayload).digest("hex");
  return `"${digest}"`;
}

/**
 * Returns true if any ETag in a (possibly comma-separated) `If-None-Match`
 * header value matches `etag`, ignoring the weak-validator `W/` prefix.
 */
export function ifNoneMatchSatisfied(headerValue: string, etag: string): boolean {
  if (headerValue.trim() === "*") {
    return true;
  }
  return headerValue
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .includes(etag);
}
