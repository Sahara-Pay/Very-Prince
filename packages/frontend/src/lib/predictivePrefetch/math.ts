/**
 * @file math.ts
 * @description Pure 2D vector helpers for mouse-trajectory collision scoring.
 * Kept allocation-light so a rAF tick stays well under 1% of a 16.7ms frame.
 */

export type Vec2 = { x: number; y: number };

export type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type TrajectorySample = {
  x: number;
  y: number;
  t: number; // performance.now() ms
};

/** Squared length — avoids Math.sqrt in hot paths. */
export function len2(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}

export function len(v: Vec2): number {
  return Math.sqrt(len2(v));
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function normalize(v: Vec2): Vec2 | null {
  const l = len(v);
  if (l < 1e-6) return null;
  return { x: v.x / l, y: v.y / l };
}

/**
 * Velocity in px/ms from the oldest→newest sample window.
 * Returns null when the window is too short or empty.
 */
export function velocityFromSamples(
  samples: readonly TrajectorySample[],
): Vec2 | null {
  if (samples.length < 2) return null;
  const a = samples[0]!;
  const b = samples[samples.length - 1]!;
  const dt = b.t - a.t;
  if (dt < 8) return null; // need ≥ ~½ frame of history
  return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
}

/**
 * Expand a DOMRect-like box by padding (px) for forgiving hit tests.
 */
export function expandRect(rect: Rect, padding: number): Rect {
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding,
  };
}

export function rectCenter(rect: Rect): Vec2 {
  return {
    x: (rect.left + rect.right) * 0.5,
    y: (rect.top + rect.bottom) * 0.5,
  };
}

export function pointInRect(p: Vec2, rect: Rect): boolean {
  return (
    p.x >= rect.left &&
    p.x <= rect.right &&
    p.y >= rect.top &&
    p.y <= rect.bottom
  );
}

/**
 * 2D slab-method ray vs AABB.
 * Ray: origin + t * dir, t ≥ 0. `dir` need not be unit length.
 * Returns entry distance along the ray in the same units as dir*t, or null.
 */
export function rayIntersectsRect(
  origin: Vec2,
  dir: Vec2,
  rect: Rect,
): number | null {
  let tMin = 0;
  let tMax = Number.POSITIVE_INFINITY;

  // X slabs
  if (Math.abs(dir.x) < 1e-9) {
    if (origin.x < rect.left || origin.x > rect.right) return null;
  } else {
    let t1 = (rect.left - origin.x) / dir.x;
    let t2 = (rect.right - origin.x) / dir.x;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  // Y slabs
  if (Math.abs(dir.y) < 1e-9) {
    if (origin.y < rect.top || origin.y > rect.bottom) return null;
  } else {
    let t1 = (rect.top - origin.y) / dir.y;
    let t2 = (rect.bottom - origin.y) / dir.y;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  if (tMax < 0) return null;
  return tMin >= 0 ? tMin : 0;
}

export type CollisionScore = {
  /** 0..1 confidence that the cursor is aiming at this target. */
  confidence: number;
  /** Estimated ms until intersection at current velocity (Infinity if none). */
  etaMs: number;
  /** True when the projected point or ray hits the padded rect. */
  intersects: boolean;
};

/**
 * Score how likely the cursor trajectory will hit `rect` within the
 * prediction horizon. Designed so confident hits land ~100–300ms out.
 */
export function scoreTrajectoryCollision(
  origin: Vec2,
  velocityPxPerMs: Vec2,
  rect: Rect,
  options: {
    paddingPx?: number;
    horizonMs?: number;
    minSpeedPxPerMs?: number;
    idealEtaMinMs?: number;
    idealEtaMaxMs?: number;
  } = {},
): CollisionScore {
  const paddingPx = options.paddingPx ?? 12;
  const horizonMs = options.horizonMs ?? 280;
  const minSpeed = options.minSpeedPxPerMs ?? 0.15; // ~150 px/s
  const idealMin = options.idealEtaMinMs ?? 100;
  const idealMax = options.idealEtaMaxMs ?? 300;

  const speed = len(velocityPxPerMs);
  if (speed < minSpeed) {
    return { confidence: 0, etaMs: Number.POSITIVE_INFINITY, intersects: false };
  }

  const padded = expandRect(rect, paddingPx);
  const center = rectCenter(padded);

  // Already over the target — hover-adjacent; leave to native hover prefetch.
  if (pointInRect(origin, padded)) {
    return { confidence: 0, etaMs: 0, intersects: true };
  }

  const toCenter = sub(center, origin);
  const dir = normalize(velocityPxPerMs);
  if (!dir) {
    return { confidence: 0, etaMs: Number.POSITIVE_INFINITY, intersects: false };
  }

  const alignment = Math.max(0, dot(dir, normalize(toCenter) ?? { x: 0, y: 0 }));

  // Ray parameter t is in "ms" because dir is velocity (px/ms).
  const tHit = rayIntersectsRect(origin, velocityPxPerMs, padded);
  const projected = add(origin, scale(velocityPxPerMs, horizonMs));
  const projectedHits = pointInRect(projected, padded);
  const intersects = tHit !== null || projectedHits;

  if (!intersects) {
    // Soft miss: proximity of projected tip to rect center, gated by alignment.
    const tipDist = len(sub(projected, center));
    const soft = Math.max(0, 1 - tipDist / 220) * alignment * 0.45;
    return {
      confidence: soft,
      etaMs: Number.POSITIVE_INFINITY,
      intersects: false,
    };
  }

  const etaMs =
    tHit !== null
      ? tHit
      : len(sub(projected, origin)) / speed; /* projected hit fallback */

  // Prefer ETAs inside the 100–300ms acceptance window.
  let etaFactor = 0;
  if (etaMs >= idealMin && etaMs <= idealMax) {
    etaFactor = 1;
  } else if (etaMs > 0 && etaMs < idealMin) {
    etaFactor = etaMs / idealMin; // too soon — still useful but weaker
  } else if (etaMs > idealMax && etaMs <= horizonMs * 1.4) {
    etaFactor = Math.max(0, 1 - (etaMs - idealMax) / idealMax);
  }

  const confidence = Math.min(1, alignment * 0.55 + etaFactor * 0.45);
  return { confidence, etaMs, intersects: true };
}
