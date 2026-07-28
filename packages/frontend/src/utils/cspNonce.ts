// utils/cspNonce.ts
/**
 * Generate a high‑entropy CSP nonce.
 * Returns a Base64 string without padding suitable for the `script-src` directive.
 */
export function generateNonce(): string {
  // 24 random bytes gives ~192 bits of entropy and a 32‑char Base64 string
  // Node's crypto module is available in the Edge runtime for Next.js middleware
  const { randomBytes } = require('crypto');
  const bytes = randomBytes(24);
  return bytes.toString('base64').replace(/=+$/g, '');
}
