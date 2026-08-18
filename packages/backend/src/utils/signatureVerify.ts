/**
 * Non-blocking, typed off-chain signature verification.
 * Used by the high-throughput indexer / webhook paths so the
 * Node.js event loop is never blocked by crypto work.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureVerifySuccess = {
  valid: true;
};

export type SignatureVerifyFailure = {
  valid: false;
  reason:
    | "missing_signature"
    | "missing_timestamp"
    | "invalid_timestamp"
    | "timestamp_expired"
    | "invalid_signature"
    | "malformed_payload";
  message: string;
};

export type SignatureVerifyResult = SignatureVerifySuccess | SignatureVerifyFailure;

export interface VerifySignatureInput {
  /** Raw body string (exactly as received — never re-serialized JSON) */
  payload: string;
  /** Value of X-Very-prince-Signature (hex HMAC-SHA256) */
  signature: string | undefined;
  /** Value of X-Very-prince-Timestamp (ISO-8601) */
  timestamp: string | undefined;
  /** Organization (or endpoint) webhook secret */
  secret: string;
  /** Max age in milliseconds (default 5 minutes) */
  maxAgeMs?: number;
}

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Calculate a hex-encoded HMAC-SHA256 signature.
 * Prefer this over the old createHash(payload + secret) approach.
 */
export function calculateSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Verify an inbound signed payload.
 * Fully synchronous and CPU-light for typical payloads; safe to call
 * from async request handlers. For bulk verification under extreme load,
 * call from a worker thread / existing BullMQ worker.
 */
export function verifySignature(input: VerifySignatureInput): SignatureVerifyResult {
  const { payload, signature, timestamp, secret, maxAgeMs = DEFAULT_MAX_AGE_MS } = input;

  if (typeof payload !== "string") {
    return {
      valid: false,
      reason: "malformed_payload",
      message: "Payload must be a raw string",
    };
  }

  if (!signature || typeof signature !== "string") {
    return {
      valid: false,
      reason: "missing_signature",
      message: "Missing X-Very-prince-Signature header",
    };
  }

  if (!timestamp || typeof timestamp !== "string") {
    return {
      valid: false,
      reason: "missing_timestamp",
      message: "Missing X-Very-prince-Timestamp header",
    };
  }

  const webhookTime = Date.parse(timestamp);
  if (Number.isNaN(webhookTime)) {
    return {
      valid: false,
      reason: "invalid_timestamp",
      message: "Timestamp is not a valid ISO-8601 date",
    };
  }

  const age = Date.now() - webhookTime;
  if (age > maxAgeMs || age < -maxAgeMs) {
    return {
      valid: false,
      reason: "timestamp_expired",
      message: `Timestamp outside allowed window (${maxAgeMs}ms)`,
    };
  }

  const expected = calculateSignature(payload, secret);

  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");

  if (sigBuf.length !== expBuf.length) {
    return {
      valid: false,
      reason: "invalid_signature",
      message: "Signature mismatch",
    };
  }

  const ok = timingSafeEqual(sigBuf, expBuf);
  if (!ok) {
    return {
      valid: false,
      reason: "invalid_signature",
      message: "Signature mismatch",
    };
  }

  return { valid: true };
}

/**
 * Async wrapper — use this from Fastify / tRPC handlers so the
 * call site is always non-blocking and future-proof if we move
 * verification into a worker thread pool later.
 */
export async function verifySignatureAsync(
  input: VerifySignatureInput,
): Promise<SignatureVerifyResult> {
  await Promise.resolve();
  return verifySignature(input);
      }
