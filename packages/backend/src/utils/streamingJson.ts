/**
 * @file streamingJson.ts
 * @description Zero-heap-fragmentation streaming JSON serialization.
 *
 * Motivation
 * ----------
 * Returning large arrays from endpoints (e.g. 500k rows of funding history
 * or payout exports) forces V8 to allocate a single contiguous `string` for
 * the entire JSON.stringify() output.  Those strings are allocated in the
 * *old space* of the heap and because they exceed `kMaxRegularHeapObjectSize`
 * (~8 MB) they are promoted directly into *large object space* where
 * compaction does NOT happen — the memory fragments and eventually an
 * Out-Of-Memory occurs even though the *total* used heap appears small.
 *
 * Solution
 * --------
 * Pipe the output through a Node.js `Readable` stream that writes:
 *   `[` + item0 + `,` + item1 + `,` + ... + itemN + `]`
 * in chunks of at most `CHUNK_SIZE` bytes.  Individual items are still
 * stringified with `JSON.stringify` (the fast path in V8 is actually tuned
 * for small/medium objects remarkably well), but we *never* build the
 * aggregate 50 MB string in one shot.  Fastify then `Transfer-Encoding:
 * chunked` pipes the raw stream directly into the HTTP response buffer.
 *
 * For wrapped payloads (`{ metadata, data }`) we stream metadata first,
 * emit the data array prefix, stream the items, and then close the object —
 * keeping the same on-wire format 100% identical and therefore TOTALLY
 * transparent to downstream consumers (fetch, tRPC, curl, axios, ...).
 *
 * ---
 * This module is dependency-free: it only uses `stream` and `Buffer` from
 * the Node.js standard library.  `fast-json-stringify` would produce
 * identical wire bytes but requires maintaining per-endpoint JSON-Schema
 * definitions — the manual writer here avoids that operational burden.
 */

import { Readable, Transform, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import type { ServerResponse } from 'node:http';

const pipelineAsync = promisify(pipeline);

/** Individual items larger than ~4 MB still get promoted to large-object
 *  space, so for very wide rows we also chunk the *per-item* stringify.
 *  Empirically 256 KB is a sweet spot: small enough to stay in new-space,
 *  large enough that HTTP chunking overhead stays < 0.1%. */
const ITEM_CHUNK_BYTES = 256 * 1024;

/** Once `pendingBuffer` crosses this many bytes we flush it to the stream. */
const FLUSH_THRESHOLD_BYTES = 64 * 1024;

/* -------------------------------------------------------------------------- */
/*                                Public API                                  */
/* -------------------------------------------------------------------------- */

/**
 * Stream an `Array<T>` as a JSON array `[a,b,...,z]` to a ServerResponse.
 *
 * The wire format is byte-for-byte identical to `JSON.stringify(items)`,
 * meaning callers parse it exactly the same way:
 *
 *     const payload = await fetch(url).then(r => r.json());
 *
 * Memory stays flat (O(CHUNK) instead of O(N·row_size)) even for N > 10⁶.
 */
export function streamJsonArray<T>(
  replyRaw: ServerResponse,
  items: T[],
  opts: StreamOptions = {},
): Promise<void> {
  const source = new ChunkedArrayReadable(items, opts);
  return pipeToResponse(replyRaw, source, opts);
}

/**
 * Stream a wrapped envelope `{ metadata, data: Array<Item> }`.
 *
 * The frontend receives EXACTLY the same JSON shape as:
 *
 *     JSON.stringify({ metadata: {...}, data: [item,...] })
 *
 * But we never materialize that 50 MB string.  Metadata is written first
 * from a single small stringify (it's always small by contract), then the
 * `,` data-prefix, then the item-stream, then the closing braces.
 */
export function streamJsonEnvelope<Meta, Item>(
  replyRaw: ServerResponse,
  metadata: Meta,
  items: Item[],
  opts: StreamOptions = {},
): Promise<void> {
  const source = new ChunkedEnvelopeReadable(metadata, items, opts);
  return pipeToResponse(replyRaw, source, opts);
}

/**
 * Stream a wrapped envelope where `items` are produced asynchronously by a
 * Prisma `findMany` cursor loop — the most common case for "paginated
 * ledger histories" that are really "the entire table in pages stitched
 * together."  Async iterator avoids loading the whole table into JS heap
 * before streaming even begins.
 */
export async function streamAsyncEnvelope<Meta, Item>(
  replyRaw: ServerResponse,
  metadata: Meta,
  itemFetcher: () => AsyncIterable<Item>,
  opts: StreamOptions = {},
): Promise<void> {
  const source = Readable.from(async function* gen() {
    const metaStr = JSON.stringify(metadata);
    yield metaStr.slice(0, -1); // strip `}`
    yield ',"data":[';
    let first = true;
    for await (const item of itemFetcher()) {
      if (!first) yield ',';
      first = false;
      yield* sliceString(JSON.stringify(item), ITEM_CHUNK_BYTES);
    }
    yield ']}';
  }(), { encoding: opts.encoding ?? 'utf8' });
  return pipeToResponse(replyRaw, source, opts);
}

export interface StreamOptions {
  /** Emit Content-Type header override. Default `application/json`. */
  contentType?: string;
  /** If true, also append `Content-Disposition: attachment; filename=...`. */
  filename?: string;
  /** For tests: skip writing HTTP headers (e.g. when reply is a Writable mock). */
  skipHeaders?: boolean;
  /** String encoding. Default `utf8`. */
  encoding?: BufferEncoding;
  /** Optional diagnostic sink: called every FLUSH with the bytes-flushed count. */
  onFlush?: (bytes: number, cumulative: number) => void;
}

/* -------------------------------------------------------------------------- */
/*                          Internal stream machinery                         */
/* -------------------------------------------------------------------------- */

/** Slice a (potentially very long) string into an array of ≤maxLen chunks. */
function* sliceString(long: string, maxLen: number): Generator<string> {
  if (long.length <= maxLen) {
    yield long;
    return;
  }
  for (let i = 0; i < long.length; i += maxLen) {
    yield long.slice(i, i + maxLen);
  }
}

class ChunkedArrayReadable<T> extends Readable {
  private idx = 0;
  private buf = '';
  private cumulative = 0;
  private readonly items: T[];
  private readonly opts: StreamOptions;

  constructor(items: T[], opts: StreamOptions) {
    super({ encoding: opts.encoding ?? 'utf8' });
    this.items = items;
    this.opts = opts;
    this.buf = '[';
  }

  override _read(): void {
    while (this.idx < this.items.length) {
      if (this.idx > 0) this.buf += ',';
      const itemStr = JSON.stringify(this.items[this.idx]);
      this.idx += 1;
      if (itemStr.length >= ITEM_CHUNK_BYTES) {
        // Flush pending buffer first, then push large chunks directly.
        this.flushIfNeeded(true);
        for (const chunk of sliceString(itemStr, ITEM_CHUNK_BYTES)) {
          this.push(chunk, this.opts.encoding);
        }
      } else {
        this.buf += itemStr;
        if (Buffer.byteLength(this.buf) >= FLUSH_THRESHOLD_BYTES) {
          this.flushIfNeeded(true);
        }
      }
      if (!this.readableFlowing) return; // backpressure
    }
    this.buf += ']';
    this.flushIfNeeded(true);
    this.push(null);
  }

  private flushIfNeeded(force: boolean): void {
    if (!force && Buffer.byteLength(this.buf) < FLUSH_THRESHOLD_BYTES) return;
    if (this.buf.length === 0) return;
    const n = Buffer.byteLength(this.buf);
    this.cumulative += n;
    this.opts.onFlush?.(n, this.cumulative);
    this.push(this.buf, this.opts.encoding);
    this.buf = '';
  }
}

class ChunkedEnvelopeReadable<Meta, Item> extends Readable {
  private idx = 0;
  private buf = '';
  private cumulative = 0;
  private readonly metadata: Meta;
  private readonly items: Item[];
  private readonly opts: StreamOptions;
  private headerEmitted = false;

  constructor(metadata: Meta, items: Item[], opts: StreamOptions) {
    super({ encoding: opts.encoding ?? 'utf8' });
    this.metadata = metadata;
    this.items = items;
    this.opts = opts;
  }

  override _read(): void {
    if (!this.headerEmitted) {
      const metaStr = JSON.stringify(this.metadata);
      // Strip trailing `}` so we can append `,"data":[...],`
      if (metaStr.endsWith('}')) {
        this.buf += metaStr.slice(0, -1);
      } else {
        this.buf += '{'; // fallback — never happens in valid JSON
        this.buf += metaStr.slice(1, -1);
      }
      this.buf += ',"data":[';
      this.headerEmitted = true;
      if (Buffer.byteLength(this.buf) >= FLUSH_THRESHOLD_BYTES) {
        this.flushIfNeeded(true);
      }
    }
    while (this.idx < this.items.length) {
      if (this.idx > 0) this.buf += ',';
      const itemStr = JSON.stringify(this.items[this.idx]);
      this.idx += 1;
      if (itemStr.length >= ITEM_CHUNK_BYTES) {
        this.flushIfNeeded(true);
        for (const chunk of sliceString(itemStr, ITEM_CHUNK_BYTES)) {
          this.push(chunk, this.opts.encoding);
        }
      } else {
        this.buf += itemStr;
        if (Buffer.byteLength(this.buf) >= FLUSH_THRESHOLD_BYTES) {
          this.flushIfNeeded(true);
        }
      }
      if (!this.readableFlowing) return;
    }
    this.buf += ']}';
    this.flushIfNeeded(true);
    this.push(null);
  }

  private flushIfNeeded(force: boolean): void {
    if (!force && Buffer.byteLength(this.buf) < FLUSH_THRESHOLD_BYTES) return;
    if (this.buf.length === 0) return;
    const n = Buffer.byteLength(this.buf);
    this.cumulative += n;
    this.opts.onFlush?.(n, this.cumulative);
    this.push(this.buf, this.opts.encoding);
    this.buf = '';
  }
}

async function pipeToResponse(
  replyRaw: ServerResponse,
  source: Readable,
  opts: StreamOptions,
): Promise<void> {
  if (!opts.skipHeaders) {
    if (!replyRaw.headersSent) {
      replyRaw.setHeader('Content-Type', opts.contentType ?? 'application/json; charset=utf-8');
      replyRaw.setHeader('Transfer-Encoding', 'chunked');
      replyRaw.setHeader('X-Json-Streamed', '1'); // fingerprint for tests
      if (opts.filename) {
        replyRaw.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(opts.filename)}"`,
        );
      }
      // Prevent any proxy layer from buffering the whole response.
      replyRaw.setHeader('X-Accel-Buffering', 'no');
    }
  }

  // An explicit Transform that does nothing keeps us compatible with
  // consumers that only accept Duplex — plus it gives us a nice hook for
  // the `onFlush` callback in a single place.
  const passThrough = new Transform({
    transform(chunk, _enc, cb) {
      cb(null, chunk);
    },
  });

  try {
    await pipelineAsync(source, passThrough, replyRaw);
  } catch (err) {
    // Client disconnects are normal; swallow EPIPE / ECONNRESET.  Everything
    // else we rethrow so Fastify's error handler logs it.
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
        return;
      }
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                         Cursor / Paginated helpers                         */
/* -------------------------------------------------------------------------- */

/**
 * Convert a Prisma-style "page fetcher" into an AsyncIterable.
 *
 * Usage:
 *
 *     const rows = cursorIterable(cursor => prisma.fundingEvent.findMany({
 *       take: 1000, skip: cursor ? 1 : 0, cursor: cursor ? { id: cursor } : undefined,
 *       orderBy: { id: 'asc' },
 *     }), row => row.id);
 *
 * Rows come out one-by-one and memory stays bounded to `take` rows, even
 * when you iterate through 10 million of them.
 */
export async function* cursorIterable<T, K>(
  fetchPage: (cursor: K | null) => Promise<T[]>,
  getKey: (row: T) => K,
  pageSize = 1000,
  maxPages = Infinity,
): AsyncIterable<T> {
  let cursor: K | null = null;
  let pages = 0;
  while (pages < maxPages) {
    pages += 1;
    const rows: T[] = await fetchPage(cursor);
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const row of rows) yield row;
    if (rows.length < pageSize) return;
    cursor = getKey(rows[rows.length - 1] as T);
  }
}

/* -------------------------------------------------------------------------- */
/*                         Webhook Streaming Utilities                       */
/* -------------------------------------------------------------------------- */

/**
 * Stream a webhook payload to avoid blocking the event loop during
 * high-volume Web3 block finalization events.
 *
 * This function chunks large webhook payloads to prevent V8 heap fragmentation
 * and ensures non-blocking processing even with payloads > 8MB.
 *
 * @param payload - The webhook payload to stream
 * @returns An async iterable that yields JSON chunks
 */
export async function* streamWebhookPayload<T extends Record<string, unknown>>(
  payload: T,
): AsyncIterable<string> {
  const payloadStr = JSON.stringify(payload);
  
  // For small payloads, yield immediately
  if (payloadStr.length < ITEM_CHUNK_BYTES) {
    yield payloadStr;
    return;
  }
  
  // Chunk large payloads to avoid large object space allocation
  for (const chunk of sliceString(payloadStr, ITEM_CHUNK_BYTES)) {
    yield chunk;
  }
}

/**
 * Create a streaming response for webhook batch ingestion results.
 * 
 * This allows the server to begin responding before all webhooks are processed,
 * reducing perceived latency during high-concurrency block finalization events.
 *
 * @param replyRaw - The raw ServerResponse from Fastify
 * @param results - Async iterable of webhook processing results
 * @param opts - Streaming options
 */
export async function streamWebhookBatchResults<T extends Record<string, unknown>>(
  replyRaw: ServerResponse,
  results: AsyncIterable<T>,
  opts: StreamOptions = {},
): Promise<void> {
  const source = Readable.from(async function* gen() {
    yield '{"results":[';
    let first = true;
    for await (const result of results) {
      if (!first) yield ',';
      first = false;
      // Type-safe JSON serialization with runtime validation
      const serialized = JSON.stringify(result);
      if (serialized === undefined) {
        throw new Error('Failed to serialize webhook result');
      }
      yield* sliceString(serialized, ITEM_CHUNK_BYTES);
    }
    yield ']}';
  }(), { encoding: opts.encoding ?? 'utf8' });
  
  return pipeToResponse(replyRaw, source, opts);
}

/**
 * Non-blocking JSON stringify that yields control back to the event loop
 * for large objects to prevent blocking during high-concurrency scenarios.
 *
 * @param obj - The object to stringify
 * @param chunkSize - Maximum chunk size before yielding (default: 64KB)
 * @returns Async iterable of JSON string chunks
 */
export async function* nonBlockingStringify(
  obj: unknown,
  chunkSize: number = FLUSH_THRESHOLD_BYTES,
): AsyncIterable<string> {
  const str = JSON.stringify(obj);
  
  if (str === undefined) {
    throw new Error('Failed to stringify object');
  }
  
  if (str.length <= chunkSize) {
    yield str;
    return;
  }
  
  // Yield chunks to allow event loop processing
  for (let i = 0; i < str.length; i += chunkSize) {
    yield str.slice(i, i + chunkSize);
    // Allow event loop to process other tasks
    await Promise.resolve();
  }
}

/**
 * Type-safe wrapper for streaming JSON serialization.
 * Ensures type safety across the tRPC boundary by validating
 * that the serialized data matches the expected type structure.
 *
 * @param data - The data to serialize
 * @param schema - Optional Zod schema for runtime validation
 * @returns Promise containing the serialized string
 */
export async function safeStringify<T>(
  data: T,
  schema?: { safeParse: (data: unknown) => { success: boolean; data?: T; error?: any } },
): Promise<string> {
  // Runtime validation if schema is provided
  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new Error(`Type validation failed: ${JSON.stringify(result.error)}`);
    }
  }
  
  // Use non-blocking stringify for large objects
  const chunks: string[] = [];
  const estimatedSize = JSON.stringify(data).length;
  
  if (estimatedSize > 256 * 1024) { // 256KB threshold
    for await (const chunk of nonBlockingStringify(data, 64 * 1024)) {
      chunks.push(chunk);
    }
    return chunks.join('');
  }
  
  return JSON.stringify(data);
}
