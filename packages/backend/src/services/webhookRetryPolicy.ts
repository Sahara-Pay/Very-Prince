const MAX_SQS_VISIBILITY_TIMEOUT_SECONDS = 43_200;

export interface WebhookRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface WebhookRetryDecision {
  retryable: boolean;
  delayMs?: number;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - nowMs);
}

/** Calculates capped exponential backoff without blocking the event loop. */
export function calculateBackoffMs(
  attempt: number,
  policy: WebhookRetryPolicy,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * (2 ** Math.min(safeAttempt - 1, 30)),
  );
  const jitter = exponential * policy.jitterRatio * Math.max(0, Math.min(1, random()));
  const calculated = Math.round(exponential + jitter);
  return Math.min(policy.maxDelayMs, Math.max(calculated, retryAfterMs ?? 0));
}

export function toSqsVisibilityTimeoutSeconds(delayMs: number): number {
  return Math.min(
    MAX_SQS_VISIBILITY_TIMEOUT_SECONDS,
    Math.max(1, Math.ceil(delayMs / 1_000)),
  );
}
