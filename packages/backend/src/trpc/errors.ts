/**
 * Standard tRPC error helpers for the high-throughput indexer API.
 * Keeps the event loop free: mapping is sync and allocation-light.
 */

import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/rpc";

/** Client-safe message for unexpected failures (never leak internals). */
export const GENERIC_INTERNAL_MESSAGE =
  "An unexpected error occurred. Please try again later.";

const NOT_FOUND_RE = /not found|does not exist|unknown procedure/i;
const BAD_INPUT_RE = /invalid|malformed|validation|parse/i;
const TIMEOUT_RE = /timeout|timed out|deadline/i;
const RATE_RE = /rate limit|too many requests/i;

/**
 * Map any thrown value to a TRPCError without blocking.
 * Known TRPCError instances are returned as-is.
 */
export function toTRPCError(error: unknown): TRPCError {
  if (error instanceof TRPCError) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";

  let code: TRPC_ERROR_CODE_KEY = "INTERNAL_SERVER_ERROR";

  if (NOT_FOUND_RE.test(message)) {
    code = "NOT_FOUND";
  } else if (BAD_INPUT_RE.test(message)) {
    code = "BAD_REQUEST";
  } else if (TIMEOUT_RE.test(message)) {
    code = "TIMEOUT";
  } else if (RATE_RE.test(message)) {
    code = "TOO_MANY_REQUESTS";
  }

  return new TRPCError({
    code,
    message: code === "INTERNAL_SERVER_ERROR" ? GENERIC_INTERNAL_MESSAGE : message,
    cause: error instanceof Error ? error : undefined,
  });
}

/** Wire-format error object matching tRPC HTTP error shape. */
export function formatTRPCErrorShape(
  error: TRPCError,
  path?: string,
): {
  message: string;
  code: number;
  data: {
    code: TRPC_ERROR_CODE_KEY;
    httpStatus: number;
    path?: string;
  };
} {
  const httpStatus = trpcCodeToHttpStatus(error.code);

  return {
    message: error.message,
    // JSON-RPC-style numeric code (tRPC convention for BAD_REQUEST etc.)
    code: httpStatus >= 500 ? -32603 : -32600,
    data: {
      code: error.code,
      httpStatus,
      ...(path ? { path } : {}),
    },
  };
}

export function trpcCodeToHttpStatus(code: TRPC_ERROR_CODE_KEY): number {
  switch (code) {
    case "BAD_REQUEST":
    case "PARSE_ERROR":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "TIMEOUT":
      return 408;
    case "CONFLICT":
      return 409;
    case "PRECONDITION_FAILED":
      return 412;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "UNPROCESSABLE_CONTENT":
      return 422;
    case "TOO_MANY_REQUESTS":
      return 429;
    case "CLIENT_CLOSED_REQUEST":
      return 499;
    default:
      return 500;
  }
}

export function badRequest(message: string, cause?: unknown): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message, cause });
}

export function notFound(message: string, cause?: unknown): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message, cause });
}

export function internalError(cause?: unknown): TRPCError {
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: GENERIC_INTERNAL_MESSAGE,
    cause,
  });
}
