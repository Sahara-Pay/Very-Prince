/**
 * @file staleCache.ts
 * @description Stale cache service with probabilistic eviction for high-throughput webhook ingestion.
 *
 * This service implements a stale-while-revalidate pattern with probabilistic eviction to:
 * - Serve stale data immediately to avoid blocking the event loop
 * - Refresh cache entries asynchronously in the background
 * - Use probabilistic logic to determine when to refresh vs serve stale
 * - Maintain state consistency during heavy Web3 block finalization spikes
 *
 * ## Design Rationale
 *
 * During heavy webhook ingestion (e.g., block finalization spikes), synchronous cache
 * refreshes can block the Node.js event loop. This service:
 * 1. Returns stale data if available (immediate response)
 * 2. Probabilistically decides whether to refresh in background
 * 3. Uses the existing Count-Min Sketch for access frequency tracking
 * 4. Ensures non-blocking operations for all cache interactions
 *
 * ## Probabilistic Refresh Strategy
 *
 * - Hot keys (high frequency): Higher probability of background refresh
 * - Cold keys (low frequency): Lower probability, serve stale longer
 * - Stale threshold: Configurable max age before forced refresh
 * - Refresh probability: Computed based on access frequency and staleness
 */

import { safeGet, safeSet } from "./cache.js";
import { evictionEngine } from "./probabilisticEviction.js";
import { logger } from "../utils/logger.js";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface StaleCacheConfig {
  /**
   * Maximum age (ms) before data is considered stale.
   * Default: 30000 (30 seconds)
   */
  staleThresholdMs?: number;
  /**
   * Maximum age (ms) before data is considered expired and must be refreshed.
   * Default: 300000 (5 minutes)
   */
  expireThresholdMs?: number;
  /**
   * Base probability (0-1) of refreshing a stale entry.
   * Adjusted by access frequency. Default: 0.3
   */
  baseRefreshProbability?: number;
  /**
   * TTL for fresh cache entries (seconds).
   * Default: 60
   */
  defaultTTL?: number;
  /**
   * Whether to enable probabilistic refresh.
   * Default: true
   */
  enableProbabilisticRefresh?: boolean;
}

const DEFAULT_CONFIG: Required<StaleCacheConfig> = {
  staleThresholdMs: 30000,
  expireThresholdMs: 300000,
  baseRefreshProbability: 0.3,
  defaultTTL: 60,
  enableProbabilisticRefresh: true,
};

// ─── Cache Entry Metadata ─────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  version: number;
}

interface CacheMetadata {
  timestamp: number;
  version: number;
}

// ─── Stale Cache Service ──────────────────────────────────────────────────────

export class StaleCacheService {
  private readonly config: Required<StaleCacheConfig>;
  private readonly pendingRefreshes = new Map<string, Promise<void>>();

  constructor(config: StaleCacheConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get cached data with stale-while-revalidate semantics.
   *
   * Returns stale data immediately if available, then probabilistically
   * refreshes in the background. Never blocks the event loop.
   *
   * @param key - Cache key
   * @param fetcher - Async function to fetch fresh data
   * @param options - Override default config for this operation
   * @returns Cached data (stale or fresh) or fresh data if cache miss
   */
  async get<T>(
    key: string,
    fetcher: () => Promise<T>,
    options?: StaleCacheConfig
  ): Promise<T> {
    // Input validation
    if (!key || typeof key !== "string") {
      throw new Error("Cache key must be a non-empty string");
    }
    if (typeof fetcher !== "function") {
      throw new Error("Fetcher must be a function");
    }

    const effectiveConfig = { ...this.config, ...options };
    
    // Validate config
    if (effectiveConfig.staleThresholdMs < 0) {
      throw new Error("staleThresholdMs must be non-negative");
    }
    if (effectiveConfig.expireThresholdMs < effectiveConfig.staleThresholdMs) {
      throw new Error("expireThresholdMs must be >= staleThresholdMs");
    }
    if (effectiveConfig.baseRefreshProbability < 0 || effectiveConfig.baseRefreshProbability > 1) {
      throw new Error("baseRefreshProbability must be in [0, 1]");
    }
    if (effectiveConfig.defaultTTL <= 0) {
      throw new Error("defaultTTL must be positive");
    }

    const cacheKey = this._buildCacheKey(key);
    const metaKey = this._buildMetaKey(key);

    try {
      // Try to get cached entry
      const cached = await safeGet(cacheKey);
      const metaStr = await safeGet(metaKey);

      if (cached !== null && metaStr !== null) {
        let meta: CacheMetadata;
        try {
          meta = JSON.parse(metaStr) as CacheMetadata;
        } catch (parseError) {
          logger.warn({ err: parseError, key }, "Cache metadata corrupted, forcing refresh");
          return this._forceRefresh(key, cacheKey, metaKey, fetcher, effectiveConfig);
        }

        // Validate metadata structure
        if (!meta || typeof meta.timestamp !== "number" || typeof meta.version !== "number") {
          logger.warn({ key, meta }, "Invalid cache metadata structure, forcing refresh");
          return this._forceRefresh(key, cacheKey, metaKey, fetcher, effectiveConfig);
        }

        const now = Date.now();
        const age = now - meta.timestamp;

        // Record access for probabilistic eviction engine
        evictionEngine.recordAccess(key);

        // Check if data is expired (must refresh)
        if (age > effectiveConfig.expireThresholdMs) {
          logger.debug({ key, age }, "Cache entry expired, forcing refresh");
          return this._forceRefresh(key, cacheKey, metaKey, fetcher, effectiveConfig);
        }

        // Data is stale but usable
        if (age > effectiveConfig.staleThresholdMs) {
          const shouldRefresh = this._shouldRefresh(key, age, effectiveConfig);
          
          if (shouldRefresh) {
            // Trigger background refresh without blocking
            this._backgroundRefresh(key, cacheKey, metaKey, fetcher, effectiveConfig);
          }

          // Return stale data immediately
          logger.debug({ key, age }, "Returning stale data");
          try {
            return JSON.parse(cached) as T;
          } catch (parseError) {
            logger.warn({ err: parseError, key }, "Cache data corrupted, forcing refresh");
            return this._forceRefresh(key, cacheKey, metaKey, fetcher, effectiveConfig);
          }
        }

        // Data is fresh
        logger.debug({ key, age }, "Cache hit (fresh)");
        try {
          return JSON.parse(cached) as T;
        } catch (parseError) {
          logger.warn({ err: parseError, key }, "Cache data corrupted, forcing refresh");
          return this._forceRefresh(key, cacheKey, metaKey, fetcher, effectiveConfig);
        }
      }

      // Cache miss - fetch fresh data
      logger.debug({ key }, "Cache miss, fetching fresh data");
      return this._forceRefresh(key, cacheKey, metaKey, fetcher, effectiveConfig);
    } catch (error) {
      logger.error({ err: error, key }, "Stale cache get failed, falling back to fetcher");
      // On any error, fall back to fetcher
      try {
        return await fetcher();
      } catch (fetcherError) {
        logger.error({ err: fetcherError, key }, "Fetcher also failed, propagating error");
        throw fetcherError;
      }
    }
  }

  /**
   * Set data in cache with metadata.
   *
   * @param key - Cache key
   * @param data - Data to cache
   * @param ttl - TTL in seconds (overrides default)
   */
  async set<T>(key: string, data: T, ttl?: number): Promise<void> {
    // Input validation
    if (!key || typeof key !== "string") {
      throw new Error("Cache key must be a non-empty string");
    }
    if (data === undefined) {
      throw new Error("Cannot cache undefined value");
    }
    if (ttl !== undefined && (ttl <= 0 || !Number.isFinite(ttl))) {
      throw new Error("TTL must be a positive number");
    }

    const cacheKey = this._buildCacheKey(key);
    const metaKey = this._buildMetaKey(key);
    const effectiveTTL = ttl ?? this.config.defaultTTL;

    try {
      const entry: CacheEntry<T> = {
        data,
        timestamp: Date.now(),
        version: 1,
      };

      const meta: CacheMetadata = {
        timestamp: entry.timestamp,
        version: entry.version,
      };

      await Promise.all([
        safeSet(cacheKey, JSON.stringify(entry.data), effectiveTTL),
        safeSet(metaKey, JSON.stringify(meta), effectiveTTL),
      ]);

      // Record write for probabilistic eviction
      evictionEngine.recordAccess(key);
    } catch (error) {
      logger.error({ err: error, key }, "Stale cache set failed");
    }
  }

  /**
   * Invalidate a cache entry.
   */
  async invalidate(key: string): Promise<void> {
    // Input validation
    if (!key || typeof key !== "string") {
      throw new Error("Cache key must be a non-empty string");
    }

    const cacheKey = this._buildCacheKey(key);
    const metaKey = this._buildMetaKey(key);

    try {
      const { safeDel } = await import("./cache.js");
      await Promise.all([safeDel(cacheKey), safeDel(metaKey)]);
      
      // Remove from pending refreshes if present
      this.pendingRefreshes.delete(key);
    } catch (error) {
      logger.error({ err: error, key }, "Stale cache invalidate failed");
    }
  }

  /**
   * Get cache statistics for monitoring.
   */
  getStats() {
    return {
      pendingRefreshes: this.pendingRefreshes.size,
      config: this.config,
      evictionEngine: {
        memoryBytes: evictionEngine.memoryBytes,
        totalAccesses: evictionEngine.totalAccesses,
      },
    };
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  private _buildCacheKey(key: string): string {
    return `stale:${key}`;
  }

  private _buildMetaKey(key: string): string {
    return `stale:meta:${key}`;
  }

  /**
   * Force a synchronous refresh (used for cache misses or expired entries).
   */
  private async _forceRefresh<T>(
    key: string,
    cacheKey: string,
    metaKey: string,
    fetcher: () => Promise<T>,
    config: Required<StaleCacheConfig>
  ): Promise<T> {
    const data = await fetcher();
    await this._storeEntry(cacheKey, metaKey, data, config.defaultTTL);
    return data;
  }

  /**
   * Trigger an asynchronous background refresh.
   * Multiple concurrent refreshes for the same key are deduplicated.
   */
  private _backgroundRefresh<T>(
    key: string,
    cacheKey: string,
    metaKey: string,
    fetcher: () => Promise<T>,
    config: Required<StaleCacheConfig>
  ): void {
    // Deduplicate concurrent refreshes
    if (this.pendingRefreshes.has(key)) {
      return;
    }

    const refreshPromise = (async () => {
      try {
        const data = await fetcher();
        await this._storeEntry(cacheKey, metaKey, data, config.defaultTTL);
        logger.debug({ key }, "Background refresh completed");
      } catch (error) {
        logger.error({ err: error, key }, "Background refresh failed");
      } finally {
        this.pendingRefreshes.delete(key);
      }
    })();

    this.pendingRefreshes.set(key, refreshPromise);
  }

  /**
   * Store an entry in cache with metadata.
   */
  private async _storeEntry<T>(
    cacheKey: string,
    metaKey: string,
    data: T,
    ttl: number
  ): Promise<void> {
    const meta: CacheMetadata = {
      timestamp: Date.now(),
      version: 1,
    };

    await Promise.all([
      safeSet(cacheKey, JSON.stringify(data), ttl),
      safeSet(metaKey, JSON.stringify(meta), ttl),
    ]);
  }

  /**
   * Determine whether to refresh a stale entry based on:
   * - Access frequency (from Count-Min Sketch)
   * - Staleness (age vs thresholds)
   * - Base refresh probability
   */
  private _shouldRefresh(
    key: string,
    age: number,
    config: Required<StaleCacheConfig>
  ): boolean {
    if (!config.enableProbabilisticRefresh) {
      return true;
    }

    // Get frequency score from probabilistic eviction engine
    const frequency = evictionEngine.getFrequency(key);
    const totalAccesses = evictionEngine.totalAccesses;
    
    // Normalize frequency to [0, 1]
    const frequencyScore = totalAccesses > 0 
      ? Math.min(frequency / totalAccesses, 1) 
      : 0;

    // Calculate staleness score (0 = fresh, 1 = at expire threshold)
    const stalenessScore = Math.min(
      (age - config.staleThresholdMs) / 
      (config.expireThresholdMs - config.staleThresholdMs),
      1
    );

    // Combine frequency and staleness for refresh probability
    // Hot keys and stale data have higher refresh probability
    const refreshProbability = config.baseRefreshProbability 
      + (frequencyScore * 0.4) 
      + (stalenessScore * 0.3);

    // Cap at 1.0
    const finalProbability = Math.min(refreshProbability, 1.0);

    // Probabilistic decision
    return Math.random() < finalProbability;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

/**
 * Global singleton for the stale cache service.
 * Configuration can be overridden via environment variables:
 *
 *   STALE_CACHE_THRESHOLD_MS  — Stale threshold (default 30000)
 *   STALE_CACHE_EXPIRE_MS     — Expire threshold (default 300000)
 *   STALE_CACHE_REFRESH_PROB  — Base refresh probability (default 0.3)
 *   STALE_CACHE_DEFAULT_TTL   — Default TTL in seconds (default 60)
 */
export const staleCacheService = new StaleCacheService({
  staleThresholdMs: parseInt(process.env["STALE_CACHE_THRESHOLD_MS"] ?? "30000", 10),
  expireThresholdMs: parseInt(process.env["STALE_CACHE_EXPIRE_MS"] ?? "300000", 10),
  baseRefreshProbability: parseFloat(process.env["STALE_CACHE_REFRESH_PROB"] ?? "0.3"),
  defaultTTL: parseInt(process.env["STALE_CACHE_DEFAULT_TTL"] ?? "60", 10),
  enableProbabilisticRefresh: process.env["STALE_CACHE_ENABLE_REFRESH"] !== "false",
});
