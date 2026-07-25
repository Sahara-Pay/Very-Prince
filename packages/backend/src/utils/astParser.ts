/**
 * @file astParser.ts
 * @description Query-level AST parser for detecting malicious tRPC deep-nesting attacks.
 *
 * Provides recursive traversal of arbitrary input objects with multiple analysis
 * dimensions to detect and block DoS and injection attacks:
 *
 * - Depth analysis: blocks excessive nesting that could cause stack overflow
 * - Node counting: prevents memory exhaustion from massive payloads
 * - Array size limiting: blocks oversized arrays that cause O(n²) processing
 * - Circular reference detection: prevents infinite traversal loops
 * - Prototype pollution detection: blocks __proto__, constructor, prototype keys
 * - Monotonous structure detection: flags uniform synthetic patterns like {a:{a:{a:...}}}
 * - Entropy analysis: detects randomly generated key names (attack indicator)
 * - tRPC query pattern analysis: identifies suspicious select/include/orderBy abuse
 * - Composite risk scoring: combines multiple signals for holistic assessment
 * - Value pattern analysis: detects encoded/injection payloads in string values
 */

export interface ASTAnalysisResult {
  maxDepth: number;
  totalNodes: number;
  maxArraySize: number;
  hasCircularReference: boolean;
  excessiveDepthPaths: string[];
  largeArrayPaths: string[];
  suspiciousKeys: string[];
  monotonousDepth: number;
  keyEntropy: number;
  riskScore: number;
  hasDeepQuerySelection: boolean;
  deepQuerySelectionPaths: string[];
  suspiciousStringValues: number;
  isSafe: boolean;
  reason?: string;
}

export interface ASTAnalysisConfig {
  maxDepth: number;
  maxNodes: number;
  maxArraySize: number;
  trackPaths: boolean;
  detectSuspiciousKeys: boolean;
  suspiciousKeyBlocklist: string[];
  detectMonotonousStructures: boolean;
  monotonousThreshold: number;
  detectHighEntropyKeys: boolean;
  maxKeyEntropy: number;
  detectDeepQuerySelections: boolean;
  maxQuerySelectionDepth: number;
  enableRiskScoring: boolean;
  maxRiskScore: number;
  detectSuspiciousStringValues: boolean;
  maxSuspiciousStringValues: number;
}

export const DEFAULT_AST_CONFIG: ASTAnalysisConfig = {
  maxDepth: 10,
  maxNodes: 1000,
  maxArraySize: 100,
  trackPaths: true,
  detectSuspiciousKeys: true,
  suspiciousKeyBlocklist: [
    '__proto__',
    'constructor',
    'prototype',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ],
  detectMonotonousStructures: true,
  monotonousThreshold: 4,
  detectHighEntropyKeys: true,
  maxKeyEntropy: 5.5,
  detectDeepQuerySelections: true,
  maxQuerySelectionDepth: 4,
  enableRiskScoring: true,
  maxRiskScore: 0.7,
  detectSuspiciousStringValues: true,
  maxSuspiciousStringValues: 5,
};

const SUSPICIOUS_VALUE_PATTERNS = [
  /<script[\s>]/i,
  /javascript\s*:/i,
  /on\w+\s*=/i,
  /data:\s*text\/html/i,
  /\$\{.*\}/,
  /['"];\s*return/i,
  /\\x[0-9a-f]{2}/i,
  /\\u[0-9a-f]{4}/i,
];

const QUERY_SELECTION_KEYS = new Set([
  'select', 'include', 'orderBy', 'orderby',
  'where', 'filter', 'having', 'groupBy',
]);

function shannonEntropy(str: string): number {
  if (!str) return 0;
  const len = str.length;
  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function analyzeAST(
  input: unknown,
  config: Partial<ASTAnalysisConfig> = {},
): ASTAnalysisResult {
  const fullConfig: ASTAnalysisConfig = { ...DEFAULT_AST_CONFIG, ...config };

  const visited = new WeakSet<object>();
  const allKeys: string[] = [];
  let suspiciousStringCount = 0;
  const monotonousDepthRef = { depth: 0 };

  const result: ASTAnalysisResult = {
    maxDepth: 0,
    totalNodes: 0,
    maxArraySize: 0,
    hasCircularReference: false,
    excessiveDepthPaths: [],
    largeArrayPaths: [],
    suspiciousKeys: [],
    monotonousDepth: 0,
    keyEntropy: 0,
    riskScore: 0,
    hasDeepQuerySelection: false,
    deepQuerySelectionPaths: [],
    suspiciousStringValues: 0,
    isSafe: true,
  };

  function traverse(
    value: unknown,
    currentDepth: number,
    path: string,
    currentQueryDepth: number,
    monotonousKeyChain: string[],
  ): void {
    result.totalNodes++;

    if (result.totalNodes > fullConfig.maxNodes) {
      result.isSafe = false;
      result.reason = `Node count exceeded limit (${fullConfig.maxNodes})`;
      return;
    }

    if (currentDepth > result.maxDepth) {
      result.maxDepth = currentDepth;
    }

    if (currentDepth > fullConfig.maxDepth) {
      result.isSafe = false;
      result.reason = `Nesting depth exceeded limit (${fullConfig.maxDepth})`;
      if (fullConfig.trackPaths) {
        result.excessiveDepthPaths.push(path);
      }
      return;
    }

    if (value === null || value === undefined) {
      return;
    }

    if (typeof value !== 'object') {
      if (typeof value === 'string' && fullConfig.detectSuspiciousStringValues) {
        for (const pattern of SUSPICIOUS_VALUE_PATTERNS) {
          if (pattern.test(value)) {
            suspiciousStringCount++;
            break;
          }
        }
      }
      return;
    }

    if (visited.has(value as object)) {
      result.hasCircularReference = true;
      result.isSafe = false;
      result.reason = 'Circular reference detected';
      return;
    }
    visited.add(value as object);

    if (Array.isArray(value)) {
      const arraySize = value.length;
      if (arraySize > result.maxArraySize) {
        result.maxArraySize = arraySize;
      }

      if (arraySize > fullConfig.maxArraySize) {
        result.isSafe = false;
        result.reason = `Array size exceeded limit (${fullConfig.maxArraySize})`;
        if (fullConfig.trackPaths) {
          result.largeArrayPaths.push(`${path} (size: ${arraySize})`);
        }
        return;
      }

      for (let i = 0; i < arraySize; i++) {
        const elementPath = fullConfig.trackPaths ? `${path}[${i}]` : '';
        traverse(value[i], currentDepth + 1, elementPath, currentQueryDepth, []);
        if (!result.isSafe) return;
      }
      return;
    }

    const keys = Object.keys(value);

    for (const key of keys) {
      allKeys.push(key);
    }

    if (fullConfig.detectSuspiciousKeys) {
      for (const key of keys) {
        if (fullConfig.suspiciousKeyBlocklist.includes(key)) {
          const keyPath = fullConfig.trackPaths
            ? path ? `${path}.${key}` : key
            : key;
          if (fullConfig.trackPaths) {
            result.suspiciousKeys.push(keyPath);
          } else {
            result.suspiciousKeys.push(key);
          }
          result.isSafe = false;
          result.reason = `Suspicious key detected: "${key}" (possible ${key === '__proto__' || key === 'constructor' || key === 'prototype' ? 'prototype pollution' : 'injection'} attack)`;
          return;
        }
      }
    }

    if (fullConfig.detectSuspiciousKeys && keys.length === 0) {
      const isPlainObj = Object.prototype.toString.call(value) === '[object Object]';
      if (isPlainObj) {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype) {
          result.suspiciousKeys.push(path ? `${path}.__proto__` : '__proto__');
          result.isSafe = false;
          result.reason = 'Suspicious key detected: "__proto__" (possible prototype pollution attack via __proto__ setter)';
          return;
        }
      }
    }

    if (fullConfig.detectDeepQuerySelections) {
      for (const key of keys) {
        if (QUERY_SELECTION_KEYS.has(key)) {
          const newQueryDepth = currentQueryDepth + 1;
          if (newQueryDepth > fullConfig.maxQuerySelectionDepth) {
            result.hasDeepQuerySelection = true;
            const selectionPath = fullConfig.trackPaths
              ? path ? `${path}.${key}` : key
              : key;
            result.deepQuerySelectionPaths.push(selectionPath);
          }

          const nestedValue = (value as Record<string, unknown>)[key];
          if (typeof nestedValue === 'object' && nestedValue !== null && !Array.isArray(nestedValue)) {
            for (const subKey of Object.keys(nestedValue)) {
              const subPath = fullConfig.trackPaths
                ? `${path ? `${path}.` : ''}${key}.${subKey}`
                : '';
              traverse(
                (nestedValue as Record<string, unknown>)[subKey],
                currentDepth + 1,
                subPath,
                newQueryDepth,
                [],
              );
              if (!result.isSafe) return;
            }
            return;
          }
        }
      }
    }

    for (const key of keys) {
      if (
        fullConfig.detectDeepQuerySelections &&
        QUERY_SELECTION_KEYS.has(key)
      ) {
        continue;
      }

      const nested = (value as Record<string, unknown>)[key];

      if (fullConfig.detectMonotonousStructures) {
        if (
          typeof nested === 'object' && nested !== null &&
          !Array.isArray(nested) && !visited.has(nested)
        ) {
          const nestedKeys = Object.keys(nested);
          if (nestedKeys.length === 1 && nestedKeys[0] === key) {
            const newChain = [...monotonousKeyChain, key];
            if (newChain.length >= fullConfig.monotonousThreshold) {
              result.monotonousDepth = Math.max(result.monotonousDepth, newChain.length);
              if (result.isSafe) {
                result.isSafe = false;
                result.reason = `Monotonous structure detected: key "${key}" repeated ${newChain.length} levels deep (synthetic attack pattern)`;
              }
            }
            const propPath = fullConfig.trackPaths ? (path ? `${path}.${key}` : key) : '';
            traverse(nested, currentDepth + 1, propPath, currentQueryDepth, newChain);
            if (!result.isSafe) return;
            continue;
          }
        }
      }

      const propertyPath = fullConfig.trackPaths
        ? path ? `${path}.${key}` : key
        : '';

      traverse(
        nested,
        currentDepth + 1,
        propertyPath,
        currentQueryDepth,
        [],
      );

      if (!result.isSafe) return;
    }
  }

  traverse(input, 0, '', 0, []);

  result.suspiciousStringValues = suspiciousStringCount;

  if (
    result.isSafe &&
    fullConfig.detectSuspiciousStringValues &&
    suspiciousStringCount > fullConfig.maxSuspiciousStringValues
  ) {
    result.isSafe = false;
    result.reason = `Suspicious string value patterns exceeded limit (${suspiciousStringCount} > ${fullConfig.maxSuspiciousStringValues})`;
  }

  if (fullConfig.detectHighEntropyKeys && allKeys.length > 0) {
    const totalEntropy = allKeys.reduce((sum, k) => sum + shannonEntropy(k), 0);
    result.keyEntropy = totalEntropy / allKeys.length;

    if (
      result.isSafe &&
      result.keyEntropy > fullConfig.maxKeyEntropy &&
      allKeys.length >= 5
    ) {
      result.isSafe = false;
      result.reason = `High key-name entropy detected (${result.keyEntropy.toFixed(2)} > ${fullConfig.maxKeyEntropy}) — possible synthetic attack payload`;
    }
  }

  if (result.isSafe && result.hasDeepQuerySelection) {
    result.isSafe = false;
    result.reason = `Deep query selection detected at: ${result.deepQuerySelectionPaths.slice(0, 3).join(', ')}`;
  }

  if (fullConfig.enableRiskScoring) {
    const depthScore = Math.min(result.maxDepth / fullConfig.maxDepth, 1);
    const nodeScore = Math.min((result.totalNodes / fullConfig.maxNodes) * 2, 1);
    const arrayScore = result.maxArraySize > 0
      ? Math.min(result.maxArraySize / fullConfig.maxArraySize, 1)
      : 0;
    const circularPenalty = result.hasCircularReference ? 0.5 : 0;
    const suspiciousKeyPenalty = result.suspiciousKeys.length > 0 ? 0.4 : 0;
    const monotonousPenalty = result.monotonousDepth > 0
      ? Math.min(result.monotonousDepth / 10, 0.3)
      : 0;
    const entropyPenalty = result.keyEntropy > 0
      ? Math.min((result.keyEntropy / 8) * 0.2, 0.2)
      : 0;
    const querySelectionPenalty = result.hasDeepQuerySelection ? 0.3 : 0;
    const stringValuePenalty = suspiciousStringCount > 0
      ? Math.min(suspiciousStringCount / 20, 0.2)
      : 0;

    result.riskScore = Math.min(
      depthScore * 0.25 +
      nodeScore * 0.2 +
      arrayScore * 0.1 +
      circularPenalty +
      suspiciousKeyPenalty +
      monotonousPenalty +
      entropyPenalty +
      querySelectionPenalty +
      stringValuePenalty,
      1,
    );

    if (result.isSafe && result.riskScore > fullConfig.maxRiskScore) {
      result.isSafe = false;
      result.reason = `Composite risk score ${result.riskScore.toFixed(2)} exceeded threshold ${fullConfig.maxRiskScore}`;
    }
  }

  return result;
}

export function validateInputSafety(
  input: unknown,
  config?: Partial<ASTAnalysisConfig>,
): void {
  const result = analyzeAST(input, config);

  if (!result.isSafe) {
    const details = [
      result.reason,
      result.excessiveDepthPaths.length > 0
        ? `Excessive depth at: ${result.excessiveDepthPaths.slice(0, 3).join(', ')}`
        : null,
      result.largeArrayPaths.length > 0
        ? `Large arrays at: ${result.largeArrayPaths.slice(0, 3).join(', ')}`
        : null,
      result.suspiciousKeys.length > 0
        ? `Suspicious keys: ${result.suspiciousKeys.slice(0, 3).join(', ')}`
        : null,
      result.monotonousDepth > 0
        ? `Monotonous pattern depth: ${result.monotonousDepth}`
        : null,
      result.riskScore > 0
        ? `Risk score: ${result.riskScore.toFixed(2)}`
        : null,
    ]
      .filter(Boolean)
      .join('. ');

    throw new Error(`Malicious input detected: ${details}`);
  }
}

export function createAnalyzer(
  config: Partial<ASTAnalysisConfig>,
): (input: unknown) => ASTAnalysisResult {
  return (input: unknown) => analyzeAST(input, config);
}
