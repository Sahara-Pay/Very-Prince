/**
 * @file securityMiddleware.ts
 * @description tRPC middleware for detecting and blocking malicious deep-nesting attacks.
 *
 * Security Features:
 * - AST-based depth, node count, array size analysis
 * - Prototype pollution key detection (__proto__, constructor, prototype)
 * - Monotonous structure detection (synthetic {a:{a:{a:...}}} patterns)
 * - Key-name entropy analysis (randomized attack keys)
 * - tRPC query selection analysis (select/include/orderBy abuse)
 * - Composite risk scoring combining all signals
 * - Suspicious string value pattern detection (XSS/injection patterns)
 * - Circular reference detection
 * - Configurable per-path limits with global defaults
 * - Structured logging for security monitoring
 */

import { TRPCError, initTRPC } from '@trpc/server';
import { analyzeAST } from '../utils/astParser.js';
import { getConfigForPath, securityConfig } from '../config/securityConfig.js';
import { logger } from '../utils/logger.js';
import {
  securityMetrics,
  resetSecurityMetrics,
  getSecurityMetrics,
} from './securityMetrics.js';

export { securityMetrics, resetSecurityMetrics, getSecurityMetrics };

function categorizeViolation(
  reason: string,
  analysis: ReturnType<typeof analyzeAST>,
): keyof typeof securityMetrics.violations {
  if (reason.includes('depth')) return 'depthExceeded';
  if (reason.includes('Node count')) return 'nodeCountExceeded';
  if (reason.includes('Array size')) return 'arraySizeExceeded';
  if (reason.includes('Circular')) return 'circularReference';
  if (reason.includes('Suspicious key')) return 'suspiciousKeyPattern';
  if (reason.includes('Monotonous')) return 'monotonousStructure';
  if (reason.includes('risk score') || reason.includes('Risk score')) return 'highRiskScore';
  if (reason.includes('query selection') || reason.includes('Deep query')) return 'deepQuerySelection';
  if (reason.includes('entropy') || reason.includes('Entropy')) return 'highEntropyKeys';
  if (reason.includes('string value') || reason.includes('Suspicious string')) return 'suspiciousStringValues';
  return 'nodeCountExceeded';
}

function buildErrorMessage(
  analysis: ReturnType<typeof analyzeAST>,
  config: ReturnType<typeof getConfigForPath>,
): string {
  const parts: string[] = [`Request rejected: ${analysis.reason}`];

  if (analysis.maxDepth > config.maxDepth) {
    parts.push(`Nesting depth ${analysis.maxDepth} exceeds limit ${config.maxDepth}`);
  }
  if (analysis.totalNodes > config.maxNodes) {
    parts.push(`Node count ${analysis.totalNodes} exceeds limit ${config.maxNodes}`);
  }
  if (analysis.maxArraySize > config.maxArraySize) {
    parts.push(`Array size ${analysis.maxArraySize} exceeds limit ${config.maxArraySize}`);
  }
  if (analysis.hasCircularReference) {
    parts.push('Circular references are not permitted');
  }
  if (analysis.suspiciousKeys.length > 0) {
    parts.push(`Suspicious keys: ${analysis.suspiciousKeys.slice(0, 3).join(', ')}`);
  }
  if (analysis.monotonousDepth > 0) {
    parts.push(`Monotonous structure depth: ${analysis.monotonousDepth}`);
  }
  if (analysis.hasDeepQuerySelection) {
    parts.push(`Deep query selection at: ${analysis.deepQuerySelectionPaths.slice(0, 2).join(', ')}`);
  }
  const cfgEntropy = (config as typeof config & { maxKeyEntropy?: number }).maxKeyEntropy;
  const maxEntropyLimit = cfgEntropy !== undefined ? cfgEntropy : 5.5;
  if (analysis.keyEntropy > 0 && analysis.keyEntropy > maxEntropyLimit) {
    parts.push(`High key entropy: ${analysis.keyEntropy.toFixed(2)}`);
  }
  if (analysis.suspiciousStringValues > 0) {
    parts.push(`Suspicious string values: ${analysis.suspiciousStringValues}`);
  }
  if (analysis.riskScore > 0) {
    parts.push(`Risk score: ${analysis.riskScore.toFixed(2)}`);
  }

  return parts.join('. ');
}

export function buildSecurityMiddleware(tInstance: ReturnType<typeof initTRPC.create>) {
  return tInstance.middleware(async ({ path, type, input, next }) => {
    if (!securityConfig.enabled) {
      return next();
    }

    securityMetrics.totalRequests++;

    const procedurePath = path;
    const config = getConfigForPath(procedurePath);

    try {
      const analysis = analyzeAST(input, config);

      if (analysis.isSafe) {
        return next();
      }

      securityMetrics.blockedRequests++;

      if (analysis.reason) {
        const violationType = categorizeViolation(analysis.reason, analysis);
        securityMetrics.violations[violationType]++;
      }

      const prev = securityMetrics.blockedByPath.get(procedurePath) ?? 0;
      securityMetrics.blockedByPath.set(procedurePath, prev + 1);

      if (securityConfig.logBlocked) {
        logger.warn(
          {
            event: 'security_violation',
            type: 'deep_nesting_attack',
            path: procedurePath,
            procedureType: type,
            reason: analysis.reason,
            observed: {
              maxDepth: analysis.maxDepth,
              totalNodes: analysis.totalNodes,
              maxArraySize: analysis.maxArraySize,
              hasCircularReference: analysis.hasCircularReference,
              suspiciousKeys: analysis.suspiciousKeys,
              monotonousDepth: analysis.monotonousDepth,
              keyEntropy: analysis.keyEntropy,
              hasDeepQuerySelection: analysis.hasDeepQuerySelection,
              deepQuerySelectionPaths: analysis.deepQuerySelectionPaths,
              suspiciousStringValues: analysis.suspiciousStringValues,
              riskScore: analysis.riskScore,
            },
            limits: {
              maxDepth: config.maxDepth,
              maxNodes: config.maxNodes,
              maxArraySize: config.maxArraySize,
            },
            excessiveDepthPaths: analysis.excessiveDepthPaths.slice(0, 5),
            largeArrayPaths: analysis.largeArrayPaths.slice(0, 5),
          },
          'Blocked malicious deep-nesting attack',
        );
      }

      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: buildErrorMessage(analysis, config),
        cause: {
          type: 'SECURITY_VALIDATION_FAILED',
          analysis: {
            maxDepth: analysis.maxDepth,
            totalNodes: analysis.totalNodes,
            maxArraySize: analysis.maxArraySize,
            hasCircularReference: analysis.hasCircularReference,
            suspiciousKeys: analysis.suspiciousKeys,
            monotonousDepth: analysis.monotonousDepth,
            keyEntropy: analysis.keyEntropy,
            hasDeepQuerySelection: analysis.hasDeepQuerySelection,
            suspiciousStringValues: analysis.suspiciousStringValues,
            riskScore: analysis.riskScore,
          },
        },
      });
    } catch (error) {
      if (error instanceof TRPCError) throw error;

      logger.error({ err: error, path: procedurePath, type }, 'Unexpected error in security middleware');
      return next();
    }
  });
}

export const withSecurityValidation = buildSecurityMiddleware(initTRPC.create());
