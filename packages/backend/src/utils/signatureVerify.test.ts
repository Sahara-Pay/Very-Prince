import { describe, it, expect } from "vitest";
import { calculateSignature, verifySignature } from "./signatureVerify.js";

describe("signatureVerify", () => {
  const secret = "test-secret-32-bytes-long-enough!!";
  const payload = JSON.stringify({ event: "test", data: { ok: true } });
  const timestamp = new Date().toISOString();

  it("accepts a valid signature", () => {
    const signature = calculateSignature(payload, secret);
    const result = verifySignature({ payload, signature, timestamp, secret });
    expect(result.valid).toBe(true);
  });

  it("rejects a bad signature", () => {
    const result = verifySignature({
      payload,
      signature: "deadbeef",
      timestamp,
      secret,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  it("rejects an expired timestamp", () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const signature = calculateSignature(payload, secret);
    const result = verifySignature({
      payload,
      signature,
      timestamp: old,
      secret,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("timestamp_expired");
    }
  });

  it("rejects missing signature", () => {
    const result = verifySignature({
      payload,
      signature: undefined,
      timestamp,
      secret,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("missing_signature");
    }
  });

  it("rejects missing timestamp", () => {
    const result = verifySignature({
      payload,
      signature: "abc",
      timestamp: undefined,
      secret,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("missing_timestamp");
    }
  });

  it("rejects invalid timestamp format", () => {
    const signature = calculateSignature(payload, secret);
    const result = verifySignature({
      payload,
      signature,
      timestamp: "not-a-date",
      secret,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid_timestamp");
    }
  });
});
