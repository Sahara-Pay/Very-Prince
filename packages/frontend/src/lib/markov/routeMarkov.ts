/**
 * @file routeMarkov.ts
 * @description Client-side Markov chain(s) that learn navigation patterns so we
 * can predictively prefetch data before the user clicks.
 *
 * IMPORTANT ARCHITECTURE NOTE: in this app, `/dashboard/org/[id]` is a server
 * redirect shim (see app/dashboard/org/[id]/page.tsx) — it immediately
 * `redirect()`s to `/dashboard?org=<id>` and is never actually rendered
 * client-side. That means the org identity lives in a *search param*, not the
 * pathname, so a pathname-only Markov chain can't distinguish "viewing org A"
 * from "viewing org B" — both are just `/dashboard`.
 *
 * We therefore use two cooperating chains:
 *  - RouteMarkovChain: predicts which *page pattern* comes next (e.g.
 *    "/organizations" -> "/dashboard?org"), used to decide *whether* to
 *    prefetch at all.
 *  - OrgMarkovChain: predicts which *org id* comes next, given the last org
 *    the user viewed (e.g. maintainers who routinely check the same 2-3
 *    orgs). Used to decide *what* to prefetch once the route chain says an
 *    org-view is likely.
 */

const ROUTE_STORAGE_KEY = "vp:route-markov:v1";
const ORG_STORAGE_KEY = "vp:org-markov:v1";
const MAX_STATES = 60; // bound memory / localStorage size
const MIN_SAMPLES_FOR_PREDICTION = 2; // avoid over-confident predictions from 1 data point

interface TransitionRecord {
  counts: Record<string, number>;
  lastHref: Record<string, string>;
}

type MatrixShape = Record<string, TransitionRecord>;

export interface Prediction {
  key: string;
  href: string;
  probability: number;
}

// ── Route pattern normalization ──────────────────────────────────────────

const STATIC_DYNAMIC_PATTERNS: Array<{ regex: RegExp; pattern: string }> = [
  { regex: /^\/profile\/[^/]+\/?$/, pattern: "/profile/[address]" },
];

/**
 * Collapse a concrete pathname (+ presence of an `org` search param) into a
 * route pattern for use as a Markov state. `/dashboard` and `/dashboard` with
 * `?org=` are treated as distinct states, since the org view is functionally
 * a different "page" even though the pathname is identical.
 */
export function normalizeRoute(pathname: string, hasOrgParam: boolean): string {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  if (clean === "/dashboard" && hasOrgParam) return "/dashboard?org";

  for (const { regex, pattern } of STATIC_DYNAMIC_PATTERNS) {
    if (regex.test(clean)) return pattern;
  }
  return clean || "/";
}

// ── Generic transition matrix (shared implementation) ────────────────────

class TransitionMatrix {
  protected matrix: MatrixShape = {};
  private dirty = false;

  constructor(initial?: MatrixShape) {
    if (initial) this.matrix = initial;
  }

  recordTransition(from: string, to: string, toHref: string): void {
    if (!from || !to || from === to) return;

    if (!this.matrix[from]) {
      if (Object.keys(this.matrix).length >= MAX_STATES) this.evictLeastUsed();
      this.matrix[from] = { counts: {}, lastHref: {} };
    }

    const record = this.matrix[from]!;
    record.counts[to] = (record.counts[to] ?? 0) + 1;
    record.lastHref[to] = toHref;
    this.dirty = true;
  }

  predict(from: string): Prediction[] {
    const record = this.matrix[from];
    if (!record) return [];

    const total = Object.values(record.counts).reduce((sum, n) => sum + n, 0);
    if (total < MIN_SAMPLES_FOR_PREDICTION) return [];

    return Object.entries(record.counts)
      .map(([key, count]) => ({
        key,
        href: record.lastHref[key] ?? key,
        probability: count / total,
      }))
      .sort((a, b) => b.probability - a.probability);
  }

  private evictLeastUsed(): void {
    let minKey: string | null = null;
    let minTotal = Infinity;
    for (const [key, record] of Object.entries(this.matrix)) {
      const total = Object.values(record.counts).reduce((s, n) => s + n, 0);
      if (total < minTotal) {
        minTotal = total;
        minKey = key;
      }
    }
    if (minKey) delete this.matrix[minKey];
  }

  toJSON(): MatrixShape {
    return this.matrix;
  }

  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  markSaved(): void {
    this.dirty = false;
  }
}

/** Predicts the next route pattern given the current one. */
export class RouteMarkovChain extends TransitionMatrix {}

/** Predicts the next org id given the current one (e.g. repeat maintainer checks). */
export class OrgMarkovChain extends TransitionMatrix {}

// ── Persistence (localStorage, best-effort) ─────────────────────────────

function load(key: string): MatrixShape | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as MatrixShape) : undefined;
  } catch {
    return undefined; // corrupt/inaccessible storage — start fresh
  }
}

function save(key: string, chain: TransitionMatrix): void {
  if (typeof window === "undefined" || !chain.hasUnsavedChanges()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(chain.toJSON()));
    chain.markSaved();
  } catch {
    // Storage full/unavailable — predictions still work in-memory this session.
  }
}

export function loadRouteMarkovChain(): RouteMarkovChain {
  return new RouteMarkovChain(load(ROUTE_STORAGE_KEY));
}

export function saveRouteMarkovChain(chain: RouteMarkovChain): void {
  save(ROUTE_STORAGE_KEY, chain);
}

export function loadOrgMarkovChain(): OrgMarkovChain {
  return new OrgMarkovChain(load(ORG_STORAGE_KEY));
}

export function saveOrgMarkovChain(chain: OrgMarkovChain): void {
  save(ORG_STORAGE_KEY, chain);
}
