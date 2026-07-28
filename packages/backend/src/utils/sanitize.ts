/**
 * @file sanitize.ts
 * @description HTML sanitization helpers backed by DOMPurify.
 *
 * Organization metadata (name/description) is user-supplied and gets pinned
 * to IPFS, then later rendered by clients. Since IPFS content is immutable
 * and publicly fetchable, any script tags left in at upload time would be
 * permanently stored and could execute in any renderer that trusts the
 * pinned JSON — sanitize before it ever reaches IPFS.
 */

import DOMPurify from "isomorphic-dompurify";

/**
 * Strips all markup, keeping only plain text. Organization descriptions are
 * rendered as plain text today, so no tags are allowed through.
 */
export function sanitizeText(input: string): string {
  return DOMPurify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }).trim();
}
