/**
 * @file tokenBucketService.ts
 * @description Redis-backed token bucket rate limiter with atomic token deduction.
 * 
 * This service implements a distributed token bucket algorithm where each request
 * consumes tokens based on its computational weight. Heavy analytical queries
 * consume more tokens than lightweight operations, protecting backend resources
 * from asymmetric DoS attacks.
 * 
 * Features:
 * - Atomic token deduction via Lua scripts (prevents race conditions)
 * - Distributed state in Redis (works across multiple backend instances)
 * - Dynamic cost weights based on tRPC route meta-tags
 * - Automatic token refill at configurable rate
 * - Strict RFC-compliant 429 responses with Retry-After headers
 */

import { redis } from './cache.js';
import { logger } from '../utils/logger.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Token bucket configuration per identifier (typically IP address or API key).
 */
export interface TokenBucketConfig {
  /** Maximum tokens in the bucket */
  capacity: number;
  /** Tokens added per second */
  refillRate: number;
  /** Redis key prefix */
  keyPrefix: string;
}

/**
 * Result of a token bucket check.
 */
export interface TokenBucketResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining tokens in the bucket */
  remainingTokens: number;
  /** Seconds until enough tokens are available (0 if allowed) */
  retryAfter: number;
  /** Cost of the request */
  cost: number;
}

/**
 * Default configuration for the token bucket.
 * Adjust these values based on your capacity planning.
 */
const DEFAULT_CONFIG: TokenBucketConfig = {
  capacity: 100, // 100 tokens per bucket
  refillRate: 10, // 10 tokens per second (600 per minute)
  keyPrefix: 'ratelimit:token_bucket',
};

let luaScript: string | null = null;
let luaSha: string | null = null;

/**
 * Load and cache the Lua script for atomic token deduction.
 */
async function loadLuaScript(): Promise<string> {
  if (luaScript) return luaScript;
  
  try {
    const scriptPath = join(__dirname, '..', 'redis', 'tokenBucket.lua');
    luaScript = await readFile(scriptPath, 'utf-8');
    return luaScript;
  } catch (error) {
    logger.error({ err: error }, 'Failed to load token bucket Lua script');
    throw new Error('Token bucket Lua script not found');
  }
}

/**
 * Load the Lua script into Redis and cache the SHA.
 */
async function ensureLuaScriptLoaded(): Promise<string> {
  if (luaSha) return luaSha;
  
  const script = await loadLuaScript();
  try {
    luaSha = await redis.script('LOAD', script);
    logger.info({ sha: luaSha }, 'Token bucket Lua script loaded into Redis');
    return luaSha;
  } catch (error) {
    logger.error({ err: error }, 'Failed to load Lua script into Redis');
    throw error;
  }
}

/**
 * Check if a request is allowed under the token bucket rate limit.
 * 
 * @param identifier - Unique identifier for the bucket (e.g., IP address)
 * @param cost - Number of tokens to deduct (based on request weight)
 * @param config - Optional configuration override
 * @returns Token bucket result with allow/deny decision
 */
export async function checkTokenBucket(
  identifier: string,
  cost: number,
  config: Partial<TokenBucketConfig> = {},
): Promise<TokenBucketResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const bucketKey = `${cfg.keyPrefix}:${identifier}`;
  const currentTime = Math.floor(Date.now() / 1000);

  try {
    // Ensure Lua script is loaded
    const sha = await ensureLuaScriptLoaded();

    // Execute Lua script atomically
    const result = await redis.evalsha(
      sha,
      1,
      bucketKey,
      cost.toString(),
      cfg.capacity.toString(),
      cfg.refillRate.toString(),
      currentTime.toString(),
    ) as [number, number, number];

    const [allowed, remainingTokens, retryAfter] = result;

    const bucketResult: TokenBucketResult = {
      allowed: allowed === 1,
      remainingTokens: Math.max(0, remainingTokens),
      retryAfter,
      cost,
    };

    if (!bucketResult.allowed) {
      logger.warn(
        {
          identifier,
          cost,
          remainingTokens: bucketResult.remainingTokens,
          retryAfter: bucketResult.retryAfter,
        },
        'Token bucket rate limit exceeded',
      );
    }

    return bucketResult;
  } catch (error) {
    // If Lua script is not loaded (e.g., Redis restart), reload it
    if (error instanceof Error && error.message.includes('NOSCRIPT')) {
      logger.warn('Lua script not found in Redis, reloading...');
      luaSha = null;
      return checkTokenBucket(identifier, cost, config);
    }

    logger.error(
      { err: error, identifier, cost },
      'Token bucket check failed, allowing request by default',
    );

    // Fail open: allow the request if Redis is unavailable
    return {
      allowed: true,
      remainingTokens: cfg.capacity,
      retryAfter: 0,
      cost,
    };
  }
}

/**
 * Get current bucket state without deducting tokens.
 * Useful for debugging and monitoring.
 */
export async function getBucketState(
  identifier: string,
  config: Partial<TokenBucketConfig> = {},
): Promise<{ tokens: number; lastRefill: number } | null> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const bucketKey = `${cfg.keyPrefix}:${identifier}`;

  try {
    const result = await redis.hmget(bucketKey, 'tokens', 'lastRefill');
    if (!result[0] || !result[1]) return null;

    return {
      tokens: parseFloat(result[0]),
      lastRefill: parseInt(result[1], 10),
    };
  } catch (error) {
    logger.error({ err: error, identifier }, 'Failed to get bucket state');
    return null;
  }
}

/**
 * Reset a token bucket for a specific identifier.
 * Useful for testing and manual intervention.
 */
export async function resetBucket(
  identifier: string,
  config: Partial<TokenBucketConfig> = {},
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const bucketKey = `${cfg.keyPrefix}:${identifier}`;

  try {
    await redis.del(bucketKey);
    logger.info({ identifier }, 'Token bucket reset');
  } catch (error) {
    logger.error({ err: error, identifier }, 'Failed to reset token bucket');
  }
}
