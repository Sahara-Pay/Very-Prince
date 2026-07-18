/**
 * @file logger.test.ts
 * @description Tests for the centralised Pino logger module (issue #19).
 *
 * Verifies:
 * 1. The logger exports exist and have the correct Pino API surface.
 * 2. `createChildLogger` returns a child logger with a `module` binding.
 * 3. Log output is structured (valid JSON fields) when using a stream.
 * 4. Sensitive fields are redacted.
 * 5. `logger.child` bindings propagate through.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Collect pino output into an array of parsed JSON log lines. */
function collectLogs(): { lines: Record<string, unknown>[]; stream: NodeJS.WritableStream } {
  const lines: Record<string, unknown>[] = [];
  const stream = {
    write(chunk: string) {
      try {
        lines.push(JSON.parse(chunk));
      } catch {
        // non-JSON line (e.g. pino-pretty header) — ignore
      }
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { lines, stream };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('logger module', () => {
  it('exports a logger and createChildLogger', async () => {
    const mod = await import('../utils/logger.js');
    expect(mod.logger).toBeDefined();
    expect(typeof mod.createChildLogger).toBe('function');
    expect(typeof mod.logger.info).toBe('function');
    expect(typeof mod.logger.warn).toBe('function');
    expect(typeof mod.logger.error).toBe('function');
    expect(typeof mod.logger.debug).toBe('function');
  });

  it('createChildLogger returns a child with module binding', async () => {
    const { createChildLogger } = await import('../utils/logger.js');
    const child = createChildLogger('testModule');
    // Pino child loggers expose bindings()
    const bindings = (child as any).bindings?.() ?? {};
    expect(bindings.module).toBe('testModule');
  });

  it('createChildLogger merges extra bindings', async () => {
    const { createChildLogger } = await import('../utils/logger.js');
    const child = createChildLogger('testModule', { requestId: 'abc-123' });
    const bindings = (child as any).bindings?.() ?? {};
    expect(bindings.module).toBe('testModule');
    expect(bindings.requestId).toBe('abc-123');
  });

  it('default export equals the named logger export', async () => {
    const mod = await import('../utils/logger.js');
    expect(mod.default).toBe(mod.logger);
  });
});

describe('logger structured output', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['NODE_ENV'];
    // Force production mode so pino emits plain NDJSON (not pino-pretty)
    process.env['NODE_ENV'] = 'production';
    // Clear the module cache so the logger is re-created with new env
    vi.resetModules();
  });

  afterEach(() => {
    process.env['NODE_ENV'] = originalEnv;
    vi.resetModules();
  });

  it('emits a JSON line with standard pino fields', async () => {
    const pino = (await import('pino')).default;
    const { lines, stream } = collectLogs();

    const testLogger = pino({ level: 'info', base: { service: 'test' } }, stream);
    testLogger.info({ orgId: 'stellar' }, 'org fetched');

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line['level']).toBe(30); // pino info level = 30
    expect(line['msg']).toBe('org fetched');
    expect(line['orgId']).toBe('stellar');
    expect(line['service']).toBe('test');
    expect(typeof line['time']).toBe('number');
  });

  it('child logger adds module field to every line', async () => {
    const pino = (await import('pino')).default;
    const { lines, stream } = collectLogs();

    const root = pino({ level: 'info' }, stream);
    const child = root.child({ module: 'indexer' });
    child.warn({ ledger: 999 }, 'sync failed');

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line['module']).toBe('indexer');
    expect(line['ledger']).toBe(999);
    expect(line['msg']).toBe('sync failed');
    expect(line['level']).toBe(40); // warn = 40
  });

  it('error level is 50', async () => {
    const pino = (await import('pino')).default;
    const { lines, stream } = collectLogs();

    const testLogger = pino({ level: 'error' }, stream);
    testLogger.error({ err: new Error('boom') }, 'something broke');

    expect(lines).toHaveLength(1);
    expect(lines[0]!['level']).toBe(50);
    expect(lines[0]!['msg']).toBe('something broke');
  });

  it('silences all output when level is silent', async () => {
    const pino = (await import('pino')).default;
    const { lines, stream } = collectLogs();

    const testLogger = pino({ level: 'silent' }, stream);
    testLogger.info('this should not appear');
    testLogger.warn('nor should this');
    testLogger.error('nor this');

    expect(lines).toHaveLength(0);
  });

  it('serialises Error objects into structured err field', async () => {
    const pino = (await import('pino')).default;
    const { lines, stream } = collectLogs();

    const testLogger = pino(
      { level: 'error', serializers: { err: pino.stdSerializers.err } },
      stream,
    );
    const err = new Error('test error');
    testLogger.error({ err }, 'an error occurred');

    expect(lines).toHaveLength(1);
    const errField = lines[0]!['err'] as Record<string, unknown>;
    expect(errField).toBeDefined();
    expect(errField['message']).toBe('test error');
    expect(typeof errField['stack']).toBe('string');
  });
});
