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

function makeElementTarget(
  id: string,
  el: Element | null,
  prefetch: PrefetchTarget["prefetch"],
): PrefetchTarget {
  return {
    id,
    getRect: () => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    },
    getElement: () => el,
    prefetch,
  };
}

class FakeIntersectionObserver {
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit;
  readonly elements: Set<Element> = new Set();

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.callback = callback;
    this.options = options ?? {};
  }

  observe(target: Element): void {
    this.elements.add(target);
  }

  unobserve(target: Element): void {
    this.elements.delete(target);
  }

  disconnect(): void {
    this.elements.clear();
  }

  /** Simulate an element entering the viewport. */
  fireIntersecting(target: Element): void {
    this.callback(
      [
        {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
          boundingClientRect: {} as DOMRectReadOnly,
          intersectionRect: {} as DOMRectReadOnly,
          rootBounds: null,
          time: performance.now(),
        },
      ],
      this as unknown as IntersectionObserver,
    );
  }
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

describe("PredictivePrefetchEngine - IntersectionObserver fallback", () => {
  let fakeIo: FakeIntersectionObserver;

  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }),
    );
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(
        (cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) => {
          fakeIo = new FakeIntersectionObserver(cb, opts);
          return fakeIo;
        },
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to IntersectionObserver on coarse pointer", () => {
    const prefetch = vi.fn().mockResolvedValue(undefined);
    const engine = new PredictivePrefetchEngine({
      requireFinePointer: true,
    });

    const el = document.createElement("div");
    engine.setTargets([
      makeElementTarget("org-1", el, prefetch),
    ]);
    engine.start();

    expect(fakeIo).toBeDefined();
    expect(fakeIo.elements.has(el)).toBe(true);
    expect(prefetch).not.toHaveBeenCalled();

    engine.stop();
    expect(fakeIo.elements.size).toBe(0);
  });

  it("prefetches when an element becomes intersecting", async () => {
    const prefetch = vi.fn().mockResolvedValue(undefined);
    const debug = vi.fn();
    const engine = new PredictivePrefetchEngine({
      requireFinePointer: true,
      cooldownMs: 0,
      globalCooldownMs: 0,
      onDebug: debug,
    });

    const el = document.createElement("div");
    engine.setTargets([
      makeElementTarget("org-1", el, prefetch),
    ]);
    engine.start();

    fakeIo.fireIntersecting(el);
    await Promise.resolve();

    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ type: "io-prefetch", targetId: "org-1" }),
    );

    engine.stop();
  });

  it("respects cooldown between IO-fallback prefetches", async () => {
    const prefetch = vi.fn().mockResolvedValue(undefined);
    const engine = new PredictivePrefetchEngine({
      requireFinePointer: true,
      cooldownMs: 5000,
      globalCooldownMs: 0,
    });

    const el = document.createElement("div");
    engine.setTargets([
      makeElementTarget("org-1", el, prefetch),
    ]);
    engine.start();

    fakeIo.fireIntersecting(el);
    await Promise.resolve();
    expect(prefetch).toHaveBeenCalledTimes(1);

    fakeIo.fireIntersecting(el);
    await Promise.resolve();
    expect(prefetch).toHaveBeenCalledTimes(1); // cooldown

    engine.stop();
  });

  it("skips targets without an element reference", () => {
    const prefetch = vi.fn().mockResolvedValue(undefined);
    const debug = vi.fn();
    const engine = new PredictivePrefetchEngine({
      requireFinePointer: true,
      cooldownMs: 0,
      globalCooldownMs: 0,
      onDebug: debug,
    });

    // Target without getElement
    engine.setTargets([
      makeTarget("no-el", { left: 0, top: 0, right: 100, bottom: 100 }, prefetch),
    ]);
    engine.start();

    expect(fakeIo.elements.size).toBe(0);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ type: "io-skip", targetId: "no-el", reason: "no-element" }),
    );

    engine.stop();
  });

  it("reconnects IO when setTargets is called", () => {
    const prefetch = vi.fn().mockResolvedValue(undefined);
    const engine = new PredictivePrefetchEngine({
      requireFinePointer: true,
    });

    const el1 = document.createElement("div");
    engine.setTargets([
      makeElementTarget("t1", el1, prefetch),
    ]);
    engine.start();

    expect(fakeIo.elements.has(el1)).toBe(true);

    const el2 = document.createElement("div");
    engine.setTargets([
      makeElementTarget("t2", el2, prefetch),
    ]);

    expect(fakeIo.elements.has(el1)).toBe(false);
    expect(fakeIo.elements.has(el2)).toBe(true);

    engine.stop();
  });
});
