/**
 * @file coop-coep-headers.test.ts
 * @description Verifies that the COOP/COEP headers required for SharedArrayBuffer
 *              are correctly configured in next.config.mjs.
 *
 * These tests read `packages/frontend/next.config.mjs` from disk and assert on
 * its real contents — if the file is changed the tests must be updated too.
 * This is intentionally NOT an inlined mirror of the config, so a copy-paste
 * mistake in the config would trip these tests instead of silently passing.
 *
 * The parser is deliberately lightweight (regex over the source text). It is
 * sufficient because the next.config.mjs format is well-known and only the
 * COOP/COEP rule matters for SharedArrayBuffer support. If the config grows
 * significant new structure this parser should be upgraded to a real AST
 * (e.g. via the TypeScript compiler API) — not inlined.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Paths ────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Absolute path to the canonical Next.js config file under test.
 * Resolve relative to this test file so it works regardless of CWD.
 *
 *   packages/frontend/src/crypto/coop-coep-headers.test.ts  (this file)
 *   packages/frontend/next.config.mjs                       (target)
 *
 * The target is two directories up from this file: src/crypto -> src -> frontend.
 */
const NEXT_CONFIG_PATH = resolve(__dirname, '..', '..', 'next.config.mjs');

// ─── Parsed shape ─────────────────────────────────────────────────────────────

interface HeaderEntry {
  key: string;
  value: string;
}

interface HeaderRule {
  source: string;
  headers: HeaderEntry[];
}

interface ParsedConfig {
  /** Every header rule declared by `headers()` in next.config.mjs. */
  rules: HeaderRule[];
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a Next.js config source string into a structured `ParsedConfig`.
 *
 * The parser extracts the literal `headers()` array literal from the source
 * text — it does NOT execute the file. It is a best-effort, intentionally
 * narrow parser: it assumes headers are declared as:
 *
 *   async headers() {
 *     return [
 *       { source: '...', headers: [ { key: '...', value: '...' }, ... ] },
 *       ...
 *     ];
 *   }
 *
 * If the config moves to a different shape this parser must be updated.
 */
function parseNextConfigSource(source: string): ParsedConfig {
  // Locate the start of the `headers()` function body.
  const headersFnMatch = source.match(/\basync\s+headers\s*\(\s*\)\s*\{/);
  if (!headersFnMatch) {
    throw new Error(
      'Could not locate `async headers()` function in next.config.mjs. ' +
        'If the config was restructured, this test must be updated.',
    );
  }
  const bodyStart = headersFnMatch.index! + headersFnMatch[0].length;

  // Find the matching closing brace for the function. Use a depth counter so
  // we tolerate nested objects.
  let depth = 1;
  let i = bodyStart;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    i += 1;
  }
  const body = source.slice(bodyStart, i - 1);

  // Extract every `{ ... }` rule object inside the returned array. We pull
  // each object's source/key/value literals using regex.
  //
  // Notes for robustness:
  //  - `[\s\S]*?` between `{` and `source:` tolerates comments (// ...) and
  //    blank lines that the config may place between the opening brace and
  //    the `source:` property.
  //  - The trailing `,` between `headers: [...],` and `}` is permitted by
  //    allowing `[\s\S]*?` between `]` and `}`.
  const rules: HeaderRule[] = [];
  const ruleRegex =
    /\{[\s\S]*?source:\s*['"]([^'"]+)['"]\s*,\s*headers:\s*\[([\s\S]*?)\][\s\S]*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRegex.exec(body)) !== null) {
    const sourcePath = m[1]!;
    const headersText = m[2]!;

    const headers: HeaderEntry[] = [];
    // Same comment-tolerance rationale as the rule regex: real configs may
    // place a `// ...` comment between `{` and `key:`.
    const headerRegex =
      /\{[\s\S]*?key:\s*['"]([^'"]+)['"]\s*,\s*value:\s*['"]([^'"]+)['"][\s\S]*?\}/g;
    let h: RegExpExecArray | null;
    while ((h = headerRegex.exec(headersText)) !== null) {
      headers.push({ key: h[1]!, value: h[2]! });
    }
    rules.push({ source: sourcePath, headers });
  }
  return { rules };
}

/** Loader that reads next.config.mjs from disk and parses it. */
function loadParsedConfig(): ParsedConfig {
  const source = readFileSync(NEXT_CONFIG_PATH, 'utf8');
  return parseNextConfigSource(source);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('COOP/COEP header configuration (from real next.config.mjs)', () => {
  it('next.config.mjs declares at least one catch-all rule', () => {
    const { rules } = loadParsedConfig();
    const catchAll = rules.find((r) => r.source === '/(.*)');
    expect(catchAll, 'expected a rule with source "/(.*)"').toBeDefined();
  });

  it('catch-all rule sets Cross-Origin-Opener-Policy: same-origin', () => {
    const { rules } = loadParsedConfig();
    const catchAll = rules.find((r) => r.source === '/(.*)');
    expect(catchAll, 'expected a rule with source "/(.*)"').toBeDefined();
    const coopKey = 'Cross-Origin-Opener-Policy';
    const coop = catchAll?.headers.find((h) => h.key === coopKey);
    expect(coop?.value).toBe('same-origin');
  });

  it('catch-all rule sets Cross-Origin-Embedder-Policy: require-corp', () => {
    const { rules } = loadParsedConfig();
    const catchAll = rules.find((r) => r.source === '/(.*)');
    expect(catchAll, 'expected a rule with source "/(.*)"').toBeDefined();
    const coepKey = 'Cross-Origin-Embedder-Policy';
    const coep = catchAll?.headers.find((h) => h.key === coepKey);
    expect(coep?.value).toBe('require-corp');
  });

  it('COOP and COEP together enable cross-origin isolation (SharedArrayBuffer)', () => {
    const { rules } = loadParsedConfig();
    const catchAll = rules.find((r) => r.source === '/(.*)');
    expect(catchAll, 'expected a rule with source "/(.*)"').toBeDefined();
    const coopKey = 'Cross-Origin-Opener-Policy';
    const coepKey = 'Cross-Origin-Embedder-Policy';
    const coop = catchAll?.headers.find((h) => h.key === coopKey);
    const coep = catchAll?.headers.find((h) => h.key === coepKey);

    expect(coop?.value).toBe('same-origin');
    expect(coep?.value).toBe('require-corp');
  });
});

// ─── SharedArrayBuffer availability check ────────────────────────────────────

describe('SharedArrayBuffer environment check', () => {
  it('SigningWorkerManager throws a descriptive error when SAB unavailable', async () => {
    const original = globalThis.SharedArrayBuffer;
    try {
      // @ts-expect-error — intentionally removing for this test
      delete globalThis.SharedArrayBuffer;

      const { SigningWorkerManager } = await import('./signingWorkerManager');
      const manager = new SigningWorkerManager();

      await expect(manager.init()).rejects.toThrow(
        /Cross-Origin-Opener-Policy.*Cross-Origin-Embedder-Policy/s,
      );
    } finally {
      globalThis.SharedArrayBuffer = original;
    }
  });
});
