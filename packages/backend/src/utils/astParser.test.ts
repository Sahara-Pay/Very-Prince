/**
 * @file astParser.test.ts
 * @description Tests for the query-level AST parser for malicious tRPC deep-nesting detection.
 *
 * Coverage:
 * - Primitive passthrough
 * - Valid shallow and moderately nested objects
 * - Depth, node count, array size, circular reference enforcement
 * - Prototype pollution key detection (__proto__, constructor, prototype)
 * - Monotonous structure detection ({a:{a:{a:...}}} patterns)
 * - Deep query selection detection (select/include/orderBy abuse)
 * - High-entropy key detection (randomized synthetic keys)
 * - Suspicious string value detection (XSS/injection patterns)
 * - Composite risk scoring
 * - Mixed structures, edge cases, custom config overrides
 * - createAnalyzer factory and validateInputSafety
 */

import { describe, it, expect } from "vitest";
import {
  analyzeAST,
  validateInputSafety,
  createAnalyzer,
  DEFAULT_AST_CONFIG,
} from "./astParser.js";

function buildDeepObject(depth: number): Record<string, unknown> {
  if (depth <= 0) return { leaf: true };
  return { a: buildDeepObject(depth - 1) };
}

function buildWideObject(keyCount: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: keyCount }, (_, i) => [`key${i}`, `val${i}`]),
  );
}

function buildLargeArray(size: number): Record<string, string>[] {
  return Array.from({ length: size }, (_, i) => ({ id: String(i) }));
}

describe("analyzeAST – primitives", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "hello"],
    ["number", 42],
    ["boolean true", true],
    ["boolean false", false],
    ["bigint", BigInt(9007199254740991)],
  ])("marks %s as safe with depth 0", (_label, value) => {
    const result = analyzeAST(value);
    expect(result.isSafe).toBe(true);
    expect(result.maxDepth).toBe(0);
    expect(result.totalNodes).toBe(1);
    expect(result.hasCircularReference).toBe(false);
    expect(result.suspiciousKeys).toHaveLength(0);
    expect(result.monotonousDepth).toBe(0);
  });
});

describe("analyzeAST – valid inputs", () => {
  it("accepts an empty object", () => {
    const result = analyzeAST({});
    expect(result.isSafe).toBe(true);
    expect(result.maxDepth).toBe(0);
  });

  it("accepts an empty array", () => {
    const result = analyzeAST([]);
    expect(result.isSafe).toBe(true);
    expect(result.maxDepth).toBe(0);
    expect(result.maxArraySize).toBe(0);
  });

  it("accepts a flat object with several keys", () => {
    const input = { id: "abc", name: "Stellar", active: true, score: 99 };
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(true);
    expect(result.maxDepth).toBe(1);
  });

  it("accepts a typical tRPC input at depth 2", () => {
    const input = {
      orgId: "stellar",
      pagination: { cursor: "abc", limit: 10 },
    };
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(true);
    expect(result.maxDepth).toBe(2);
  });

  it("accepts nesting at exactly the default maxDepth (10)", () => {
    const result = analyzeAST(buildDeepObject(9));
    expect(result.isSafe).toBe(true);
  });

  it("correctly counts total nodes", () => {
    const result = analyzeAST({ a: 1, b: 2 });
    expect(result.totalNodes).toBe(3);
  });

  it("tracks maxArraySize correctly", () => {
    const result = analyzeAST({ items: [1, 2, 3] });
    expect(result.maxArraySize).toBe(3);
  });
});

describe("analyzeAST – depth violations", () => {
  it("blocks nesting one level beyond the default maxDepth", () => {
    const result = analyzeAST(buildDeepObject(DEFAULT_AST_CONFIG.maxDepth + 1));
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/depth/i);
    expect(result.maxDepth).toBeGreaterThan(DEFAULT_AST_CONFIG.maxDepth);
  });

  it("blocks severely deep nesting (100 levels)", () => {
    const result = analyzeAST(buildDeepObject(100));
    expect(result.isSafe).toBe(false);
  });

  it("records the path where depth was exceeded when trackPaths is true", () => {
    const result = analyzeAST(buildDeepObject(DEFAULT_AST_CONFIG.maxDepth + 2), {
      trackPaths: true,
    });
    expect(result.isSafe).toBe(false);
    expect(result.excessiveDepthPaths.length).toBeGreaterThan(0);
  });

  it("does not record paths when trackPaths is false", () => {
    const result = analyzeAST(buildDeepObject(DEFAULT_AST_CONFIG.maxDepth + 2), {
      trackPaths: false,
    });
    expect(result.isSafe).toBe(false);
    expect(result.excessiveDepthPaths).toHaveLength(0);
  });

  it("respects a custom maxDepth override", () => {
    const flat = { a: "leaf" };
    const safeResult = analyzeAST(flat, { maxDepth: 1 });
    const blockedResult = analyzeAST(flat, { maxDepth: 0 });
    expect(safeResult.isSafe).toBe(true);
    expect(blockedResult.isSafe).toBe(false);
  });
});

describe("analyzeAST – node count violations", () => {
  it("blocks inputs that exceed the maxNodes limit", () => {
    const result = analyzeAST(buildWideObject(200), { maxNodes: 100 });
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/node count/i);
  });

  it("accepts inputs right at the maxNodes limit", () => {
    const result = analyzeAST(buildWideObject(5), { maxNodes: 6 });
    expect(result.isSafe).toBe(true);
  });

  it("blocks a 10,000-node payload with default limits", () => {
    const result = analyzeAST(buildWideObject(1001));
    expect(result.isSafe).toBe(false);
  });
});

describe("analyzeAST – array size violations", () => {
  it("blocks arrays exceeding the default maxArraySize (100)", () => {
    const result = analyzeAST(buildLargeArray(101));
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/array size/i);
  });

  it("accepts arrays at exactly the default maxArraySize", () => {
    const result = analyzeAST(buildLargeArray(100));
    expect(result.isSafe).toBe(true);
    expect(result.maxArraySize).toBe(100);
  });

  it("blocks nested arrays that exceed the limit", () => {
    const result = analyzeAST({ items: buildLargeArray(200) });
    expect(result.isSafe).toBe(false);
  });

  it("records path of large array when trackPaths is true", () => {
    const result = analyzeAST(
      { batch: buildLargeArray(200) },
      { trackPaths: true },
    );
    expect(result.isSafe).toBe(false);
    expect(result.largeArrayPaths.length).toBeGreaterThan(0);
    expect(result.largeArrayPaths[0]).toMatch(/batch/);
  });

  it("respects a custom maxArraySize override", () => {
    const safeResult = analyzeAST([1, 2, 3], { maxArraySize: 3 });
    const blockedResult = analyzeAST([1, 2, 3, 4], { maxArraySize: 3 });
    expect(safeResult.isSafe).toBe(true);
    expect(blockedResult.isSafe).toBe(false);
  });
});

describe("analyzeAST – circular references", () => {
  it("detects a direct self-reference", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj["self"] = obj;
    const result = analyzeAST(obj);
    expect(result.isSafe).toBe(false);
    expect(result.hasCircularReference).toBe(true);
    expect(result.reason).toMatch(/circular/i);
  });

  it("detects an indirect circular reference", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", parent: a };
    a["child"] = b;
    const result = analyzeAST(a);
    expect(result.isSafe).toBe(false);
    expect(result.hasCircularReference).toBe(true);
  });

  it("does not flag identical primitive values as circular", () => {
    const shared = "shared-value";
    const result = analyzeAST({ a: shared, b: shared, c: { d: shared } });
    expect(result.isSafe).toBe(true);
    expect(result.hasCircularReference).toBe(false);
  });
});

describe("analyzeAST – prototype pollution key detection", () => {
  it("blocks __proto__ key via prototype manipulation detection", () => {
    const result = analyzeAST({ __proto__: { admin: true } });
    expect(result.isSafe).toBe(false);
    expect(result.suspiciousKeys).toHaveLength(1);
    expect(result.suspiciousKeys[0]).toContain("__proto__");
    expect(result.reason).toMatch(/suspicious key/i);
    expect(result.reason).toMatch(/prototype pollution/i);
  });

  it("blocks constructor key", () => {
    const result = analyzeAST({ constructor: { prototype: { polluted: true } } });
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/suspicious key/i);
  });

  it("blocks prototype key", () => {
    const result = analyzeAST({ prototype: { admin: true } });
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/suspicious key/i);
  });

  it("blocks __defineGetter__ key", () => {
    const result = analyzeAST({ __defineGetter__: "value" });
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/suspicious key/i);
    expect(result.reason).toMatch(/injection/i);
  });

  it("allows regular keys through", () => {
    const result = analyzeAST({ orgId: "stellar", name: "Stellar Org", desc: "test" });
    expect(result.isSafe).toBe(true);
    expect(result.suspiciousKeys).toHaveLength(0);
  });

  it("does not flag keys when detectSuspiciousKeys is disabled", () => {
    const result = analyzeAST(
      { __proto__: { admin: true } },
      { detectSuspiciousKeys: false },
    );
    expect(result.isSafe).toBe(true);
    expect(result.suspiciousKeys).toHaveLength(0);
  });

  it("detects __proto__ via JSON.parse (own property)", () => {
    const input = JSON.parse('{"__proto__": {"admin": true}}');
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(false);
    expect(result.suspiciousKeys.length).toBeGreaterThan(0);
  });
});

describe("analyzeAST – monotonous structure detection", () => {
  it("blocks {a:{a:{a:{a:{a:...}}}}} at 5 levels", () => {
    const input = { a: { a: { a: { a: { a: "leaf" } } } } };
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(false);
    expect(result.monotonousDepth).toBeGreaterThanOrEqual(5);
    expect(result.reason).toMatch(/monotonous/i);
  });

  it("blocks {x:{x:{x:{x:{x:{x:...}}}}}} at 6 levels with different key name", () => {
    const input = { x: { x: { x: { x: { x: { x: "deep" } } } } } };
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(false);
    expect(result.monotonousDepth).toBeGreaterThanOrEqual(6);
  });

  it("allows {a:{b:{c:{d:...}}}} (different keys at each level)", () => {
    const result = analyzeAST({ a: { b: { c: { d: { e: "leaf" } } } } });
    expect(result.isSafe).toBe(true);
    expect(result.monotonousDepth).toBe(0);
  });

  it("allows 3 levels of same key (within default threshold of 4)", () => {
    const result = analyzeAST({ a: { a: { a: "leaf" } } });
    expect(result.isSafe).toBe(true);
    expect(result.monotonousDepth).toBe(0);
  });

  it("respects custom monotonousThreshold override", () => {
    const input = { a: { a: { a: "leaf" } } };
    const result = analyzeAST(input, { monotonousThreshold: 3 });
    expect(result.isSafe).toBe(false);
    expect(result.monotonousDepth).toBeGreaterThanOrEqual(3);
  });

  it("does not flag monotonous patterns when detection is disabled", () => {
    const input = { a: { a: { a: { a: { a: "leaf" } } } } };
    const result = analyzeAST(input, { detectMonotonousStructures: false });
    expect(result.isSafe).toBe(true);
  });

  it("detects monotonous patterns even with mixed types at the deepest level", () => {
    const input = { a: { a: { a: { a: { a: [1, 2, 3] } } } } };
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(false);
    expect(result.monotonousDepth).toBeGreaterThanOrEqual(5);
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
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(false);
    expect(result.hasDeepQuerySelection).toBe(true);
    expect(result.deepQuerySelectionPaths.length).toBeGreaterThan(0);
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
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(false);
    expect(result.hasDeepQuerySelection).toBe(true);
  });

  it("allows shallow select (1 level)", () => {
    const result = analyzeAST({ select: { id: true, name: true } });
    expect(result.isSafe).toBe(true);
  });

  it("allows shallow include (2 levels)", () => {
    const result = analyzeAST({ include: { posts: { include: { comments: true } } } });
    expect(result.isSafe).toBe(true);
  });

  it("allows shallow orderBy", () => {
    const result = analyzeAST({ orderBy: { createdAt: "desc" } });
    expect(result.isSafe).toBe(true);
  });

  it("does not flag when detection is disabled", () => {
    const input = {
      select: {
        a: { select: { b: { select: { c: { select: { d: { select: { e: true } } } } } } } },
      },
    };
    const result = analyzeAST(input, { detectDeepQuerySelections: false });
    expect(result.isSafe).toBe(true);
  });
});

describe("analyzeAST – high entropy key detection", () => {
  it("blocks input with many high-entropy (randomized) keys", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      input[`k${Math.random().toString(36).substring(2, 10)}`] = `v${i}`;
    }
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(false);
    expect(result.keyEntropy).toBeGreaterThan(5.5);
  });

  it("allows input with meaningful low-entropy keys", () => {
    const input = {
      organizationId: "stellar",
      maintainerAddress: "GC1234567890123456789012345678901234567890123",
      payoutAmount: "1000",
      createdAt: new Date().toISOString(),
      status: "active",
    };
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(true);
    expect(result.keyEntropy).toBeLessThan(5.5);
  });

  it("does not flag input with few keys even if high entropy", () => {
    const input: Record<string, unknown> = {};
    input[`${Math.random().toString(36)}`] = "value";
    input[`${Math.random().toString(36)}`] = "value2";
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(true);
  });

  it("respects custom maxKeyEntropy override", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      input[`k${Math.random().toString(36).substring(2, 10)}`] = `v${i}`;
    }
    const result = analyzeAST(input, { maxKeyEntropy: 8 });
    expect(result.isSafe).toBe(true);
  });
});

describe("analyzeAST – suspicious string value detection", () => {
  it("detects <script> injection patterns", () => {
    const input = {
      name: "<script>alert('xss')</script>",
      description: "normal text",
    };
    const result = analyzeAST(input, { maxSuspiciousStringValues: 1 });
    expect(result.isSafe).toBe(false);
    expect(result.suspiciousStringValues).toBeGreaterThanOrEqual(1);
  });

  it("detects javascript: URIs", () => {
    const input = { callback: "javascript:void(0)" };
    const result = analyzeAST(input, { maxSuspiciousStringValues: 1 });
    expect(result.isSafe).toBe(false);
    expect(result.suspiciousStringValues).toBeGreaterThanOrEqual(1);
  });

  it("detects on* event handler patterns", () => {
    const input = { img: "something onerror=alert(1)" };
    const result = analyzeAST(input, { maxSuspiciousStringValues: 1 });
    expect(result.isSafe).toBe(false);
    expect(result.suspiciousStringValues).toBeGreaterThanOrEqual(1);
  });

  it("detects data:text/html URIs", () => {
    const input = { payload: "data:text/html;base64,PHNjcmlwdD4=" };
    const result = analyzeAST(input, { maxSuspiciousStringValues: 1 });
    expect(result.isSafe).toBe(false);
  });

  it("detects template injection patterns", () => {
    const input = { tpl: "Hello ${user.name}" };
    const result = analyzeAST(input, { maxSuspiciousStringValues: 1 });
    expect(result.isSafe).toBe(false);
  });

  it("allows normal string values", () => {
    const input = {
      name: "Very Prince",
      description: "A decentralized payout registry",
      website: "https://very-prince.io",
    };
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(true);
    expect(result.suspiciousStringValues).toBe(0);
  });

  it("does not flag when detection is disabled", () => {
    const input = { name: "<script>alert('xss')</script>" };
    const result = analyzeAST(input, {
      detectSuspiciousStringValues: false,
    });
    expect(result.isSafe).toBe(true);
  });
});

describe("analyzeAST – risk scoring", () => {
  it("computes a low risk score for safe inputs", () => {
    const result = analyzeAST({ orgId: "stellar" });
    expect(result.riskScore).toBeLessThan(0.5);
  });

  it("computes a higher risk score for suspicious inputs", () => {
    const result = analyzeAST(
      {
        constructor: { prototype: { polluted: true } },
        data: Array.from({ length: 80 }, (_, i) => ({ id: i })),
      },
    );
    expect(result.riskScore).toBeGreaterThan(0.4);
  });

  it("computes a very high risk score for deeply nested suspicious input", () => {
    const deepSuspicious = {
      constructor: { prototype: { polluted: true } },
      payload: buildDeepObject(8),
    };
    const result = analyzeAST(deepSuspicious);
    expect(result.riskScore).toBeGreaterThan(0.5);
  });

  it("blocks when risk score exceeds threshold", () => {
    const risky = {
      constructor: { prototype: { polluted: true } },
      data: Array.from({ length: 80 }, (_, i) => ({ id: i })),
    };
    const result = analyzeAST(risky, { maxRiskScore: 0.5 });
    expect(result.isSafe).toBe(false);
    expect(result.reason).toMatch(/risk score/i);
  });

  it("skips risk scoring when disabled", () => {
    const risky = {
      constructor: { prototype: { polluted: true } },
      data: Array.from({ length: 80 }, (_, i) => ({ id: i })),
    };
    const result = analyzeAST(risky, { enableRiskScoring: false });
    expect(result.riskScore).toBe(0);
  });
});

describe("analyzeAST – mixed object/array structures", () => {
  it("correctly measures depth through alternating objects and arrays", () => {
    const input = { level1: [{ level3: "leaf" }] };
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(true);
    expect(result.maxDepth).toBe(3);
  });

  it("blocks when array nesting pushes depth over the limit", () => {
    const deepInsideArray = [buildDeepObject(DEFAULT_AST_CONFIG.maxDepth)];
    const result = analyzeAST(deepInsideArray);
    expect(result.isSafe).toBe(false);
  });

  it("handles arrays of arrays", () => {
    const result = analyzeAST([[1, 2], [3, 4], [5, 6]]);
    expect(result.isSafe).toBe(true);
    expect(result.maxArraySize).toBe(3);
  });

  it("detects suspicious keys inside arrays", () => {
    const input = [JSON.parse('{"__proto__": {"admin": true}}')];
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(false);
    expect(result.suspiciousKeys.length).toBeGreaterThan(0);
  });
});

describe("analyzeAST – combined attack patterns", () => {
  it("blocks input with deep nesting + suspicious key + large array", () => {
    const malicious = {
      constructor: { prototype: { polluted: true } },
      data: buildDeepObject(8),
      items: Array.from({ length: 90 }, (_, i) => ({ idx: i })),
    };
    const result = analyzeAST(malicious);
    expect(result.isSafe).toBe(false);
    expect(result.riskScore).toBeGreaterThan(0.5);
  });

  it("blocks input with monotonous pattern + deep query selection", () => {
    const malicious = {
      a: {
        a: {
          a: {
            a: {
              a: {
                select: {
                  user: {
                    select: {
                      profile: {
                        select: {
                          settings: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = analyzeAST(malicious);
    expect(result.isSafe).toBe(false);
    expect(result.monotonousDepth).toBeGreaterThanOrEqual(4);
  });

  it("blocks deeply nested tRPC filter query with injection payloads", () => {
    const malicious = {
      where: {
        OR: [
          { name: { contains: "<script>alert(1)</script>" } },
          { email: { contains: "javascript:void(0)" } },
          {
            profile: {
              where: {
                AND: [
                  { bio: { contains: "onerror=alert" } },
                  { settings: { theme: "dark" } },
                ],
              },
            },
          },
        ],
      },
    };
    const result = analyzeAST(malicious);
    expect(result.isSafe).toBe(false);
  });
});

describe("analyzeAST – edge cases", () => {
  it("handles symbols as values without throwing", () => {
    const result = analyzeAST({ key: Symbol("test") });
    expect(result.isSafe).toBe(true);
  });

  it("handles functions as values without throwing", () => {
    const result = analyzeAST({ fn: () => 42 });
    expect(result.isSafe).toBe(true);
  });

  it("handles Date objects", () => {
    const result = analyzeAST({ date: new Date() });
    expect(result.isSafe).toBe(true);
  });

  it("handles deep nesting inside arrays with monotonous detection", () => {
    const input = [{ a: { a: { a: { a: { a: "deep" } } } } }];
    const result = analyzeAST(input);
    expect(result.isSafe).toBe(false);
    expect(result.monotonousDepth).toBeGreaterThanOrEqual(5);
  });
});

describe("createAnalyzer", () => {
  it("creates an analyzer with bound configuration", () => {
    const strictAnalyzer = createAnalyzer({ maxDepth: 2 });
    const safe = strictAnalyzer({ a: { b: "leaf" } });
    const unsafe = strictAnalyzer({ a: { b: { c: "deep" } } });
    expect(safe.isSafe).toBe(true);
    expect(unsafe.isSafe).toBe(false);
  });

  it("respects all config dimensions in the factory", () => {
    const analyzer = createAnalyzer({ maxArraySize: 2, maxNodes: 5 });
    expect(analyzer([1, 2, 3]).isSafe).toBe(false);
    expect(analyzer([1, 2]).isSafe).toBe(true);
  });

  it("factory binds suspicious key detection config", () => {
    const analyzer = createAnalyzer({ detectSuspiciousKeys: true });
    const safe = analyzer({ normal: "key" });
    const unsafe = analyzer(JSON.parse('{"__proto__": {"x": 1}}'));
    expect(safe.isSafe).toBe(true);
    expect(unsafe.isSafe).toBe(false);
  });

  it("factory binds query selection detection config", () => {
    const analyzer = createAnalyzer({ maxQuerySelectionDepth: 2 });
    const safe = analyzer({ select: { a: { b: true } } });
    const unsafe = analyzer({ select: { a: { select: { b: { c: true } } } } });
    expect(safe.isSafe).toBe(true);
    expect(unsafe.isSafe).toBe(false);
  });
});

describe("validateInputSafety", () => {
  it("does not throw for safe inputs", () => {
    expect(() => validateInputSafety({ id: "abc", limit: 10 })).not.toThrow();
  });

  it("throws an Error for depth-exceeded inputs", () => {
    expect(() =>
      validateInputSafety(buildDeepObject(DEFAULT_AST_CONFIG.maxDepth + 1)),
    ).toThrowError(/malicious input/i);
  });

  it("throws an Error for circular references", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    expect(() => validateInputSafety(obj)).toThrowError(/malicious input/i);
  });

  it("throws an Error for oversized arrays", () => {
    expect(() =>
      validateInputSafety(buildLargeArray(200)),
    ).toThrowError(/malicious input/i);
  });

  it("throws for prototype pollution keys (via JSON.parse)", () => {
    expect(() =>
      validateInputSafety(JSON.parse('{"__proto__": {"admin": true}}')),
    ).toThrowError(/malicious input/i);
  });

  it("throws for constructor key", () => {
    expect(() =>
      validateInputSafety({ constructor: { prototype: { polluted: true } } }),
    ).toThrowError(/malicious input/i);
  });

  it("throws for monotonous structures", () => {
    expect(() =>
      validateInputSafety({ a: { a: { a: { a: { a: "deep" } } } } }),
    ).toThrowError(/malicious input/i);
  });

  it("includes reason detail in the thrown error message", () => {
    let message = "";
    try {
      validateInputSafety(buildDeepObject(50));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/depth/i);
  });

  it("includes risk score in message when relevant", () => {
    let message = "";
    try {
      validateInputSafety(
        {
          constructor: { prototype: { polluted: true } },
          data: Array.from({ length: 80 }, (_, i) => ({ id: i })),
        },
        { maxRiskScore: 0.4 },
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/risk score/i);
  });
});
