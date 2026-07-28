import { randomUUID } from "crypto";
import { redis } from "./cache.js";
import { logger } from "../utils/logger.js";

export class LockService {
  /**
   * Acquire a lock using a Redis NX PX set operation.
   *
   * @param key - Redis lock key
   * @param ttlMs - Time-to-live in milliseconds
   * @returns The token string if lock acquired, null otherwise
   */
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    try {
      const result = await (redis as any).set(key, token, "NX", "PX", ttlMs);
      if (result === "OK") {
        logger.info({ key, token, ttlMs }, "[LockService] Lock acquired");
        return token;
      }
      return null;
    } catch (error) {
      logger.error({ err: error, key }, "[LockService] Failed to acquire lock in Redis");
      return null;
    }
  }

  /**
   * Acquire a lock with retries and jittered backoff.
   */
  async acquireLockWithRetry(
    key: string,
    ttlMs: number,
    retries = 5,
    retryDelayMs = 150
  ): Promise<string | null> {
    for (let i = 0; i < retries; i++) {
      const token = await this.acquireLock(key, ttlMs);
      if (token) {
        return token;
      }
      if (i < retries - 1) {
        const jitter = Math.random() * 50;
        const delay = retryDelayMs + jitter;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    logger.warn({ key, retries }, "[LockService] Max retries reached, failed to acquire lock");
    return null;
  }

  /**
   * Release a lock using a safe Lua script.
   */
  async releaseLock(key: string, token: string): Promise<boolean> {
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    try {
      const result = await redis.eval(luaScript, 1, key, token);
      const released = result === 1;
      if (released) {
        logger.info({ key, token }, "[LockService] Lock released");
      } else {
        logger.warn({ key, token }, "[LockService] Failed to release lock (token mismatch or expired)");
      }
      return released;
    } catch (error) {
      logger.error({ err: error, key, token }, "[LockService] Error executing lock release script");
      return false;
    }
  }
}

export const lockService = new LockService();
