/**
 * @file queryComplexityConfig.ts
 * @description Configuration for the tRPC batch query complexity analyzer.
 *
 * Defines a static weight per procedure (heavier for database-intensive
 * operations, lighter for cheap in-memory or single-row lookups) and the
 * cumulative batch score threshold above which a batched request is
 * rejected before any procedure executes.
 */

function envInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (!value) return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

export interface QueryComplexityConfig {
  enabled: boolean;
  logBlocked: boolean;
  maxBatchScore: number;
  defaultProcedureWeight: number;
  procedureWeights: Record<string, number>;
}

/**
 * Static per-procedure weights, roughly proportional to database cost
 * (joins, aggregation, scan size) rather than payload size. Mirrors the
 * relative cost signals already encoded in securityConfig's pathOverrides
 * (maxNodes/maxArraySize), re-expressed as a single comparable number.
 */
const DEFAULT_PROCEDURE_WEIGHTS: Record<string, number> = {
  'organization.get': 3,
  'organization.list': 10,
  'organization.create': 2,
  'contract.getStatus': 1,
  'contract.getDetails': 1,
  'stats.getGlobalStats': 8,
  'stats.getTVL': 5,
  'stats.getTotalFundsRaised': 7,
  'stats.getTopMaintainers': 9,
  'stats.getFundingHistory': 9,
  'analytics.getLeaderboard': 9,
  'transaction.validateFundOrg': 6,
  'transaction.validateAllocatePayout': 6,
  'transaction.validateClaimPayout': 2,
  'sync.push': 8,
  'sync.pull': 5,
};

export const queryComplexityConfig: QueryComplexityConfig = {
  enabled: envBool('QUERY_COMPLEXITY_ENABLED', true),
  logBlocked: envBool('QUERY_COMPLEXITY_LOG_BLOCKED', true),
  // Threshold for the sum of per-procedure scores across a single batched
  // request. A handful of cheap calls (weight ~1-5 each) stays well under
  // this; a batch stacking several list/history/leaderboard calls (weight
  // ~8-10 each) trips it.
  maxBatchScore: envInt('QUERY_COMPLEXITY_MAX_BATCH_SCORE', 40),
  defaultProcedureWeight: envInt('QUERY_COMPLEXITY_DEFAULT_WEIGHT', 3),
  procedureWeights: { ...DEFAULT_PROCEDURE_WEIGHTS },
};

export function getProcedureWeight(path: string): number {
  // eslint-disable-next-line security/detect-object-injection
  return queryComplexityConfig.procedureWeights[path] ?? queryComplexityConfig.defaultProcedureWeight;
}
