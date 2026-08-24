/**
 * @file diagnosticMonitor.ts
 * @description Node.js diagnostic reports + memory fragmentation guard.
 *
 * This module integrates three pieces of Node.js diagnostic tooling to
 * track and mitigate the memory fragmentation caused by JSON
 * stringification of large payloads:
 *
 *  1. `process.report` — writes structured diagnostic JSON to disk on
 *     request (the same file format `--diagnostic-report-uncaught-exception`
 *     uses).  Captures the V8 heap statistics, native stack, and GC history.
 *  2. `v8.getHeapStatistics()` / `v8.getHeapSpaceStatistics()` — sample
 *     every 5 seconds and log a Pino WARN when `malloced_memory` grows
 *     faster than `used_heap_size`, which is the tell-tale signature of
 *     off-heap / heap-fragmentation pressure (large object space promotions).
 *  3. Heap snapshot writer — via the Chrome DevTools Protocol (CDP) built
 *     into every Node.js process since 16.  Snapshotting is EXPENSIVE and
 *     pauses the event loop, so we expose it through:
 *       a) explicit API endpoints POST /api/debug/heap-snapshot
 *       b) automatic dump when HEAP_USED_BYTES > DIAG_HEAP_SNAPSHOT_THRESHOLD_BYTES
 *
 * Combined with the streaming JSON serialiser in `streamingJson.ts`, this
 * module provides the *before/after* heap evidence the user asked for.
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import v8 from 'node:v8';
import inspector from 'node:inspector';
import type { FastifyPluginAsync } from 'fastify';
import { logger } from '../utils/logger.js';
import {
  DIAG_ENABLED,
  DIAG_HEAP_SAMPLE_INTERVAL_MS,
  DIAG_HEAP_SNAPSHOT_THRESHOLD_BYTES,
  DIAG_OUTPUT_DIR,
  DIAG_REPORT_ON_SIGUSR2,
} from '../config/env.js';

export interface DiagSnapshotMetadata {
  type: 'report' | 'snapshot';
  createdAt: string;
  path: string;
  bytesWritten: number;
  heapUsedAtCapture: number;
  trigger: string;
}

class DiagnosticMonitor {
  private started = false;
  private sampleTimer: NodeJS.Timeout | null = null;
  private snapshotInProgress = false;
  private session: inspector.Session | null = null;
  private snapshotStream: fs.WriteStream | null = null;
  private outputDir: string;
  private lastSample: v8.HeapInfo | null = null;

  constructor() {
    this.outputDir = DIAG_OUTPUT_DIR;
    try {
      fs.mkdirSync(this.outputDir, { recursive: true, mode: 0o750 });
    } catch {
      // Ignore — worst case we write to CWD below.
      this.outputDir = process.cwd();
    }
  }

  /** Start sampling.  Idempotent. */
  start(): void {
    if (!DIAG_ENABLED || this.started) return;
    this.started = true;
    this.sampleTimer = setInterval(
      () => this.sampleHeap(),
      DIAG_HEAP_SAMPLE_INTERVAL_MS,
    ).unref();
    if (DIAG_REPORT_ON_SIGUSR2) {
      process.on('SIGUSR2', () => {
        void this.writeReport('SIGUSR2').catch((err) => logger.warn({ err }, 'SIGUSR2 report failed'));
      });
    }
    logger.info(
      {
        outputDir: this.outputDir,
        sampleIntervalMs: DIAG_HEAP_SAMPLE_INTERVAL_MS,
        autoSnapshotThresholdGb: Math.round(
          DIAG_HEAP_SNAPSHOT_THRESHOLD_BYTES / 1024 ** 3,
        ),
      },
      'Diagnostic monitor started',
    );
  }

  /** Stop sampling (for tests & graceful shutdown). */
  stop(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.started = false;
  }

  /** @returns Most recent heap sample (for tests / live inspection). */
  getLastSample(): v8.HeapInfo | null {
    return this.lastSample;
  }

  /**
   * Trigger a Node.js `process.report` JSON diagnostic snapshot.
   * The file format is documented here:
   *   https://nodejs.org/api/process.html#processreportjsonreport
   */
  async writeReport(trigger = 'manual'): Promise<DiagSnapshotMetadata> {
    const startedAt = Date.now();
    const heapUsed = process.memoryUsage().heapUsed;
    const fname = `report-${trigger}-${process.pid}-${startedAt}.json`;
    const target = path.join(this.outputDir, fname);
    const json = process.report?.getReport?.() ?? this.fallbackReport();
    await fs.promises.writeFile(target, JSON.stringify(json, null, 2), { mode: 0o640 });
    const stat = fs.statSync(target);
    logger.info(
      { path: target, bytes: stat.size, heapUsed, trigger, tookMs: Date.now() - startedAt },
      'Wrote diagnostic report',
    );
    return {
      type: 'report',
      createdAt: new Date(startedAt).toISOString(),
      path: target,
      bytesWritten: stat.size,
      heapUsedAtCapture: heapUsed,
      trigger,
    };
  }

  /**
   * Trigger a V8 heap snapshot via CDP inspector session.
   * NOTE: This PAUSES the event-loop for the duration of the dump
   * (multi-second for multi-GB heaps).  Only call from debug endpoints or
   * under high-heap auto-trigger.  In production, prefer `writeReport` —
   * the heap statistics inside the JSON report are usually sufficient
   * to diagnose fragmentation without pausing.
   */
  async writeHeapSnapshot(trigger = 'manual'): Promise<DiagSnapshotMetadata> {
    const startedAt = Date.now();
    const heapUsed = process.memoryUsage().heapUsed;
    const fname = `heap-${trigger}-${process.pid}-${startedAt}.heapsnapshot`;
    const target = path.join(this.outputDir, fname);
    if (this.snapshotInProgress) {
      throw new Error('Heap snapshot already in progress');
    }
    this.snapshotInProgress = true;
    try {
      if (inspector.url() === undefined) {
        // Node was not launched with --inspect.  We can still open a
        // programmatic session via the CDP; it just won't be reachable
        // from an external Chrome DevTools client.
      }
      if (!this.session) {
        this.session = new inspector.Session();
        this.session.connect();
      }
      const session = this.session;
      this.snapshotStream = fs.createWriteStream(target, { mode: 0o640 });
      const chunkHandler = (params: { chunk: string; final?: boolean }) => {
        this.snapshotStream?.write(Buffer.from(params.chunk));
        if (params.final) this.snapshotStream?.end();
      };
      session.on('HeapProfiler.addHeapSnapshotChunk', chunkHandler);
      await new Promise<void>((resolve, reject) => {
        session.post('HeapProfiler.takeHeapSnapshot', undefined, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      session.off('HeapProfiler.addHeapSnapshotChunk', chunkHandler);
      // Wait for the stream to finish draining before we stat the file.
      await new Promise<void>((resolve) => {
        if (!this.snapshotStream) resolve();
        else {
          const s = this.snapshotStream;
          if (s.closed || s.writableEnded) resolve();
          else s.on('finish', () => resolve());
        }
      });
      const stat = fs.statSync(target);
      logger.warn(
        { path: target, bytes: stat.size, heapUsed, trigger, tookMs: Date.now() - startedAt },
        'Wrote V8 heap snapshot (EVENT LOOP PAUSED FOR THIS DURATION)',
      );
      return {
        type: 'snapshot',
        createdAt: new Date(startedAt).toISOString(),
        path: target,
        bytesWritten: stat.size,
        heapUsedAtCapture: heapUsed,
        trigger,
      };
    } finally {
      this.snapshotInProgress = false;
      this.snapshotStream = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*                           Internal helpers                          */
  /* ------------------------------------------------------------------ */

  private fallbackReport(): Record<string, unknown> {
    // Versions of Node compiled without inspector support have no
    // process.report — build a minimal diagnostic payload.
    return {
      header: {
        filename: 'fallback',
        pid: process.pid,
        ppid: process.ppid,
        event: 'fallback-report',
        trigger: 'fallback',
        time: new Date().toISOString(),
      },
      javascriptStack: {},
      nativeStack: [],
      javascriptHeap: v8.getHeapStatistics(),
      javascriptHeapSpaces: v8.getHeapSpaceStatistics(),
      systemMemory: process.memoryUsage.rss
        ? { rssBytes: process.memoryUsage.rss() }
        : { ...process.memoryUsage() },
      libuvVersion: process.versions.uv,
      versions: process.versions,
      os: { hostname: os.hostname(), platform: process.platform, arch: process.arch, cpus: os.cpus().length },
    };
  }

  private sampleHeap(): void {
    try {
      const stat = v8.getHeapStatistics();
      const mem = process.memoryUsage();
      this.lastSample = stat;
      // Automatic snapshot trigger.
      if (
        DIAG_HEAP_SNAPSHOT_THRESHOLD_BYTES > 0 &&
        mem.heapUsed >= DIAG_HEAP_SNAPSHOT_THRESHOLD_BYTES &&
        !this.snapshotInProgress
      ) {
        void this.writeHeapSnapshot(`auto-heap-used-${Math.round(mem.heapUsed / 1024 ** 2)}MiB`)
          .catch((err) => logger.warn({ err }, 'auto-snapshot failed'));
      }
      // Fragmentation heuristic: `malloced_memory / used_heap_size` is the
      // ratio of bytes the OS actually gave V8 versus bytes V8 reports as
      // "in use by JS".  When this ratio jumps to 3× or higher AND the
      // heap is large, we're almost certainly looking at L.O.S. promotion
      // from JSON.stringify()ing giant arrays — which is exactly the bug
      // the streaming serializer fixes.  Log a WARN with the numbers so
      // the transition from "before fix" → "after fix" is visible.
      if (stat.used_heap_size > 0 && stat.malloced_memory > 0) {
        const fragmentationRatio = stat.malloced_memory / stat.used_heap_size;
        const previous = this.lastSample
          ? this.lastSample.malloced_memory / Math.max(1, this.lastSample.used_heap_size)
          : fragmentationRatio;
        if (fragmentationRatio > 2.5 && stat.used_heap_size > 128 * 1024 * 1024) {
          logger.warn(
            {
              usedHeapMiB: Math.round(stat.used_heap_size / 1024 ** 2),
              mallocedMiB: Math.round(stat.malloced_memory / 1024 ** 2),
              ratio: fragmentationRatio.toFixed(2),
              deltaVsPrev: (fragmentationRatio - previous).toFixed(2),
              hint: 'Large-object-space promotion detected — JSON serialising massive arrays? Use streamJson*() helpers from utils/streamingJson.ts',
            },
            'HEAP FRAGMENTATION WARNING',
          );
        } else if (DIAG_ENABLED) {
          logger.debug(
            {
              usedHeapMiB: Math.round(stat.used_heap_size / 1024 ** 2),
              rssMiB: Math.round(mem.rss / 1024 ** 2),
              ratio: (stat.malloced_memory / Math.max(1, stat.used_heap_size)).toFixed(2),
            },
            'heap-sample',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'diagnostic heap sample failed');
    }
  }
}

export const diagnosticMonitor = new DiagnosticMonitor();

/**
 * Mounts the debug endpoints under `/api/v1/diagnostic/*`.
 *
 *   POST /diagnostic/report     — write a JSON diagnostic report NOW
 *   POST /diagnostic/heap-snapshot — write a V8 .heapsnapshot NOW (slow!)
 *   GET  /diagnostic/heap-stats — return getHeapStatistics() + memoryUsage()
 *   GET  /diagnostic/list       — list previously captured files
 */
export const diagnosticRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/diagnostic/report', async () => diagnosticMonitor.writeReport('api'));
  fastify.post('/diagnostic/heap-snapshot', async () => diagnosticMonitor.writeHeapSnapshot('api'));
  fastify.get('/diagnostic/heap-stats', async () => ({
    sampledAt: new Date().toISOString(),
    heap: v8.getHeapStatistics(),
    spaces: v8.getHeapSpaceStatistics(),
    process: process.memoryUsage(),
  }));
  fastify.get('/diagnostic/list', async () => {
    try {
      const entries = await fs.promises.readdir(diagnosticMonitor['outputDir'] as string);
      const results: Array<{ name: string; size: number; modified: string }> = [];
      for (const name of entries) {
        try {
          const stat = fs.statSync(
            path.join(diagnosticMonitor['outputDir'] as string, name),
          );
          if (stat.isFile()) {
            results.push({
              name,
              size: stat.size,
              modified: stat.mtime.toISOString(),
            });
          }
        } catch {
          // ignore unstatable files
        }
      }
      return { files: results.sort((a, b) => (a.modified > b.modified ? -1 : 1)) };
    } catch (err) {
      return { files: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
};
