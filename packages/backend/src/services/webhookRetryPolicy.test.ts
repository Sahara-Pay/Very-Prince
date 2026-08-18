import { describe, expect, it } from "vitest";
import {
  calculateBackoffMs,
  isRetryableStatus,
  parseRetryAfter,
  toSqsVisibilityTimeoutSeconds,
} from "./webhookRetryPolicy.js";

describe("webhook retry policy", () => {
  const policy = { baseDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.2 };

  it("uses capped exponential backoff with bounded jitter", () => {
    expect(calculateBackoffMs(1, policy, undefined, () => 0)).toBe(1_000);
    expect(calculateBackoffMs(3, policy, undefined, () => 0.5)).toBe(4_400);
    expect(calculateBackoffMs(20, policy, undefined, () => 1)).toBe(10_000);
  });

  it("honours Retry-After without exceeding the configured cap", () => {
    expect(calculateBackoffMs(1, policy, 8_000, () => 0)).toBe(8_000);
    expect(calculateBackoffMs(1, policy, 20_000, () => 0)).toBe(10_000);
    expect(parseRetryAfter("3", 0)).toBe(3_000);
    expect(parseRetryAfter("not-a-date", 0)).toBeUndefined();
  });

  it("only retries transient HTTP responses", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it("converts delays to valid SQS visibility timeouts", () => {
    expect(toSqsVisibilityTimeoutSeconds(1)).toBe(1);
    expect(toSqsVisibilityTimeoutSeconds(1_001)).toBe(2);
    expect(toSqsVisibilityTimeoutSeconds(Number.MAX_SAFE_INTEGER)).toBe(43_200);
  });
});
