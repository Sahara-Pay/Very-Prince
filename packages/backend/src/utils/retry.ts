/**
 * @file retry.ts
 * @description Utility for exponential backoff and retries.
 * 
 * ## Retry Logic
 * In a distributed system, network operations can fail for various reasons 
 * (rate limiting, transient outages, high latency). This utility provides a 
 * standard way to retry failed asynchronous operations with exponential 
 * backoff, reducing the load on the destination server during high traffic.
 * 
 * ## Exponential Backoff
 * The delay between retries increases exponentially (e.g., 2s, 4s, 8s, 16s...) 
 * to allow the remote system time to recover.
 */

/**
 * Executes an asynchronous function with retry logic on 429 errors.
 * 
 * @param fn - The asynchronous function to execute.
 * @param options - Configuration for the retry behavior.
 * @returns The result of the successful function call.
 * @throws The last encountered error if all retries fail, or the initial error 
 *          if it's not a retryable error (non-429).
 */
import { logger } from "./logger.js";

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    /** Maximum number of attempts before giving up (default: 5). */
    maxRetries?: number;
    /** The initial delay in milliseconds for the first retry (default: 2000). */
    initialDelay?: number;
    /** Optional callback executed on each retry attempt. */
    onRetry?: (error: any, attempt: number) => void;
  } = {}
): Promise<T> {
  const { maxRetries = 5, initialDelay = 2000, onRetry } = options;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error: any) {
      // Extract status code from various possible error structures
      const status = error?.response?.status || error?.status;
      
      // Only retry on 429 Too Many Requests (Rate Limiting)
      // This is the standard behavior for Stellar Horizon and Soroban RPC.
      if (status === 429 && attempt < maxRetries - 1) {
        attempt++;
        // Calculate exponential delay: initialDelay * 2^(attempt-1)
        const delay = initialDelay * Math.pow(2, attempt - 1); 
        
        if (onRetry) {
          onRetry(error, attempt);
        } else {
          logger.warn({ delay, attempt, maxRetries }, "[Retry] Rate limited (429), retrying");
        }
        
        // Non-blocking sleep before next attempt
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      
      // Rethrow if not a 429 or if we've reached the max retries
      throw error;
    }
  }
  
  throw new Error(`Max retries (${maxRetries}) reached`);
}
