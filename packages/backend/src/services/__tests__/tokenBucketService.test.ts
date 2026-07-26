/**
 * @file tokenBucketService.test.ts
 * @description Tests for the Redis-backed token bucket rate limiter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkTokenBucket, resetBucket, getBucketState } from '../tokenBucketService.js';
import { redis } from '../cache.js';

describe('TokenBucketService', () => {
  const testIdentifier = 'test-ip-127.0.0.1';
  const testConfig = {
    capacity: 100,
    refillRate: 10, // 10 tokens per second
    keyPrefix: 'test:ratelimit:token_bucket',
  };

  beforeEach(async () => {
    // Clean up test bucket before each test
    await resetBucket(testIdentifier, testConfig);
  });

  afterEach(async () => {
    // Clean up after each test
    await resetBucket(testIdentifier, testConfig);
  });

  describe('checkTokenBucket', () => {
    it('should allow request when bucket is full', async () => {
      const result = await checkTokenBucket(testIdentifier, 10, testConfig);

      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(90);
      expect(result.retryAfter).toBe(0);
      expect(result.cost).toBe(10);
    });

    it('should deny request when cost exceeds available tokens', async () => {
      // Consume 95 tokens
      await checkTokenBucket(testIdentifier, 95, testConfig);

      // Try to consume 10 more (only 5 remain)
      const result = await checkTokenBucket(testIdentifier, 10, testConfig);

      expect(result.allowed).toBe(false);
      expect(result.remainingTokens).toBe(5);
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.cost).toBe(10);
    });

    it('should deduct tokens correctly across multiple requests', async () => {
      const result1 = await checkTokenBucket(testIdentifier, 20, testConfig);
      expect(result1.allowed).toBe(true);
      expect(result1.remainingTokens).toBe(80);

      const result2 = await checkTokenBucket(testIdentifier, 30, testConfig);
      expect(result2.allowed).toBe(true);
      expect(result2.remainingTokens).toBe(50);

      const result3 = await checkTokenBucket(testIdentifier, 40, testConfig);
      expect(result3.allowed).toBe(true);
      expect(result3.remainingTokens).toBe(10);

      // This should be denied
      const result4 = await checkTokenBucket(testIdentifier, 20, testConfig);
      expect(result4.allowed).toBe(false);
      expect(result4.remainingTokens).toBe(10);
    });

    it('should refill tokens over time', async () => {
      // Consume 90 tokens
      const result1 = await checkTokenBucket(testIdentifier, 90, testConfig);
      expect(result1.remainingTokens).toBe(10);

      // Wait 2 seconds (should refill 20 tokens: 10 tokens/sec * 2 sec)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Try to consume 25 tokens (should have ~30 now: 10 + 20)
      const result2 = await checkTokenBucket(testIdentifier, 25, testConfig);
      expect(result2.allowed).toBe(true);
      expect(result2.remainingTokens).toBeGreaterThanOrEqual(5);
      expect(result2.remainingTokens).toBeLessThanOrEqual(10); // Allow some timing variance
    }, 10000);

    it('should not exceed capacity after refill', async () => {
      // Wait 20 seconds with full bucket (should not exceed 100)
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const result = await checkTokenBucket(testIdentifier, 1, testConfig);
      expect(result.remainingTokens).toBe(99);
    }, 10000);

    it('should calculate correct retry-after time', async () => {
      // Consume all tokens
      await checkTokenBucket(testIdentifier, 100, testConfig);

      // Try to consume 50 tokens (need to wait ~5 seconds: 50/10)
      const result = await checkTokenBucket(testIdentifier, 50, testConfig);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThanOrEqual(4);
      expect(result.retryAfter).toBeLessThanOrEqual(6); // Allow some variance
    });

    it('should handle different cost weights', async () => {
      // Lightweight request
      const result1 = await checkTokenBucket(testIdentifier, 1, testConfig);
      expect(result1.allowed).toBe(true);
      expect(result1.remainingTokens).toBe(99);

      // Heavy request
      const result2 = await checkTokenBucket(testIdentifier, 50, testConfig);
      expect(result2.allowed).toBe(true);
      expect(result2.remainingTokens).toBe(49);

      // Another heavy request (should be denied)
      const result3 = await checkTokenBucket(testIdentifier, 50, testConfig);
      expect(result3.allowed).toBe(false);
    });
  });

  describe('getBucketState', () => {
    it('should return null for non-existent bucket', async () => {
      const state = await getBucketState('non-existent-bucket', testConfig);
      expect(state).toBeNull();
    });

    it('should return correct bucket state after deduction', async () => {
      await checkTokenBucket(testIdentifier, 30, testConfig);

      const state = await getBucketState(testIdentifier, testConfig);
      expect(state).not.toBeNull();
      expect(state!.tokens).toBe(70);
      expect(state!.lastRefill).toBeGreaterThan(0);
    });
  });

  describe('resetBucket', () => {
    it('should reset bucket to initial state', async () => {
      // Consume tokens
      await checkTokenBucket(testIdentifier, 50, testConfig);

      // Reset
      await resetBucket(testIdentifier, testConfig);

      // Check if reset (should have full capacity)
      const result = await checkTokenBucket(testIdentifier, 1, testConfig);
      expect(result.remainingTokens).toBe(99);
    });
  });

  describe('Distributed behavior', () => {
    it('should work across multiple identifiers', async () => {
      const identifier1 = 'user-1';
      const identifier2 = 'user-2';

      // User 1 consumes 80 tokens
      const result1 = await checkTokenBucket(identifier1, 80, testConfig);
      expect(result1.allowed).toBe(true);
      expect(result1.remainingTokens).toBe(20);

      // User 2 should still have full bucket
      const result2 = await checkTokenBucket(identifier2, 80, testConfig);
      expect(result2.allowed).toBe(true);
      expect(result2.remainingTokens).toBe(20);

      // Clean up
      await resetBucket(identifier1, testConfig);
      await resetBucket(identifier2, testConfig);
    });
  });

  describe('Edge cases', () => {
    it('should handle zero cost requests', async () => {
      const result = await checkTokenBucket(testIdentifier, 0, testConfig);
      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(100);
    });

    it('should handle cost exactly equal to capacity', async () => {
      const result = await checkTokenBucket(testIdentifier, 100, testConfig);
      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(0);
    });

    it('should handle cost greater than capacity', async () => {
      const result = await checkTokenBucket(testIdentifier, 150, testConfig);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });
  });
});
