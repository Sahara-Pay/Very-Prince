import { describe, expect, it } from "vitest";
import {
  expandRect,
  pointInRect,
  rayIntersectsRect,
  scoreTrajectoryCollision,
  velocityFromSamples,
  type Rect,
} from "./math";

const target: Rect = { left: 200, top: 100, right: 320, bottom: 160 };

describe("velocityFromSamples", () => {
  it("returns null with fewer than 2 samples", () => {
    expect(velocityFromSamples([])).toBeNull();
    expect(velocityFromSamples([{ x: 0, y: 0, t: 0 }])).toBeNull();
  });

  it("computes px/ms from the sample window", () => {
    const v = velocityFromSamples([
      { x: 0, y: 0, t: 0 },
      { x: 100, y: 0, t: 100 },
    ]);
    expect(v).toEqual({ x: 1, y: 0 });
  });
});

describe("rayIntersectsRect", () => {
  it("detects a head-on hit from the left", () => {
    const t = rayIntersectsRect({ x: 0, y: 130 }, { x: 2, y: 0 }, target);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(0);
  });

  it("misses when aimed away", () => {
    const t = rayIntersectsRect({ x: 0, y: 130 }, { x: -1, y: 0 }, target);
    expect(t).toBeNull();
  });

  it("returns 0 when origin is already inside", () => {
    const t = rayIntersectsRect({ x: 250, y: 130 }, { x: 1, y: 0 }, target);
    expect(t).toBe(0);
  });
});

describe("scoreTrajectoryCollision", () => {
  it("scores a clear 100–300ms approach highly", () => {
    // 240px at 1 px/ms → 240ms ETA into the left edge (200)
    const score = scoreTrajectoryCollision(
      { x: 0, y: 130 },
      { x: 1, y: 0 },
      target,
      { horizonMs: 280, paddingPx: 0 },
    );
    expect(score.intersects).toBe(true);
    expect(score.etaMs).toBeGreaterThanOrEqual(100);
    expect(score.etaMs).toBeLessThanOrEqual(300);
    expect(score.confidence).toBeGreaterThan(0.72);
  });

  it("returns near-zero confidence when stationary", () => {
    const score = scoreTrajectoryCollision(
      { x: 0, y: 130 },
      { x: 0.01, y: 0 },
      target,
    );
    expect(score.confidence).toBe(0);
  });

  it("does not fire when cursor is already over the target", () => {
    const score = scoreTrajectoryCollision(
      { x: 250, y: 130 },
      { x: 1, y: 0 },
      target,
    );
    expect(score.intersects).toBe(true);
    expect(score.confidence).toBe(0);
  });

  it("soft-scores a near miss with good alignment", () => {
    const score = scoreTrajectoryCollision(
      { x: 0, y: 40 },
      { x: 1, y: 0 },
      target,
      { paddingPx: 0, horizonMs: 280 },
    );
    expect(score.intersects).toBe(false);
    expect(score.confidence).toBeGreaterThan(0);
    expect(score.confidence).toBeLessThan(0.72);
  });
});

describe("expandRect / pointInRect", () => {
  it("expands symmetrically", () => {
    const e = expandRect(target, 10);
    expect(e).toEqual({ left: 190, top: 90, right: 330, bottom: 170 });
    expect(pointInRect({ x: 195, y: 100 }, e)).toBe(true);
  });
});
