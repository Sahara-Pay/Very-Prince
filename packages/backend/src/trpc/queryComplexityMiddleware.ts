/**
 * @file queryComplexityMiddleware.ts
 * @description Fastify preHandler that scores the cumulative complexity of a
 * batched tRPC request and rejects it with 429 before any procedure runs.
 *
 * A single HTTP POST to /trpc/:path can carry multiple procedures at once
 * (tRPC's httpBatchLink joins them as a comma-separated path with a
 * JSON body keyed by index). Each procedure is scored as:
 *
 *   score = staticWeight(procedure) * (1 + astRiskScore(input))
 *
 * staticWeight reflects how database-intensive the procedure is (see
 * queryComplexityConfig); astRiskScore is a lightweight structural pass
 * over that procedure's input (depth/node/array-size/query-selection
 * signals) using a reduced detector set so the analysis stays fast enough
 * to run on every request. Scores are summed across the batch; if the
 * total exceeds the configured threshold, the request is rejected before
 * `handleTRPCRequest` (and therefore the database) is ever reached.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { analyzeAST, type ASTAnalysisConfig } from '../utils/astParser.js';
import { getProcedureWeight, queryComplexityConfig } from '../config/queryComplexityConfig.js';
import { logger } from '../utils/logger.js';

// Reduced detector set: only the structural signals relevant to complexity
// (depth/nodes/arrays/query-selection breadth). Entropy and suspicious
// string-value scanning are skipped here since they're the more expensive
// passes and are already covered by the per-procedure security middleware.
const COMPLEXITY_AST_CONFIG: Partial<ASTAnalysisConfig> = {
  maxDepth: 20,
  maxNodes: 5000,
  maxArraySize: 500,
  trackPaths: false,
  detectSuspiciousKeys: false,
  detectMonotonousStructures: false,
  detectHighEntropyKeys: false,
  detectDeepQuerySelections: true,
  maxQuerySelectionDepth: 4,
  enableRiskScoring: true,
  maxRiskScore: 1,
  detectSuspiciousStringValues: false,
};

export interface BatchProcedureScore {
  path: string;
  weight: number;
  riskScore: number;
  score: number;
}

export interface BatchComplexityResult {
  procedures: BatchProcedureScore[];
  totalScore: number;
  exceeds: boolean;
}

function parseBatchPaths(rawPath: string): string[] {
  return rawPath
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Extracts one input per procedure from the request body. Handles both the
 * tRPC batch envelope (`{"0":{"json":input0},"1":{"json":input1},...}`) and
 * a plain single-procedure body (the whole body is the one input).
 */
function extractInputsByIndex(body: unknown, count: number): unknown[] {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, '0')) {
      const inputs: unknown[] = [];
      for (let i = 0; i < count; i++) {
        // eslint-disable-next-line security/detect-object-injection
        const entry = record[String(i)];
        inputs.push(
          entry && typeof entry === 'object' && 'json' in (entry as Record<string, unknown>)
            ? (entry as Record<string, unknown>).json
            : entry,
        );
      }
      return inputs;
    }
  }
  return [body];
}

export function computeBatchComplexity(rawPath: string, body: unknown): BatchComplexityResult {
  const paths = parseBatchPaths(rawPath);
  const inputs = extractInputsByIndex(body, paths.length);

  const procedures: BatchProcedureScore[] = paths.map((path, index) => {
    // eslint-disable-next-line security/detect-object-injection
    const input = inputs[index];
    const weight = getProcedureWeight(path);
    const analysis = analyzeAST(input, COMPLEXITY_AST_CONFIG);
    const score = weight * (1 + analysis.riskScore);
    return { path, weight, riskScore: analysis.riskScore, score };
  });

  const totalScore = procedures.reduce((sum, p) => sum + p.score, 0);

  return {
    procedures,
    totalScore,
    exceeds: totalScore > queryComplexityConfig.maxBatchScore,
  };
}

export async function queryComplexityMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!queryComplexityConfig.enabled) return;

  const { path } = request.params as { path?: string };
  if (!path) return;

  const result = computeBatchComplexity(path, request.body);

  if (!result.exceeds) return;

  if (queryComplexityConfig.logBlocked) {
    logger.warn(
      {
        event: 'query_complexity_exceeded',
        path,
        totalScore: result.totalScore,
        maxBatchScore: queryComplexityConfig.maxBatchScore,
        procedures: result.procedures,
      },
      'Rejected tRPC batch: cumulative complexity score exceeded threshold',
    );
  }

  await reply.code(429).send({
    error: 'Too Many Requests',
    message: `Query complexity score ${result.totalScore.toFixed(2)} exceeds limit ${queryComplexityConfig.maxBatchScore}`,
  });
}
