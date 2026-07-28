/**
 * @file logger.ts
 * @description Shared Pino logger instance for modules that don't have access
 * to the Fastify request logger (req.log).
 *
 * Fastify uses Pino internally. This module creates a standalone Pino logger
 * using the same configuration so all logs share a consistent format and level.
 *
 * ## Usage
 * ```ts
 * import { logger } from '../utils/logger.js';
 *
 * logger.info('Server started');
 * logger.warn({ attempt }, 'Rate limited, retrying');
 * logger.error({ err }, 'Something went wrong');
 * ```
 *
 * ## Log levels
 * - production : warn and above (errors + warnings only)
 * - development: info and above (verbose structured logs with pretty-print)
 */

import pino from 'pino';

const isProd = process.env['NODE_ENV'] === 'production';

export const logger = pino({
  level: isProd ? 'warn' : 'info',
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      }),
});
