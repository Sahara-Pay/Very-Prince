/**
 * @file securityConfig.ts
 * @description Security configuration for input validation and deep-nesting protection.
 *
 * Defines global and path-specific limits for tRPC input validation across all
 * analysis dimensions: depth, node count, array size, prototype pollution,
 * monotonous structures, entropy, tRPC query patterns, string values, and
 * composite risk scoring.
 */

import type { ASTAnalysisConfig } from '../utils/astParser.js';

export interface PathSecurityConfig extends Partial<ASTAnalysisConfig> {
  reason?: string;
}

export interface SecurityConfig {
  global: ASTAnalysisConfig;
  pathOverrides: Record<string, PathSecurityConfig>;
  enabled: boolean;
  logBlocked: boolean;
  collectMetrics: boolean;
}

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

function envFloat(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? fallback : parsed;
}

/**
 * Default security configuration with conservative limits.
 *
 * Rationale for default limits:
 * - maxDepth: 10 — comfortable headroom for legit queries (typical ≤5), blocks extreme nesting
 * - maxNodes: 1000 — accommodates batch operations, prevents memory exhaustion
 * - maxArraySize: 100 — batch ops rarely need >50 items
 * - detectSuspiciousKeys: true — essential prototype pollution defense
 * - detectMonotonousStructures: true — blocks synthetic {a:{a:{a:...}}} attack patterns
 * - monotonousThreshold: 4 — legit data may repeat 2-3 levels, 4+ is clearly synthetic
 * - detectHighEntropyKeys: true — randomized keys indicate fuzzing/attack payloads
 * - maxKeyEntropy: 5.5 — meaningful keys avg 2-4 bits, random base64 keys avg 5-6 bits
 * - detectDeepQuerySelections: true — prevents tRPC GraphQL-style abuse of select/include
 * - maxQuerySelectionDepth: 4 — typical selects use 1-2 levels; 4+ is suspicious
 * - enableRiskScoring: true — holistic assessment combining all signals
 * - maxRiskScore: 0.7 — blocks when aggregate signals indicate likely attack
 * - detectSuspiciousStringValues: true — catches embedded XSS/injection in string fields
 * - maxSuspiciousStringValues: 5 — legitimate data may rarely contain 'javascript:' etc.
 */
export const securityConfig: SecurityConfig = {
  enabled: envBool('SECURITY_MIDDLEWARE_ENABLED', true),
  logBlocked: envBool('SECURITY_LOG_BLOCKED', true),
  collectMetrics: envBool('SECURITY_COLLECT_METRICS', true),

  global: {
    maxDepth: envInt('SECURITY_MAX_DEPTH', 10),
    maxNodes: envInt('SECURITY_MAX_NODES', 1000),
    maxArraySize: envInt('SECURITY_MAX_ARRAY_SIZE', 100),
    trackPaths: envBool('SECURITY_TRACK_PATHS', true),

    detectSuspiciousKeys: envBool('SECURITY_DETECT_SUSPICIOUS_KEYS', true),
    suspiciousKeyBlocklist: [
      '__proto__',
      'constructor',
      'prototype',
      '__defineGetter__',
      '__defineSetter__',
      '__lookupGetter__',
      '__lookupSetter__',
    ],

    detectMonotonousStructures: envBool('SECURITY_DETECT_MONOTONOUS', true),
    monotonousThreshold: envInt('SECURITY_MONOTONOUS_THRESHOLD', 4),

    detectHighEntropyKeys: envBool('SECURITY_DETECT_HIGH_ENTROPY', true),
    maxKeyEntropy: envFloat('SECURITY_MAX_KEY_ENTROPY', 5.5),

    detectDeepQuerySelections: envBool('SECURITY_DETECT_DEEP_QUERY_SEL', true),
    maxQuerySelectionDepth: envInt('SECURITY_MAX_QUERY_SEL_DEPTH', 4),

    enableRiskScoring: envBool('SECURITY_ENABLE_RISK_SCORING', true),
    maxRiskScore: envFloat('SECURITY_MAX_RISK_SCORE', 0.7),

    detectSuspiciousStringValues: envBool('SECURITY_DETECT_SUSPICIOUS_STRINGS', true),
    maxSuspiciousStringValues: envInt('SECURITY_MAX_SUSPICIOUS_STRINGS', 5),
  },

  pathOverrides: {
    'organization.list': {
      maxArraySize: 150,
      reason: 'Pagination may return up to 100 orgs + metadata',
    },

    'stats.getGlobalStats': {
      maxNodes: 2000,
      maxDepth: 8,
      reason: 'Aggregates stats from multiple orgs and maintainers',
    },

    'stats.getTopMaintainers': {
      maxNodes: 2000,
      maxArraySize: 200,
      reason: 'May return large leaderboard with detailed stats',
    },

    'stats.getFundingHistory': {
      maxNodes: 3000,
      maxArraySize: 500,
      reason: 'Historical time-series data may have many events',
    },

    'analytics.getLeaderboard': {
      maxNodes: 2500,
      maxArraySize: 200,
      reason: 'Leaderboard with detailed per-maintainer metrics',
    },

    'contract.getStatus': {
      maxDepth: 3,
      maxNodes: 50,
      maxArraySize: 10,
      maxQuerySelectionDepth: 2,
      reason: 'Simple status object with minimal nesting',
    },

    'contract.getDetails': {
      maxDepth: 3,
      maxNodes: 50,
      maxArraySize: 10,
      maxQuerySelectionDepth: 2,
      reason: 'Simple contract details object',
    },

    'transaction.validateFundOrg': {
      maxDepth: 5,
      maxNodes: 100,
      maxArraySize: 10,
      maxQuerySelectionDepth: 2,
      maxSuspiciousStringValues: 2,
      reason: 'User input validation requires stricter limits',
    },

    'transaction.validateAllocatePayout': {
      maxDepth: 6,
      maxNodes: 200,
      maxArraySize: 50,
      maxQuerySelectionDepth: 2,
      maxSuspiciousStringValues: 2,
      reason: 'May allocate to multiple maintainers',
    },

    'transaction.validateClaimPayout': {
      maxDepth: 5,
      maxNodes: 100,
      maxArraySize: 10,
      maxQuerySelectionDepth: 2,
      maxSuspiciousStringValues: 2,
      reason: 'User input validation requires stricter limits',
    },

    'sync.push': {
      maxDepth: 8,
      maxNodes: 500,
      maxArraySize: 200,
      maxSuspiciousStringValues: 3,
      reason: 'CRDT sync payloads may contain structured update documents',
    },

    'sync.pull': {
      maxDepth: 6,
      maxNodes: 100,
      maxArraySize: 50,
      reason: 'CRDT sync pull requests are parameter-based',
    },
  },
};

export function getConfigForPath(path: string): ASTAnalysisConfig {
  const override = securityConfig.pathOverrides[path];

  if (!override) {
    return securityConfig.global;
  }

  return {
    ...securityConfig.global,
    ...override,
  };
}

export function validateSecurityConfig(): void {
  const { global, pathOverrides } = securityConfig;

  if (global.maxDepth < 1 || global.maxDepth > 50) {
    throw new Error(`Invalid global maxDepth: ${global.maxDepth} (must be 1-50)`);
  }
  if (global.maxNodes < 10 || global.maxNodes > 100000) {
    throw new Error(`Invalid global maxNodes: ${global.maxNodes} (must be 10-100000)`);
  }
  if (global.maxArraySize < 1 || global.maxArraySize > 10000) {
    throw new Error(`Invalid global maxArraySize: ${global.maxArraySize} (must be 1-10000)`);
  }
  if (global.maxRiskScore < 0 || global.maxRiskScore > 1) {
    throw new Error(`Invalid global maxRiskScore: ${global.maxRiskScore} (must be 0-1)`);
  }
  if (global.monotonousThreshold < 2 || global.monotonousThreshold > 20) {
    throw new Error(`Invalid global monotonousThreshold: ${global.monotonousThreshold} (must be 2-20)`);
  }
  if (global.maxKeyEntropy < 0 || global.maxKeyEntropy > 8) {
    throw new Error(`Invalid global maxKeyEntropy: ${global.maxKeyEntropy} (must be 0-8)`);
  }
  if (global.maxQuerySelectionDepth < 1 || global.maxQuerySelectionDepth > 20) {
    throw new Error(`Invalid global maxQuerySelectionDepth: ${global.maxQuerySelectionDepth} (must be 1-20)`);
  }
  if (global.maxSuspiciousStringValues < 0 || global.maxSuspiciousStringValues > 100) {
    throw new Error(`Invalid global maxSuspiciousStringValues: ${global.maxSuspiciousStringValues} (must be 0-100)`);
  }

  for (const [path, override] of Object.entries(pathOverrides)) {
    if (override.maxDepth !== undefined && (override.maxDepth < 1 || override.maxDepth > 50)) {
      throw new Error(`Invalid maxDepth for ${path}: ${override.maxDepth} (must be 1-50)`);
    }
    if (override.maxNodes !== undefined && (override.maxNodes < 10 || override.maxNodes > 100000)) {
      throw new Error(`Invalid maxNodes for ${path}: ${override.maxNodes} (must be 10-100000)`);
    }
    if (override.maxArraySize !== undefined && (override.maxArraySize < 1 || override.maxArraySize > 10000)) {
      throw new Error(`Invalid maxArraySize for ${path}: ${override.maxArraySize} (must be 1-10000)`);
    }
    if (override.maxRiskScore !== undefined && (override.maxRiskScore < 0 || override.maxRiskScore > 1)) {
      throw new Error(`Invalid maxRiskScore for ${path}: ${override.maxRiskScore} (must be 0-1)`);
    }
    if (override.maxQuerySelectionDepth !== undefined && (override.maxQuerySelectionDepth < 1 || override.maxQuerySelectionDepth > 20)) {
      throw new Error(`Invalid maxQuerySelectionDepth for ${path}: ${override.maxQuerySelectionDepth} (must be 1-20)`);
    }
    if (override.monotonousThreshold !== undefined && (override.monotonousThreshold < 2 || override.monotonousThreshold > 20)) {
      throw new Error(`Invalid monotonousThreshold for ${path}: ${override.monotonousThreshold} (must be 2-20)`);
    }
  }
}

export function getSecurityConfigSummary() {
  return {
    enabled: securityConfig.enabled,
    global: securityConfig.global,
    overrideCount: Object.keys(securityConfig.pathOverrides).length,
    paths: Object.keys(securityConfig.pathOverrides),
  };
}

validateSecurityConfig();
