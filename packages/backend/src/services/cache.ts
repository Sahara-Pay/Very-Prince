/**
 * @file cache.ts
 * @description Centralized Redis caching service.
 * 
 * This service provides a wrapper around the `ioredis` client to ensure that 
 * the application remains resilient even if the Redis server is unavailable.
 * 
 * ## Resiliency Strategy
 * All methods are prefixed with `safe` (e.g., `safeGet`, `safeSet`) and 
 * wrap their respective Redis calls in `try/catch` blocks. If a Redis 
 * operation fails, the error is logged, but the application execution 
 * continues by returning `null` or silently failing. This is critical for 
 * maintaining high availability in production.
 */

import { Redis } from "ioredis";
import { logger } from "../utils/logger.js";


// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * The Redis connection string.
 * Defaults to localhost if not provided in the environment.
 */
const REDIS_URL = process.env["REDIS_URL"] || "redis://localhost:6379";

/**
 * Singleton Redis client instance.
 * 
 * Configuration:
 * - maxRetriesPerRequest: 1 - Ensures that requests fail quickly if the 
 *   connection is lost, preventing a backlog of pending promises.
 * - retryStrategy: Implements a custom backoff strategy with a maximum of 3 retries.
 */
export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1, 
  retryStrategy(times) {
    if (times > 3) return null; 
    return Math.min(times * 100, 3000);
  },
});

export const bullRedisConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

// ─── Event Listeners ─────────────────────────────────────────────────────────

redis.on("error", (err) => {
  logger.error({ err }, "Redis error");
});

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Safely retrieve a value from Redis.
 * 
 * @param key - The unique identifier for the cached data.
 * @returns The cached string value, or `null` if the key does not exist or Redis is down.
 */
export async function safeGet(key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch (error) {
    logger.error({ err: error, key }, "Redis safeGet failed");
    return null;
  }
}

/**
 * Safely store a value in Redis with an expiration time.
 * 
 * @param key - The unique identifier for the data.
 * @param value - The string content to be cached (typically JSON).
 * @param ttlSeconds - Time-to-live in seconds.
 */
export async function safeSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, value, "EX", ttlSeconds);
  } catch (error) {
    logger.error({ err: error, key }, "Redis safeSet failed");
  }
}

/**
 * Safely delete a single Redis key.
 */
export async function safeDel(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (error) {
    logger.error({ err: error, key }, "Redis safeDel failed");
  }
}

/**
 * Safely delete all keys matching a prefix (e.g. `stats:funds-raised:`).
 */
export async function safeDelByPrefix(prefix: string): Promise<void> {
  try {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (error) {
    logger.error({ err: error, prefix }, "Redis safeDelByPrefix failed");
  }
}

/**
 * Read-through Redis cache for async fetchers.
 * Returns cached JSON when present; otherwise fetches, stores, and returns.
 */
export async function withRedisCache<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = await safeGet(key);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as T;
    } catch (error) {
      logger.warn({ err: error, key }, "Cache corruption detected");
    }
  }

  const result = await fetcher();
  void safeSet(key, JSON.stringify(result), ttlSeconds);
  return result;
}
