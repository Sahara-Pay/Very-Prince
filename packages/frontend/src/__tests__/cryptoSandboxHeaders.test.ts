/**
 * Tests asserting that the cross-origin isolation headers required by the
 * off-main-thread crypto-signing sandbox (#381) are configured in both
 * `packages/frontend/next.config.mjs` (used by `next build` /
 * `next start`) and `vercel.json` (used by Vercel's edge platform).
 *
 * `SharedArrayBuffer` only becomes available in the browser once the
 * `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers
 * are present (otherwise `self.crossOriginIsolated` is `false`). These
 * tests read the config files as text and assert the presence of both
 * required headers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../');

const NEXT_CONFIG_PATH = resolve(REPO_ROOT, 'packages/frontend/next.config.mjs');
const VERCEL_CONFIG_PATH = resolve(REPO_ROOT, 'vercel.json');

function readNextConfig(): string {
  return readFileSync(NEXT_CONFIG_PATH, 'utf8');
}

function readVercelConfig(): { headers?: Array<{ source?: string; headers?: Array<{ key?: string; value?: string }> }> } {
  return JSON.parse(readFileSync(VERCEL_CONFIG_PATH, 'utf8'));
}

describe('next.config.mjs', () => {
  it('declares a top-level `headers` (async function) returning COOP/COEP', () => {
    const src = readNextConfig();
    // Header names assigned in the file.
    expect(src).toMatch(/Cross-Origin-Opener-Policy/);
    expect(src).toMatch(/Cross-Origin-Embedder-Policy/);
  });

  it('uses Cross-Origin-Opener-Policy: same-origin', () => {
    const src = readNextConfig();
    expect(src).toMatch(/Cross-Origin-Opener-Policy['"]?\s*[,:]\s*['"]same-origin['"]/);
  });

  it('uses Cross-Origin-Embedder-Policy: require-corp', () => {
    const src = readNextConfig();
    expect(src).toMatch(/Cross-Origin-Embedder-Policy['"]?\s*[,:]\s*['"]require-corp['"]/);
  });

  it('exposes the headers via `async headers()` so next dev and next start both apply them', () => {
    const src = readNextConfig();
    expect(src).toMatch(/async\s+headers\s*\(\s*\)\s*{/);
    // The wildcard source must be `/(.*)` so every page gets the policy.
    expect(src).toMatch(/source:\s*['"]\/\(\.\*\)['"]/);
  });
});

describe('vercel.json (production edge)', () => {
  it('has a top-level `headers` array', () => {
    const cfg = readVercelConfig();
    expect(Array.isArray(cfg.headers)).toBe(true);
  });

  it('declares a wildcard entry applying COOP+COEP at the edge', () => {
    const cfg = readVercelConfig();
    const wildcard = (cfg.headers ?? []).find((entry) => entry.source === '/(.*)');
    expect(wildcard).toBeDefined();
    const keys = (wildcard?.headers ?? []).map((h) => h.key);
    expect(keys).toContain('Cross-Origin-Opener-Policy');
    expect(keys).toContain('Cross-Origin-Embedder-Policy');
    expect(keys).toContain('Cross-Origin-Resource-Policy');
  });

  it('vercel COOP value is `same-origin`', () => {
    const cfg = readVercelConfig();
    const coop = (cfg.headers ?? [])
      .flatMap((entry) => entry.headers ?? [])
      .find((h) => h.key === 'Cross-Origin-Opener-Policy');
    expect(coop?.value).toBe('same-origin');
  });

  it('vercel COEP value is `require-corp`', () => {
    const cfg = readVercelConfig();
    const coep = (cfg.headers ?? [])
      .flatMap((entry) => entry.headers ?? [])
      .find((h) => h.key === 'Cross-Origin-Embedder-Policy');
    expect(coep?.value).toBe('require-corp');
  });
});

describe('cross-file invariants', () => {
  it('vercel.json and next.config.mjs agree on header values', () => {
    const src = readNextConfig();
    const cfg = readVercelConfig();

    const vercelCoop = (cfg.headers ?? [])
      .flatMap((entry) => entry.headers ?? [])
      .find((h) => h.key === 'Cross-Origin-Opener-Policy')?.value;
    const vercelCoep = (cfg.headers ?? [])
      .flatMap((entry) => entry.headers ?? [])
      .find((h) => h.key === 'Cross-Origin-Embedder-Policy')?.value;

    expect(src).toContain(`same-origin`);
    expect(src).toContain(`require-corp`);
    expect(vercelCoop).toBe('same-origin');
    expect(vercelCoep).toBe('require-corp');
  });
});
