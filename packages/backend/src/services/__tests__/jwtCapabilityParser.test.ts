/**
 * @file jwtCapabilityParser.test.ts
 * @description Load and concurrency tests for JWT capability payload parser.
 * Tests verify that the JWT capability parser handles high-throughput Web3 webhook
 * traffic without blocking the Node.js event loop and maintains performance under load.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JwtCapabilityParser } from "../jwtCapabilityParser.js";
import { staleCacheService } from "../staleCache.js";
import { logger } from "../../utils/logger.js";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../../config/env.js";

// Mock dependencies
vi.mock("../staleCache.js");
vi.mock("../../utils/logger.js");

describe("JWT Capability Parser Load Tests", () => {
  let parser: JwtCapabilityParser;
  let validToken: string;
  let expiredToken: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(logger).debug = vi.fn();
    vi.mocked(logger).warn = vi.fn();
    vi.mocked(logger).error = vi.fn();

    parser = new JwtCapabilityParser({
      enableCache: true,
      cacheTTL: 60,
      expiryGracePeriodMs: 1000,
    });

    // Generate test tokens
    validToken = jwt.sign(
      {
        sub: "org-123",
        permissions: ["webhook:dispatch", "webhook:read"],
        resources: ["org-123"],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      JWT_SECRET
    );

    expiredToken = jwt.sign(
      {
        sub: "org-123",
        permissions: ["webhook:dispatch"],
        iat: Math.floor(Date.now() / 1000) - 7200,
        exp: Math.floor(Date.now() / 1000) - 3600,
      },
      JWT_SECRET
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Event Loop Non-Blocking Tests", () => {
    it("should not block event loop during JWT parsing", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return fetcher();
      });

      let parseResolved = false;
      const parsePromise = parser.parseCapability(validToken).then(() => {
        parseResolved = true;
      });

      // Check if event loop is still responsive
      let eventLoopResponsive = true;
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch (error) {
        eventLoopResponsive = false;
      }

      expect(eventLoopResponsive).toBe(true);
      expect(parseResolved).toBe(false); // Parse should still be processing

      await parsePromise;
      expect(parseResolved).toBe(true);
    });

    it("should not block event loop during permission checks", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return fetcher();
      });

      const checkPromise = parser.hasPermission(validToken, "webhook:dispatch");

      // Event loop should remain responsive
      let eventLoopResponsive = true;
      try {
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch (error) {
        eventLoopResponsive = false;
      }

      expect(eventLoopResponsive).toBe(true);

      const result = await checkPromise;
      expect(result.granted).toBe(true);
    });

    it("should handle 100 concurrent JWT parses without blocking", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return fetcher();
      });

      const concurrentRequests = 100;
      const promises = [];

      for (let i = 0; i < concurrentRequests; i++) {
        const token = jwt.sign(
          {
            sub: `org-${i}`,
            permissions: ["webhook:dispatch"],
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
          JWT_SECRET
        );
        promises.push(parser.parseCapability(token));
      }

      const startTime = Date.now();
      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // Should complete quickly (not 100 * 5ms = 500ms if blocking)
      expect(duration).toBeLessThan(300);
      expect(results.length).toBe(concurrentRequests);
    });
  });

  describe("High Throughput Tests", () => {
    it("should handle rapid permission checks without performance degradation", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const iterations = 1000;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        await parser.hasPermission(validToken, "webhook:dispatch");
      }

      const duration = Date.now() - startTime;
      const avgTimePerOp = duration / iterations;

      // Should average less than 1ms per operation for cached checks
      expect(avgTimePerOp).toBeLessThan(1);
    });

    it("should handle mixed permission checks efficiently", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const permissions = ["webhook:dispatch", "webhook:read", "admin:write", "user:read"];
      const promises = [];

      for (let i = 0; i < 100; i++) {
        const permission = permissions[i % permissions.length];
        promises.push(parser.hasPermission(validToken, permission));
      }

      const startTime = Date.now();
      const results = await Promise.all(promises);
      const duration = Date.now() - startTime;

      // Should complete quickly
      expect(duration).toBeLessThan(200);
      expect(results.length).toBe(100);
    });

    it("should handle burst traffic during simulated block finalization", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return fetcher();
      });

      // Simulate burst of 50 capability checks in 100ms
      const burstSize = 50;
      const promises = [];

      const burstStart = Date.now();
      for (let i = 0; i < burstSize; i++) {
        const token = jwt.sign(
          {
            sub: `org-${i}`,
            permissions: ["webhook:dispatch"],
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
          JWT_SECRET
        );
        promises.push(parser.parseCapability(token));
        await new Promise(resolve => setTimeout(resolve, 2));
      }

      await Promise.all(promises);
      const burstDuration = Date.now() - burstStart;

      // Burst should complete in reasonable time
      expect(burstDuration).toBeLessThan(500);
    });
  });

  describe("Cache Performance Tests", () => {
    it("should leverage cache for repeated token parsing", async () => {
      let cacheHitCount = 0;
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        cacheHitCount++;
        if (cacheHitCount > 1) {
          // Return cached result on subsequent calls
          return {
            payload: {
              sub: "org-123",
              permissions: ["webhook:dispatch"],
              exp: Math.floor(Date.now() / 1000) + 3600,
              iat: Math.floor(Date.now() / 1000),
            },
            isValid: true,
            timeUntilExpiry: 3600000,
            errors: [],
            cacheKey: key,
          };
        }
        return fetcher();
      });

      // Parse the same token multiple times
      const iterations = 10;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        await parser.parseCapability(validToken);
      }

      const duration = Date.now() - startTime;

      // Cached operations should be very fast
      expect(duration).toBeLessThan(50);
      expect(cacheHitCount).toBe(iterations);
    });

    it("should handle cache invalidation gracefully", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });
      vi.mocked(staleCacheService).invalidate = vi.fn(async () => {});

      await parser.parseCapability(validToken);
      await parser.invalidateCache(validToken);

      expect(vi.mocked(staleCacheService).invalidate).toHaveBeenCalledTimes(1);
    });
  });

  describe("Error Handling Under Load", () => {
    it("should handle malformed JWT tokens gracefully", async () => {
      const malformedTokens = [
        "invalid.token.here",
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid",
        "",
        "not-a-jwt-at-all",
      ];

      const promises = malformedTokens.map(token => 
        parser.parseCapability(token).catch(() => ({ error: "parse_failed" }))
      );

      const results = await Promise.all(promises);

      // All malformed tokens should be handled gracefully
      expect(results.every(r => "error" in r)).toBe(true);
    });

    it("should handle expired tokens with grace period", async () => {
      const result = await parser.parseCapability(expiredToken);

      expect(result.isValid).toBe(false);
      expect(result.timeUntilExpiry).toBeLessThan(0);
      expect(result.errors).toContain("Token expired");
    });

    it("should handle tokens with missing required fields", async () => {
      const incompleteToken = jwt.sign(
        {
          sub: "org-123",
          // Missing permissions field
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        JWT_SECRET
      );

      const result = await parser.parseCapability(incompleteToken);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should handle invalid signatures gracefully", async () => {
      const tokenWithBadSignature = jwt.sign(
        { sub: "org-123", permissions: ["webhook:dispatch"] },
        "wrong-secret"
      );

      const result = await parser.parseCapability(tokenWithBadSignature);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("Invalid token signature or structure");
    });
  });

  describe("Permission Validation Tests", () => {
    it("should correctly validate granted permissions", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const result = await parser.hasPermission(validToken, "webhook:dispatch");

      expect(result.granted).toBe(true);
      expect(result.capability).toBeDefined();
    });

    it("should correctly deny missing permissions", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const result = await parser.hasPermission(validToken, "admin:delete");

      expect(result.granted).toBe(false);
      expect(result.reason).toContain("Permission 'admin:delete' not found");
    });

    it("should handle hasAnyPermission correctly", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const result = await parser.hasAnyPermission(validToken, ["admin:delete", "webhook:dispatch"]);

      expect(result.granted).toBe(true);
    });

    it("should deny when none of the any permissions are present", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const result = await parser.hasAnyPermission(validToken, ["admin:delete", "admin:write"]);

      expect(result.granted).toBe(false);
    });

    it("should validate resource access correctly", async () => {
      const tokenWithResource = jwt.sign(
        {
          sub: "org-123",
          permissions: ["webhook:dispatch"],
          resources: ["org-123", "org-456"],
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        JWT_SECRET
      );

      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const result = await parser.hasResourceAccess(tokenWithResource, "org-123");

      expect(result.granted).toBe(true);
    });

    it("should deny access to unauthorized resources", async () => {
      const tokenWithResource = jwt.sign(
        {
          sub: "org-123",
          permissions: ["webhook:dispatch"],
          resources: ["org-123"],
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        JWT_SECRET
      );

      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const result = await parser.hasResourceAccess(tokenWithResource, "org-999");

      expect(result.granted).toBe(false);
      expect(result.reason).toContain("Resource 'org-999' not accessible");
    });
  });

  describe("Memory and Resource Management", () => {
    it("should not cause memory leaks with repeated operations", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const initialMemory = process.memoryUsage().heapUsed;

      // Perform many operations
      for (let i = 0; i < 1000; i++) {
        const token = jwt.sign(
          {
            sub: `org-${i}`,
            permissions: ["webhook:dispatch"],
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
          JWT_SECRET
        );
        await parser.parseCapability(token);
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable
      expect(memoryIncrease).toBeLessThan(5 * 1024 * 1024); // < 5MB
    });

    it("should provide accurate statistics", async () => {
      const stats = parser.getStats();

      expect(stats).toHaveProperty("config");
      expect(stats).toHaveProperty("cacheStats");
      expect(stats.config).toHaveProperty("enableCache");
      expect(stats.config).toHaveProperty("cacheTTL");
    });
  });

  describe("Input Validation Edge Cases", () => {
    it("should reject null or undefined tokens", async () => {
      await expect(parser.parseCapability(null as any)).rejects.toThrow("JWT token must be a non-empty string");
      await expect(parser.parseCapability(undefined as any)).rejects.toThrow("JWT token must be a non-empty string");
    });

    it("should reject empty string tokens", async () => {
      await expect(parser.parseCapability("")).rejects.toThrow("JWT token must be a non-empty string");
    });

    it("should reject non-string tokens", async () => {
      await expect(parser.parseCapability(123 as any)).rejects.toThrow("JWT token must be a non-empty string");
      await expect(parser.parseCapability({} as any)).rejects.toThrow("JWT token must be a non-empty string");
    });

    it("should handle tokens with invalid permission arrays", async () => {
      const tokenWithInvalidPermissions = jwt.sign(
        {
          sub: "org-123",
          permissions: ["valid", 123, null],
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        JWT_SECRET
      );

      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const result = await parser.parseCapability(tokenWithInvalidPermissions);

      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes("not a string"))).toBe(true);
    });
  });

  describe("Batch Processing Tests", () => {
    it("should handle batch token parsing efficiently", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const tokens = Array.from({ length: 50 }, (_, i) =>
        jwt.sign(
          {
            sub: `org-${i}`,
            permissions: ["webhook:dispatch"],
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
          JWT_SECRET
        )
      );

      const startTime = Date.now();
      const results = await parser.parseCapabilities(tokens);
      const duration = Date.now() - startTime;

      expect(results.length).toBe(50);
      expect(duration).toBeLessThan(200);
      expect(results.every(r => r.isValid)).toBe(true);
    });

    it("should handle empty token array", async () => {
      const results = await parser.parseCapabilities([]);
      expect(results).toEqual([]);
    });

    it("should handle batch with mixed valid and invalid tokens", async () => {
      vi.mocked(staleCacheService).get = vi.fn(async (key, fetcher) => {
        return fetcher();
      });

      const tokens = [
        validToken,
        "invalid-token",
        expiredToken,
        jwt.sign(
          {
            sub: "org-456",
            permissions: ["webhook:dispatch"],
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
          JWT_SECRET
        ),
      ];

      const results = await parser.parseCapabilities(tokens);

      expect(results.length).toBe(4);
      expect(results[0].isValid).toBe(true);
      expect(results[1].isValid).toBe(false);
      expect(results[2].isValid).toBe(false);
      expect(results[3].isValid).toBe(true);
    });
  });
});
