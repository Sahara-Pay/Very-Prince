/**
 * @file logger.ts
 * @description Centralised structured logger built on Pino.
 *
 * All modules in the backend should import `logger` (or a child of it) from
 * this module rather than calling `console.*` directly.
 *
 * ## Usage
 *
 * ```ts
 * // Root logger
 * import { logger } from '../utils/logger.js';
 * logger.info('server started');
 *
 * // Module-scoped child logger (preferred)
 * import { createChildLogger } from '../utils/logger.js';
 * const log = createChildLogger('stellarService');
 * log.info({ orgId }, 'fetching organisation');
 * ```
 *
 * ## Log Levels
 *
 * | Environment   | Level  |
 * |---------------|--------|
 * | production    | warn   |
 * | test          | silent |
 * | development   | debug  |
 * | (default)     | info   |
 *
 * ## Pretty Printing
 *
 * In non-production environments the `pino-pretty` transport is used so that
 * human-readable, colourised output is emitted to stdout. In production, plain
 * NDJSON is written instead so that log aggregators (Datadog, CloudWatch, etc.)
 * can parse it without any pre-processing.
 */

import pino, { type Logger, type Level } from 'pino';

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveLevel(): Level {
  const env = process.env['NODE_ENV'];
  if (env === 'production') return 'warn';
  if (env === 'test') return 'silent';
  if (env === 'development') return 'debug';
  return 'info';
}

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

// ─── Root Logger ─────────────────────────────────────────────────────────────

/**
 * The application-wide root Pino logger.
 *
 * In production: plain NDJSON → stdout.
 * In development / test: pino-pretty coloured output → stdout.
 */
export const logger: Logger = pino(
  {
    level: resolveLevel(),
    // Serialise Error objects correctly (message + stack → `err` field)
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    // Add a base field so every log line carries the service name
    base: {
      service: 'very-prince-backend',
      env: process.env['NODE_ENV'] ?? 'unknown',
    },
    // ISO-8601 human-readable timestamps in every line
    timestamp: pino.stdTimeFunctions.isoTime,
    // Structured redaction: never log raw secrets / tokens
    redact: {
      paths: ['req.headers.authorization', 'signerSecret', '*.signerSecret'],
      censor: '[REDACTED]',
    },
  },
  isProduction()
    ? pino.destination({ sync: false })
    : pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      })
);

// ─── Child Logger Factory ─────────────────────────────────────────────────────

/**
 * Create a module-scoped child logger that carries a `module` field on every
 * log line, making it easy to filter logs by origin in production.
 *
 * @param module - A short, camelCase identifier for the calling module
 *                 (e.g. `'stellarService'`, `'indexer'`).
 * @param bindings - Optional additional fields to merge into every log line.
 *
 * @example
 * ```ts
 * const log = createChildLogger('indexer');
 * log.info({ ledger: 12345 }, 'syncing from ledger');
 * ```
 */
export function createChildLogger(
  module: string,
  bindings?: Record<string, unknown>
): Logger {
  return logger.child({ module, ...bindings });
}

/**
 * Convenience re-export so consumers can use `log.info`, `log.warn`, etc.
 * without needing to call `createChildLogger`.
 */
export default logger;
