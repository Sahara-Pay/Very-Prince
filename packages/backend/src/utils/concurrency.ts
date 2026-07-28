/**
 * @file concurrency.ts
 * @description Utility for running async work with a bounded concurrency limit.
 *
 * ## Why this exists
 * Fan-out patterns like `Promise.all(items.map(fetchOne))` fire every request
 * simultaneously with no cap. Against an external RPC (Soroban) or database,
 * this scales linearly with input size and can overwhelm connections once the
 * item count grows. `mapWithConcurrency` runs a fixed number of requests in
 * flight at a time instead.
 */

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);

  return results;
}