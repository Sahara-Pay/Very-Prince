/**
 * @file securityMetrics.ts
 * @description Singleton metrics store for security middleware.
 *
 * Tracks violations across all analysis dimensions including the new query-level
 * AST capabilities: suspicious keys, monotonous structures, deep query selections,
 * high-entropy keys, suspicious string values, and composite risk scores.
 */

export interface SecurityMetricsStore {
  totalRequests: number;
  blockedRequests: number;
  violations: {
    depthExceeded: number;
    nodeCountExceeded: number;
    arraySizeExceeded: number;
    circularReference: number;
    suspiciousKeyPattern: number;
    monotonousStructure: number;
    highRiskScore: number;
    deepQuerySelection: number;
    highEntropyKeys: number;
    suspiciousStringValues: number;
  };
  blockedByPath: Map<string, number>;
  resetAt: Date;
}

export const securityMetrics: SecurityMetricsStore = {
  totalRequests: 0,
  blockedRequests: 0,
  violations: {
    depthExceeded: 0,
    nodeCountExceeded: 0,
    arraySizeExceeded: 0,
    circularReference: 0,
    suspiciousKeyPattern: 0,
    monotonousStructure: 0,
    highRiskScore: 0,
    deepQuerySelection: 0,
    highEntropyKeys: 0,
    suspiciousStringValues: 0,
  },
  blockedByPath: new Map<string, number>(),
  resetAt: new Date(),
};

export function resetSecurityMetrics(): void {
  securityMetrics.totalRequests = 0;
  securityMetrics.blockedRequests = 0;
  securityMetrics.violations.depthExceeded = 0;
  securityMetrics.violations.nodeCountExceeded = 0;
  securityMetrics.violations.arraySizeExceeded = 0;
  securityMetrics.violations.circularReference = 0;
  securityMetrics.violations.suspiciousKeyPattern = 0;
  securityMetrics.violations.monotonousStructure = 0;
  securityMetrics.violations.highRiskScore = 0;
  securityMetrics.violations.deepQuerySelection = 0;
  securityMetrics.violations.highEntropyKeys = 0;
  securityMetrics.violations.suspiciousStringValues = 0;
  securityMetrics.blockedByPath.clear();
  securityMetrics.resetAt = new Date();
}

export function getSecurityMetrics() {
  return {
    ...securityMetrics,
    blockedByPath: Object.fromEntries(securityMetrics.blockedByPath),
  };
}
