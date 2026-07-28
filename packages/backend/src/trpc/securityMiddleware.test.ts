/**
 * @file securityMiddleware.test.ts
 * @description Tests for the tRPC security middleware logic, metrics store, and config.
 *
 * Covers all analysis dimensions including the query-level AST parsing additions:
 * suspicious keys, monotonous structures, deep query selections, high entropy,
 * suspicious string values, and composite risk scoring.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TRPCError, initTRPC } from "@trpc/server";
import { z } from "zod";
import { buildSecurityMiddleware } from "./securityMiddleware.js";
import {
  securityMetrics,
  resetSecurityMetrics,
  getSecurityMetrics,
} from "./securityMetrics.js";
import { analyzeAST } from "../utils/astParser.js";
import { securityConfig } from "../config/securityConfig.js";

function buildDeepObject(depth: number): Record<string, unknown> {
  if (depth <= 0) return { leaf: true };
  return { a: buildDeepObject(depth - 1) };
}

function runMiddlewareLogic(input: unknown, path = "test.proc"): void {
  securityMetrics.totalRequests++;
  const config = securityConfig.global;
  const analysis = analyzeAST(input, config);

  if (!analysis.isSafe) {
    securityMetrics.blockedRequests++;

    if (analysis.hasCircularReference) {
      securityMetrics.violations.circularReference++;
    } else if (analysis.reason?.includes("Array size")) {
      securityMetrics.violations.arraySizeExceeded++;
    } else if (analysis.reason?.includes("depth")) {
      securityMetrics.violations.depthExceeded++;
    } else if (analysis.reason?.includes("Suspicious key")) {
      securityMetrics.violations.suspiciousKeyPattern++;
    } else if (analysis.reason?.includes("Monotonous")) {
      securityMetrics.violations.monotonousStructure++;
    } else if (analysis.reason?.includes("risk score")) {
      securityMetrics.violations.highRiskScore++;
    } else if (analysis.reason?.includes("query selection")) {
      securityMetrics.violations.deepQuerySelection++;
    } else if (analysis.reason?.includes("entropy") || analysis.reason?.includes("Entropy")) {
      securityMetrics.violations.highEntropyKeys++;
    } else if (analysis.reason?.includes("string value")) {
      securityMetrics.violations.suspiciousStringValues++;
    } else {
      securityMetrics.violations.nodeCountExceeded++;
    }

    const prev = securityMetrics.blockedByPath.get(path) ?? 0;
    securityMetrics.blockedByPath.set(path, prev + 1);

    throw new TRPCError({ code: "BAD_REQUEST", message: `Blocked: ${analysis.reason}` });
  }
}

beforeEach(() => resetSecurityMetrics());

describe("analyzeAST – depth enforcement (core blocking logic)", () => {
  it("returns isSafe=false for deeply nested input (50 levels)", () => {
    const result = analyzeAST(buildDeepObject(50), securityConfig.global);
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/depth/i);
  });

  it("returns isSafe=true for shallowly nested input (3 levels)", () => {
    expect(analyzeAST(buildDeepObject(3), securityConfig.global).isSafe).toBe(true);
  });
});

describe("analyzeAST – array size enforcement (core blocking logic)", () => {
  it("returns isSafe=false for 200-element array (limit 100)", () => {
    const oversized = Array.from({ length: 200 }, (_, i) => String(i));
    const result = analyzeAST(oversized, securityConfig.global);
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/array/i);
  });

  it("returns isSafe=true for 50-element array", () => {
    const fine = Array.from({ length: 50 }, (_, i) => String(i));
    expect(analyzeAST(fine, securityConfig.global).isSafe).toBe(true);
  });
});

describe("analyzeAST – circular reference enforcement (core blocking logic)", () => {
  it("returns isSafe=false and hasCircularReference=true", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj["self"] = obj;
    const result = analyzeAST(obj, securityConfig.global);
    expect(result.isSafe).toBe(false);
    expect(result.hasCircularReference).toBe(true);
    expect(result.reason).toMatch(/circular/i);
  });
});

describe("analyzeAST – prototype pollution key detection", () => {
  it("blocks __proto__ key", () => {
    const result = analyzeAST({ __proto__: { admin: true } }, securityConfig.global);
    expect(result.isSafe).toBe(false);
    expect(result.suspiciousKeys).toHaveLength(1);
    expect(result.suspiciousKeys[0]).toContain("__proto__");
    expect(result.reason).toMatch(/suspicious key/i);
  });

  it("blocks constructor key", () => {
    const result = analyzeAST({ constructor: { prototype: { admin: true } } }, securityConfig.global);
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/suspicious key/i);
  });

  it("blocks prototype key", () => {
    const result = analyzeAST({ prototype: { polluted: true } }, securityConfig.global);
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/suspicious key/i);
  });

  it("allows regular keys through", () => {
    const result = analyzeAST({ orgId: "stellar", name: "Stellar Org" }, securityConfig.global);
    expect(result.isSafe).toBe(true);
    expect(result.suspiciousKeys).toHaveLength(0);
  });
});

describe("analyzeAST – monotonous structure detection", () => {
  it("blocks {a:{a:{a:{a:{a:...}}}}} at 5 levels", () => {
    const input = { a: { a: { a: { a: { a: "leaf" } } } } };
    const result = analyzeAST(input, securityConfig.global);
    expect(result.isSafe).toBe(false);
    expect(result.monotonousDepth).toBeGreaterThanOrEqual(5);
    expect(result.reason).toMatch(/monotonous/i);
  });

  it("allows {a:{b:{c:{d:...}}}} (different keys)", () => {
    const result = analyzeAST({ a: { b: { c: { d: { e: "leaf" } } } } }, securityConfig.global);
    expect(result.isSafe).toBe(true);
    expect(result.monotonousDepth).toBe(0);
  });

  it("allows 3 levels of same key (within threshold)", () => {
    const result = analyzeAST({ a: { a: { a: "leaf" } } }, securityConfig.global);
    expect(result.isSafe).toBe(true);
  });
});

describe("analyzeAST – deep query selection detection", () => {
  it("blocks deeply nested select", () => {
    const input = {
      select: {
        user: {
          select: {
            profile: {
              select: {
                settings: {
                  select: {
                    theme: true,
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = analyzeAST(input, securityConfig.global);
    expect(result.isSafe).toBe(false);
    expect(result.hasDeepQuerySelection).toBe(true);
  });

  it("allows shallow select (1 level)", () => {
    const result = analyzeAST({ select: { id: true, name: true } }, securityConfig.global);
    expect(result.isSafe).toBe(true);
  });

  it("blocks deeply nested include", () => {
    const input = {
      include: {
        posts: {
          include: {
            comments: {
              include: {
                author: {
                  include: {
                    profile: true,
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = analyzeAST(input, securityConfig.global);
    expect(result.isSafe).toBe(false);
    expect(result.hasDeepQuerySelection).toBe(true);
  });
});

describe("analyzeAST – high entropy key detection", () => {
  it("blocks input with many high-entropy (randomized) keys", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      input[`k${Math.random().toString(36).substring(2, 10)}`] = `v${i}`;
    }
    const result = analyzeAST(input, securityConfig.global);
    expect(result.isSafe).toBe(false);
    expect(result.keyEntropy).toBeGreaterThan(5.5);
  });

  it("allows input with meaningful low-entropy keys", () => {
    const input = {
      organizationId: "stellar",
      maintainerAddress: "GC...",
      payoutAmount: "1000",
      createdAt: new Date().toISOString(),
      status: "active",
    };
    const result = analyzeAST(input, securityConfig.global);
    expect(result.isSafe).toBe(true);
    expect(result.keyEntropy).toBeLessThan(5.5);
  });
});

describe("analyzeAST – suspicious string value detection", () => {
  it("blocks input with script injection in string values", () => {
    const input = {
      name: "<script>alert('xss')</script>",
      description: "normal text",
      callback: "javascript:void(0)",
    };
    const result = analyzeAST(input, { maxSuspiciousStringValues: 1 });
    expect(result.isSafe).toBe(false);
    expect(result.suspiciousStringValues).toBeGreaterThanOrEqual(2);
  });

  it("allows normal string values", () => {
    const input = {
      name: "Very Prince",
      description: "A decentralized payout registry",
      website: "https://very-prince.io",
    };
    const result = analyzeAST(input, securityConfig.global);
    expect(result.isSafe).toBe(true);
    expect(result.suspiciousStringValues).toBe(0);
  });
});

describe("analyzeAST – risk scoring", () => {
  it("computes a low risk score for safe inputs", () => {
    const result = analyzeAST({ orgId: "stellar" }, securityConfig.global);
    expect(result.riskScore).toBeLessThan(0.5);
  });

  it("computes a higher risk score for suspicious inputs", () => {
    const result = analyzeAST(
      {
        __proto__: { admin: true },
        data: Array.from({ length: 80 }, (_, i) => ({ id: i })),
      },
      securityConfig.global,
    );
    expect(result.riskScore).toBeGreaterThan(0.4);
  });
});

describe("middleware logic + metrics – array size violation", () => {
  it("increments totalRequests and blockedRequests", () => {
    const oversized = Array.from({ length: 200 }, (_, i) => String(i));
    try { runMiddlewareLogic(oversized); } catch { }
    expect(securityMetrics.totalRequests).toBe(1);
    expect(securityMetrics.blockedRequests).toBe(1);
  });

  it("increments arraySizeExceeded violation counter", () => {
    const oversized = Array.from({ length: 200 }, (_, i) => String(i));
    try { runMiddlewareLogic(oversized); } catch { }
    expect(securityMetrics.violations.arraySizeExceeded).toBe(1);
  });

  it("records the path in blockedByPath", () => {
    const oversized = Array.from({ length: 200 }, (_, i) => String(i));
    try { runMiddlewareLogic(oversized, "org.list"); } catch { }
    expect(securityMetrics.blockedByPath.get("org.list")).toBe(1);
  });

  it("throws TRPCError BAD_REQUEST", () => {
    const oversized = Array.from({ length: 200 }, (_, i) => String(i));
    expect(() => runMiddlewareLogic(oversized)).toThrow(TRPCError);
    let code: string | undefined;
    try { runMiddlewareLogic(oversized); } catch (e) { code = (e as TRPCError).code; }
    expect(code).toBe("BAD_REQUEST");
  });

  it("accumulates per-path count across multiple calls", () => {
    const oversized = Array.from({ length: 200 }, (_, i) => String(i));
    for (let i = 0; i < 3; i++) {
      try { runMiddlewareLogic(oversized, "batch"); } catch { }
    }
    expect(securityMetrics.blockedByPath.get("batch")).toBe(3);
  });
});

describe("middleware logic + metrics – depth violation", () => {
  it("increments depthExceeded and blockedRequests", () => {
    try { runMiddlewareLogic(buildDeepObject(50)); } catch { }
    expect(securityMetrics.blockedRequests).toBe(1);
    expect(securityMetrics.violations.depthExceeded).toBe(1);
  });

  it("throws TRPCError BAD_REQUEST", () => {
    expect(() => runMiddlewareLogic(buildDeepObject(50))).toThrow(TRPCError);
  });
});

describe("middleware logic + metrics – circular reference violation", () => {
  it("increments circularReference and blockedRequests", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj["self"] = obj;
    try { runMiddlewareLogic(obj); } catch { }
    expect(securityMetrics.blockedRequests).toBe(1);
    expect(securityMetrics.violations.circularReference).toBe(1);
  });
});

describe("middleware logic + metrics – suspicious key violation", () => {
  it("increments suspiciousKeyPattern and blockedRequests", () => {
    try { runMiddlewareLogic({ __proto__: { admin: true } }); } catch { }
    expect(securityMetrics.blockedRequests).toBe(1);
    expect(securityMetrics.violations.suspiciousKeyPattern).toBe(1);
  });

  it("throws TRPCError BAD_REQUEST for __proto__", () => {
    expect(() => runMiddlewareLogic({ __proto__: { admin: true } })).toThrow(TRPCError);
  });

  it("throws TRPCError BAD_REQUEST for constructor", () => {
    expect(() => runMiddlewareLogic({ constructor: { prototype: { polluted: true } } })).toThrow(TRPCError);
  });
});

describe("middleware logic + metrics – monotonous structure violation", () => {
  it("increments monotonousStructure and blockedRequests", () => {
    const monotonous = { a: { a: { a: { a: { a: "leaf" } } } } };
    try { runMiddlewareLogic(monotonous); } catch { }
    expect(securityMetrics.blockedRequests).toBe(1);
    expect(securityMetrics.violations.monotonousStructure).toBe(1);
  });
});

describe("middleware logic + metrics – deep query selection violation", () => {
  it("increments deepQuerySelection and blockedRequests", () => {
    const deepSelect = {
      select: {
        a: { select: { b: { select: { c: { select: { d: { select: { e: true } } } } } } } },
      },
    };
    try { runMiddlewareLogic(deepSelect); } catch { }
    expect(securityMetrics.blockedRequests).toBe(1);
    expect(securityMetrics.violations.deepQuerySelection).toBe(1);
  });
});

describe("middleware logic + metrics – safe input", () => {
  it("does not increment blockedRequests", () => {
    runMiddlewareLogic({ orgId: "stellar", page: 1 });
    expect(securityMetrics.totalRequests).toBe(1);
    expect(securityMetrics.blockedRequests).toBe(0);
  });

  it("does not increment any violation counter", () => {
    runMiddlewareLogic({ msg: "hello" });
    expect(securityMetrics.violations.depthExceeded).toBe(0);
    expect(securityMetrics.violations.nodeCountExceeded).toBe(0);
    expect(securityMetrics.violations.arraySizeExceeded).toBe(0);
    expect(securityMetrics.violations.circularReference).toBe(0);
    expect(securityMetrics.violations.suspiciousKeyPattern).toBe(0);
    expect(securityMetrics.violations.monotonousStructure).toBe(0);
    expect(securityMetrics.violations.highRiskScore).toBe(0);
    expect(securityMetrics.violations.deepQuerySelection).toBe(0);
    expect(securityMetrics.violations.highEntropyKeys).toBe(0);
    expect(securityMetrics.violations.suspiciousStringValues).toBe(0);
  });
});

describe("securityMetrics store", () => {
  it("starts at zero after reset", () => {
    expect(securityMetrics.totalRequests).toBe(0);
    expect(securityMetrics.blockedRequests).toBe(0);
    expect(securityMetrics.violations.depthExceeded).toBe(0);
    expect(securityMetrics.violations.nodeCountExceeded).toBe(0);
    expect(securityMetrics.violations.arraySizeExceeded).toBe(0);
    expect(securityMetrics.violations.circularReference).toBe(0);
    expect(securityMetrics.violations.suspiciousKeyPattern).toBe(0);
    expect(securityMetrics.violations.monotonousStructure).toBe(0);
    expect(securityMetrics.violations.highRiskScore).toBe(0);
    expect(securityMetrics.violations.deepQuerySelection).toBe(0);
    expect(securityMetrics.violations.highEntropyKeys).toBe(0);
    expect(securityMetrics.violations.suspiciousStringValues).toBe(0);
    expect(securityMetrics.blockedByPath.size).toBe(0);
  });

  it("resetSecurityMetrics clears all counters (including new ones)", () => {
    securityMetrics.totalRequests = 10;
    securityMetrics.blockedRequests = 7;
    securityMetrics.violations.depthExceeded = 2;
    securityMetrics.violations.suspiciousKeyPattern = 1;
    securityMetrics.violations.monotonousStructure = 1;
    securityMetrics.violations.highRiskScore = 1;
    securityMetrics.violations.deepQuerySelection = 1;
    securityMetrics.violations.highEntropyKeys = 1;
    securityMetrics.violations.suspiciousStringValues = 1;
    securityMetrics.blockedByPath.set("test.path", 5);

    resetSecurityMetrics();

    expect(securityMetrics.totalRequests).toBe(0);
    expect(securityMetrics.blockedRequests).toBe(0);
    expect(securityMetrics.violations.depthExceeded).toBe(0);
    expect(securityMetrics.violations.suspiciousKeyPattern).toBe(0);
    expect(securityMetrics.violations.monotonousStructure).toBe(0);
    expect(securityMetrics.violations.highRiskScore).toBe(0);
    expect(securityMetrics.violations.deepQuerySelection).toBe(0);
    expect(securityMetrics.violations.highEntropyKeys).toBe(0);
    expect(securityMetrics.violations.suspiciousStringValues).toBe(0);
    expect(securityMetrics.blockedByPath.size).toBe(0);
  });
});

describe("getSecurityMetrics", () => {
  it("returns blockedByPath as a plain object, not a Map", () => {
    securityMetrics.blockedByPath.set("org.get", 7);
    const snapshot = getSecurityMetrics();
    expect(snapshot.blockedByPath).not.toBeInstanceOf(Map);
    expect(snapshot.blockedByPath["org.get"]).toBe(7);
  });

  it("snapshot mutation does not affect the live Map", () => {
    securityMetrics.blockedByPath.set("org.get", 2);
    const snapshot = getSecurityMetrics();
    (snapshot.blockedByPath as Record<string, number>)["org.get"] = 999;
    expect(securityMetrics.blockedByPath.get("org.get")).toBe(2);
  });

  it("reflects all live counter values including new violation types", () => {
    securityMetrics.totalRequests = 10;
    securityMetrics.blockedRequests = 4;
    securityMetrics.violations.suspiciousKeyPattern = 2;
    securityMetrics.violations.monotonousStructure = 1;
    const snap = getSecurityMetrics();
    expect(snap.totalRequests).toBe(10);
    expect(snap.blockedRequests).toBe(4);
    expect(snap.violations.suspiciousKeyPattern).toBe(2);
    expect(snap.violations.monotonousStructure).toBe(1);
  });
});

describe("buildSecurityMiddleware – safe inputs (createCaller smoke)", () => {
  const localT = initTRPC.create();
  const mw = buildSecurityMiddleware(localT);

  const router = localT.router({
    echo: localT.procedure
      .use(mw)
      .input(z.object({ msg: z.string() }))
      .query(({ input }) => ({ reply: input.msg })),

    ping: localT.procedure
      .use(mw)
      .query(() => ({ pong: true })),
  });

  const caller = router.createCaller({});

  it("passes through a valid shallow input", async () => {
    expect(await caller.echo({ msg: "hello" })).toEqual({ reply: "hello" });
  });

  it("passes through a no-input procedure", async () => {
    expect(await caller.ping()).toEqual({ pong: true });
  });

  it("does not increment blockedRequests for safe calls", async () => {
    await caller.echo({ msg: "safe" });
    expect(securityMetrics.blockedRequests).toBe(0);
  });
});
