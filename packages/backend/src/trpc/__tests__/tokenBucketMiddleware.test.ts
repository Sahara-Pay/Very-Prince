/**
 * @file tokenBucketMiddleware.test.ts
 * @description Tests for the token bucket middleware.
 */

import { describe, it, expect } from 'vitest';
import { calculateRequestCost } from '../tokenBucketMiddleware.js';
import { getRouteCostWeight } from '../../config/rateLimitConfig.js';

describe('TokenBucketMiddleware', () => {
  describe('calculateRequestCost', () => {
    it('should calculate cost for single route', () => {
      const result = calculateRequestCost('organization.get');

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].path).toBe('organization.get');
      expect(result.routes[0].weight).toBe(3);
      expect(result.totalCost).toBe(3);
    });

    it('should calculate cost for batched routes', () => {
      const result = calculateRequestCost('organization.get,stats.getTVL,contract.getStatus');

      expect(result.routes).toHaveLength(3);
      expect(result.totalCost).toBe(3 + 4 + 1); // 8 total
    });

    it('should handle routes with default weight', () => {
      const result = calculateRequestCost('unknown.route');

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].weight).toBe(5); // Default weight
      expect(result.totalCost).toBe(5);
    });

    it('should handle heavy analytical routes', () => {
      const result = calculateRequestCost('analytics.getLeaderboard');

      expect(result.routes).toHaveLength(1);
      expect(result.routes[0].weight).toBe(20);
      expect(result.totalCost).toBe(20);
    });

    it('should calculate mixed batch with light and heavy routes', () => {
      const result = calculateRequestCost(
        'contract.getStatus,analytics.getLeaderboard,stats.getTopMaintainers'
      );

      expect(result.routes).toHaveLength(3);
      expect(result.totalCost).toBe(1 + 20 + 15); // 36 total
    });

    it('should handle empty path gracefully', () => {
      const result = calculateRequestCost('');

      expect(result.routes).toHaveLength(1);
      expect(result.totalCost).toBe(5); // Default weight
    });
  });

  describe('Route cost weights', () => {
    it('should have low weight for health checks', () => {
      expect(getRouteCostWeight('contract.getStatus')).toBe(1);
      expect(getRouteCostWeight('contract.getDetails')).toBe(1);
    });

    it('should have medium weight for single entity queries', () => {
      expect(getRouteCostWeight('organization.get')).toBe(3);
      expect(getRouteCostWeight('organization.list')).toBe(5);
      expect(getRouteCostWeight('stats.getTVL')).toBe(4);
    });

    it('should have high weight for global stats', () => {
      expect(getRouteCostWeight('stats.getGlobalStats')).toBe(10);
      expect(getRouteCostWeight('stats.getTotalFundsRaised')).toBe(12);
      expect(getRouteCostWeight('stats.getTopMaintainers')).toBe(15);
    });

    it('should have very high weight for analytics', () => {
      expect(getRouteCostWeight('analytics.getLeaderboard')).toBe(20);
    });

    it('should have default weight for unconfigured routes', () => {
      expect(getRouteCostWeight('unknown.route')).toBe(5);
      expect(getRouteCostWeight('some.other.route')).toBe(5);
    });
  });

  describe('Cost weight ratios', () => {
    it('should penalize heavy routes more than light routes', () => {
      const lightWeight = getRouteCostWeight('contract.getStatus');
      const mediumWeight = getRouteCostWeight('organization.get');
      const heavyWeight = getRouteCostWeight('analytics.getLeaderboard');

      expect(heavyWeight / lightWeight).toBe(20); // 20x more expensive
      expect(heavyWeight / mediumWeight).toBeCloseTo(6.67, 1); // ~6.67x more expensive
    });

    it('should allow many light requests before heavy request', () => {
      const capacity = 100;
      const lightWeight = getRouteCostWeight('contract.getStatus');
      const heavyWeight = getRouteCostWeight('analytics.getLeaderboard');

      const lightRequests = Math.floor(capacity / lightWeight); // 100 light requests
      const heavyRequests = Math.floor(capacity / heavyWeight); // 5 heavy requests

      expect(lightRequests).toBeGreaterThan(heavyRequests * 10);
    });
  });
});
