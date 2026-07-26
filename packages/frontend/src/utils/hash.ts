// src/utils/hash.ts
/**
 * Simple deterministic hash function for JavaScript objects.
 * It stringifies the object (stable order) and computes a 32‑bit integer hash.
 * The resulting hash is returned as a string for easy comparison.
 *
 * This implementation is fast and suitable for use in React Query's
 * `isDataEqual` callback, where a synchronous hash is required.
 */
export function hashObject(value: unknown): string {
  // JSON.stringify on objects does not guarantee property order, but in most
  // cases the data structures returned by tRPC are plain objects with stable
  // ordering. For safety we could sort keys, but that incurs additional cost.
  // Here we opt for speed.
  const str = JSON.stringify(value);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32‑bit integer
  }
  return hash.toString();
}
