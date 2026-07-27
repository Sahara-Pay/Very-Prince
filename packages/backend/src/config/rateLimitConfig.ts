/**
 * @file rateLimitConfig.ts
 * @description Configuration for dynamic token bucket rate limiting.
 * 
 * This file defines the cost weights for different tRPC routes. Each route
 * is assigned a cost weight that reflects its computational intensity:
 * 
 * - Weight 1: Lightweight operations (health checks, simple queries)
 * - Weight 3-5: Medium complexity (single org queries, basic stats)
 * - Weight 10-20: Heavy operations (global stats, leaderboards, complex analytics)
 * - Weight 30+: Very heavy operations (full exports, complex aggregations)
 * 
 * These weights are used by the token bucket middleware to determine how many
 * tokens to deduct per request.
 */

export interface RouteCostWeight {
  /** tRPC route path (e.g., "organization.get") */
  route: string;
  /** Cost weight (tokens consumed per request) */
  weight: number;
  /** Description of why this weight was assigned */
  description: string;
}

/**
 * Cost weights for tRPC routes.
 * Routes not listed here default to weight 5.
 */
export const ROUTE_COST_WEIGHTS: RouteCostWeight[] = [
  // ─── Lightweight Operations (Weight: 1) ──────────────────────────────────
  {
    route: 'contract.getStatus',
    weight: 1,
    description: 'Simple health check, no database access',
  },
  {
    route: 'contract.getDetails',
    weight: 1,
    description: 'Cached contract metadata',
  },

  // ─── Medium Complexity - Single Entity Queries (Weight: 3-5) ────────────
  {
    route: 'organization.get',
    weight: 3,
    description: 'Single organization lookup with caching',
  },
  {
    route: 'organization.list',
    weight: 5,
    description: 'Paginated list with cursor, moderate DB load',
  },
  {
    route: 'stats.getTVL',
    weight: 4,
    description: 'Cached TVL calculation',
  },
  {
    route: 'stats.getFundingHistory',
    weight: 5,
    description: 'Single org funding history, moderate complexity',
  },

  // ─── Heavy Operations - Global Stats & Analytics (Weight: 10-20) ────────
  {
    route: 'stats.getGlobalStats',
    weight: 10,
    description: 'Aggregates data across all organizations',
  },
  {
    route: 'stats.getTotalFundsRaised',
    weight: 12,
    description: 'Time-range aggregation with potential date filtering',
  },
  {
    route: 'stats.getTopMaintainers',
    weight: 15,
    description: 'Complex ranking query across all maintainers',
  },
  {
    route: 'analytics.getLeaderboard',
    weight: 20,
    description: 'Complex multi-dimensional leaderboard calculation',
  },

  // ─── Mutations (Weight: 5-8) ─────────────────────────────────────────────
  {
    route: 'transaction.validateFundOrg',
    weight: 5,
    description: 'Contract state validation',
  },
  {
    route: 'transaction.validateAllocatePayout',
    weight: 6,
    description: 'Multi-step validation with organization check',
  },
  {
    route: 'transaction.validateClaimPayout',
    weight: 4,
    description: 'Simple claim validation',
  },
  {
    route: 'organization.create',
    weight: 8,
    description: 'Contract write operation with validation',
  },

  // ─── Sync Operations (Weight: 10-25) ────────────────────────────────────
  {
    route: 'sync.forceSync',
    weight: 25,
    description: 'Heavy blockchain sync operation',
  },
  {
    route: 'sync.getSyncStatus',
    weight: 3,
    description: 'Lightweight status check',
  },
];

/**
 * Default cost weight for routes not explicitly configured.
 */
export const DEFAULT_ROUTE_WEIGHT = 5;

/**
 * Get the cost weight for a tRPC route.
 * 
 * @param routePath - Full tRPC route path (e.g., "organization.get")
 * @returns Cost weight for the route
 */
export function getRouteCostWeight(routePath: string): number {
  const config = ROUTE_COST_WEIGHTS.find((w) => w.route === routePath);
  return config ? config.weight : DEFAULT_ROUTE_WEIGHT;
}

/**
 * Token bucket rate limiter configuration.
 */
export interface TokenBucketRateLimitConfig {
  /** Enable/disable token bucket rate limiting */
  enabled: boolean;
  /** Maximum tokens per bucket (per identifier) */
  capacity: number;
  /** Tokens added per second */
  refillRate: number;
  /** Log rejected requests */
  logRejections: boolean;
  /** Extract identifier from request (defaults to IP address) */
  identifierExtractor?: (request: any) => string;
}

/**
 * Global token bucket configuration.
 * Adjust these values based on your capacity planning.
 * 
 * Environment variables:
 * - RATE_LIMIT_ENABLED: Enable/disable token bucket (default: true)
 * - RATE_LIMIT_CAPACITY: Maximum tokens per bucket (default: 100)
 * - RATE_LIMIT_REFILL_RATE: Tokens added per second (default: 10)
 * - RATE_LIMIT_LOG_REJECTIONS: Log rejected requests (default: true)
 */
export const tokenBucketConfig: TokenBucketRateLimitConfig = {
  enabled: process.env['RATE_LIMIT_ENABLED'] !== 'false',
  capacity: parseInt(process.env['RATE_LIMIT_CAPACITY'] || '100', 10),
  refillRate: parseInt(process.env['RATE_LIMIT_REFILL_RATE'] || '10', 10),
  logRejections: process.env['RATE_LIMIT_LOG_REJECTIONS'] !== 'false',
};

/**
 * Extract identifier from request (IP address by default).
 * Can be overridden to use API keys or user IDs.
 */
export function extractIdentifier(request: any): string {
  // Try X-Forwarded-For first (for proxied requests)
  const forwarded = request.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',');
    return ips[0].trim();
  }

  // Fall back to direct IP
  return request.ip || request.socket?.remoteAddress || 'unknown';
}
