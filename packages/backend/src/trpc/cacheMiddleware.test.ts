import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const { safeGetMock, safeSetMock } = vi.hoisted(() => ({
  safeGetMock: vi.fn<[string], Promise<string | null>>(),
  safeSetMock: vi.fn<[string, string, number], Promise<void>>(),
}));

vi.mock("../services/cache.js", () => ({
  safeGet: safeGetMock,
  safeSet: safeSetMock,
}));

vi.mock("../utils/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { t } from "./trpc.js";
import { withTrpcCache } from "./cacheMiddleware.js";

describe("withTrpcCache middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const testRouter = t.router({
    cached: t.procedure
      .input(z.object({ value: z.string() }))
      .use(withTrpcCache<{ value: string }>(
        (input) => `trpc:test:${input.value}`,
        60,
      ))
      .query(({ input }) => ({ result: input.value.toUpperCase() })),
  });

  const caller = testRouter.createCaller({});

  it("returns cached aggregation data on cache hit without running the query", async () => {
    safeGetMock.mockResolvedValue(JSON.stringify({ result: "CACHED" }));

    const result = await caller.cached({ value: "hello" });

    expect(result).toEqual({ result: "CACHED" });
    expect(safeGetMock).toHaveBeenCalledWith("trpc:test:hello");
    expect(safeSetMock).not.toHaveBeenCalled();
  });

  it("executes the query and stores the result on cache miss", async () => {
    safeGetMock.mockResolvedValue(null);

    const result = await caller.cached({ value: "hello" });

    expect(result).toEqual({ result: "HELLO" });
    expect(safeSetMock).toHaveBeenCalledWith(
      "trpc:test:hello",
      JSON.stringify({ result: "HELLO" }),
      60,
    );
  });
});
