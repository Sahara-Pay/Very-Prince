import { TRPCError } from "@trpc/server";
import {
  toTRPCError,
  formatTRPCErrorShape,
  trpcCodeToHttpStatus,
  GENERIC_INTERNAL_MESSAGE,
  badRequest,
  notFound,
} from "./errors.js";

describe("toTRPCError", () => {
  test("passes through TRPCError unchanged", () => {
    const original = badRequest("bad input");
    expect(toTRPCError(original)).toBe(original);
  });

  test("maps not-found messages", () => {
    const err = toTRPCError(new Error("Organization with ID 'x' does not exist"));
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe("NOT_FOUND");
  });

  test("maps validation-like messages to BAD_REQUEST", () => {
    const err = toTRPCError(new Error("Invalid JSON payload"));
    expect(err.code).toBe("BAD_REQUEST");
  });

  test("does not leak internal messages for unknown errors", () => {
    const err = toTRPCError(new Error("ECONNREFUSED 127.0.0.1:5432"));
    expect(err.code).toBe("INTERNAL_SERVER_ERROR");
    expect(err.message).toBe(GENERIC_INTERNAL_MESSAGE);
  });

  test("handles non-Error throws", () => {
    const err = toTRPCError("boom");
    expect(err.code).toBe("INTERNAL_SERVER_ERROR");
    expect(err.message).toBe(GENERIC_INTERNAL_MESSAGE);
  });
});

describe("formatTRPCErrorShape", () => {
  test("includes code, httpStatus, and path", () => {
    const shape = formatTRPCErrorShape(notFound("missing org"), "organization.get");
    expect(shape.data.code).toBe("NOT_FOUND");
    expect(shape.data.httpStatus).toBe(404);
    expect(shape.data.path).toBe("organization.get");
    expect(shape.message).toBe("missing org");
  });
});

describe("trpcCodeToHttpStatus", () => {
  test("maps common codes", () => {
    expect(trpcCodeToHttpStatus("BAD_REQUEST")).toBe(400);
    expect(trpcCodeToHttpStatus("NOT_FOUND")).toBe(404);
    expect(trpcCodeToHttpStatus("TOO_MANY_REQUESTS")).toBe(429);
    expect(trpcCodeToHttpStatus("INTERNAL_SERVER_ERROR")).toBe(500);
  });
});
