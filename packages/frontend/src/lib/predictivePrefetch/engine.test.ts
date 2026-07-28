import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PredictivePrefetchEngine, type PrefetchTarget } from "./engine";

function makeTarget(
  id: string,
  rect: { left: number; top: number; right: number; bottom: number },
  prefetch: PrefetchTarget["prefetch"],
): PrefetchTarget {
  return {
    id,
    getRect: () => rect,
    prefetch,
  };
}

describe("PredictivePrefetchEngine", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true, addListener: vi.fn(), removeListener: vi.fn() }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fires prefetch when trajectory confidence exceeds threshold", async () => {
    const prefetch = vi.fn().mockResolvedValue(undefined);
    const debug = vi.fn();
    const engine = new PredictivePrefetchEngine({
      requireFinePointer: false,
      confidenceThreshold: 0.7,
      cooldownMs: 0,
      globalCooldownMs: 0,
      onDebug: debug,
    });

    engine.setTargets([
      makeTarget("fund", { left: 200, top: 100, right: 320, bottom: 160 }, prefetch),
    ]);

    // Approach from the left at 1 px/ms → ~200ms ETA to x=200
    engine.pushSample(0, 130, 1000);
    engine.pushSample(50, 130, 1050);
    engine.pushSample(100, 130, 1100);
    engine.evaluateNow(1100);

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ type: "prefetch", targetId: "fund" }),
    );
    expect(prefetch).toHaveBeenCalledTimes(1);

    engine.stop();
  });

  it("debounces repeat fires for the same target", async () => {
    const prefetch = vi.fn().mockResolvedValue(undefined);
    const engine = new PredictivePrefetchEngine({
      requireFinePointer: false,
      confidenceThreshold: 0.7,
      cooldownMs: 5000,
      globalCooldownMs: 0,
    });

    engine.setTargets([
      makeTarget("org-1", { left: 200, top: 100, right: 320, bottom: 160 }, prefetch),
    ]);

    const approach = (t0: number) => {
      // Clear history so each approach is an independent 1px/ms aim
      engine.pushSample(0, 130, t0);
      engine.pushSample(40, 130, t0 + 40);
      engine.pushSample(80, 130, t0 + 80);
      engine.evaluateNow(t0 + 80);
    };

    approach(1000);
    expect(prefetch).toHaveBeenCalledTimes(1);
    approach(3000); // outside cooldown window for global, but target cooldown is 5s
    expect(prefetch).toHaveBeenCalledTimes(1);
    engine.stop();
  });

  it("cancels in-flight prefetch when confidence collapses", async () => {
    let captured: AbortSignal | null = null;
    const prefetch = vi.fn().mockImplementation((signal: AbortSignal) => {
      captured = signal;
      return new Promise(() => undefined); // never settles
    });

    const debug = vi.fn();
    const engine = new PredictivePrefetchEngine({
      requireFinePointer: false,
      confidenceThreshold: 0.7,
      cancelConfidence: 0.4,
      cooldownMs: 0,
      globalCooldownMs: 0,
      onDebug: debug,
    });

    engine.setTargets([
      makeTarget("org-1", { left: 200, top: 100, right: 320, bottom: 160 }, prefetch),
    ]);

    // Fire
    engine.pushSample(0, 130, 1000);
    engine.pushSample(100, 130, 1100);
    engine.evaluateNow(1100);
    await Promise.resolve();
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();

    // Swerve away — velocity now points up, away from target
    engine.pushSample(100, 130, 1200);
    engine.pushSample(100, 30, 1300);
    engine.evaluateNow(1300);

    expect(captured!.aborted).toBe(true);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cancel", targetId: "org-1" }),
    );

    engine.stop();
  });

  it("skips evaluation when velocity is too low", () => {
    const prefetch = vi.fn();
    const engine = new PredictivePrefetchEngine({
      requireFinePointer: false,
      confidenceThreshold: 0.5,
    });

    engine.setTargets([
      makeTarget("org-1", { left: 200, top: 100, right: 320, bottom: 160 }, prefetch),
    ]);

    engine.pushSample(0, 130, 1000);
    engine.pushSample(1, 130, 1100); // ~0.01 px/ms
    engine.evaluateNow(1100);

    expect(prefetch).not.toHaveBeenCalled();
    engine.stop();
  });
});
