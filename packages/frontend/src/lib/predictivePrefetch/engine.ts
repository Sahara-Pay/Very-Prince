/**
 * @file engine.ts
 * @description rAF-bound mouse trajectory engine that triggers prefetch
 * callbacks when collision confidence exceeds a threshold, with debounce
 * and cancellation for invalid predictions.
 */

import {
  scoreTrajectoryCollision,
  velocityFromSamples,
  type Rect,
  type TrajectorySample,
  type Vec2,
} from "./math";

export type PrefetchTarget = {
  /** Stable id used for debounce / in-flight tracking. */
  id: string;
  /** Live geometry; return null when the element is unmounted / hidden. */
  getRect: () => Rect | null;
  /**
   * Kick off the network work. May receive an AbortSignal so callers can
   * cancel in-flight work when the trajectory invalidates.
   */
  prefetch: (signal: AbortSignal) => void | Promise<void>;
  /**
   * Live element reference for IntersectionObserver fallback on mobile.
   * Called lazily so it captures the element after refs are committed.
   */
  getElement?: () => Element | null;
};

export type PredictivePrefetchOptions = {
  /** Confidence [0,1] required to fire a prefetch. Default 0.72. */
  confidenceThreshold?: number;
  /** Drop below this after a fire → cancel in-flight. Default 0.35. */
  cancelConfidence?: number;
  /** Max samples retained for velocity. Default 8. */
  maxSamples?: number;
  /** Sample window max age (ms). Default 120. */
  sampleWindowMs?: number;
  /** Prediction horizon (ms). Default 280. */
  horizonMs?: number;
  /** Per-target cooldown after a successful trigger (ms). Default 1500. */
  cooldownMs?: number;
  /** Global min gap between any two prefetch fires (ms). Default 80. */
  globalCooldownMs?: number;
  /** Hit-test padding (px). Default 12. */
  paddingPx?: number;
  /** Disable on coarse pointers / when matchMedia says so. Default true. */
  requireFinePointer?: boolean;
  /**
   * rootMargin for IntersectionObserver fallback. Ignored on fine-pointer
   * devices. Default "200px".
   */
  intersectionMargin?: string;
  /** Optional debug sink (tests / telemetry). */
  onDebug?: (event: PredictivePrefetchDebugEvent) => void;
};

export type PredictivePrefetchDebugEvent =
  | { type: "prefetch"; targetId: string; confidence: number; etaMs: number }
  | { type: "cancel"; targetId: string; reason: string }
  | { type: "skip"; targetId: string; reason: string }
  | { type: "io-prefetch"; targetId: string }
  | { type: "io-skip"; targetId: string; reason: string };

type InFlight = {
  controller: AbortController;
  targetId: string;
};

const DEFAULTS = {
  confidenceThreshold: 0.72,
  cancelConfidence: 0.35,
  maxSamples: 8,
  sampleWindowMs: 120,
  horizonMs: 280,
  cooldownMs: 1500,
  globalCooldownMs: 80,
  paddingPx: 12,
  requireFinePointer: true,
  intersectionMargin: "200px",
} as const;

/**
 * Lightweight predictive prefetch engine.
 *
 * Pointer events only store samples; all math runs inside rAF so the event
 * handler stays cheap and frame work stays batched.
 */
export class PredictivePrefetchEngine {
  private readonly opts: Required<
    Omit<PredictivePrefetchOptions, "onDebug">
  > & { onDebug?: PredictivePrefetchOptions["onDebug"] };

  private targets: PrefetchTarget[] = [];
  private samples: TrajectorySample[] = [];
  private rafId: number | null = null;
  private running = false;
  private lastPointer: Vec2 | null = null;
  private lastGlobalFireAt = 0;
  private readonly lastFireAt = new Map<string, number>();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly prefetchedOnce = new Set<string>();
  private io: IntersectionObserver | null = null;

  constructor(options: PredictivePrefetchOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  setTargets(targets: PrefetchTarget[]): void {
    this.targets = targets;
    if (this.io && this.running) {
      this.connectIntersectionObserver();
    }
  }

  /** Begin listening. No-ops on server or coarse pointers when configured. */
  start(): void {
    if (typeof window === "undefined" || this.running) return;

    this.running = true;

    if (this.opts.requireFinePointer && !this.hasFinePointer()) {
      this.startIntersectionObserver();
      return;
    }

    window.addEventListener("pointermove", this.onPointerMove, {
      passive: true,
    });
    window.addEventListener("pointerdown", this.onPointerDown, {
      passive: true,
    });
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (typeof window === "undefined") return;
    this.running = false;
    this.stopIntersectionObserver();
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    if (this.rafId != null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.cancelAll("engine-stop");
    this.samples = [];
    this.lastPointer = null;
  }

  /** Test seam: feed a pointer sample without DOM events. */
  pushSample(x: number, y: number, t = performance.now()): void {
    this.lastPointer = { x, y };
    this.samples.push({ x, y, t });
    this.trimSamples(t);
  }

  /** Test seam: run one evaluation tick. */
  evaluateNow(now = performance.now()): void {
    this.evaluate(now);
  }

  /** Test seam: inspect internal sample / pointer state. */
  getDebugState(): {
    sampleCount: number;
    lastPointer: Vec2 | null;
    targetCount: number;
  } {
    return {
      sampleCount: this.samples.length,
      lastPointer: this.lastPointer,
      targetCount: this.targets.length,
    };
  }

  private startIntersectionObserver(): void {
    if (typeof window === "undefined") return;
    this.io = new IntersectionObserver(this.handleIntersection, {
      rootMargin: this.opts.intersectionMargin,
      threshold: 0,
    });
    this.connectIntersectionObserver();
  }

  private stopIntersectionObserver(): void {
    if (!this.io) return;
    this.io.disconnect();
    this.io = null;
  }

  private connectIntersectionObserver(): void {
    if (!this.io) return;
    this.io.disconnect();
    for (const target of this.targets) {
      const el = target.getElement?.();
      if (!el) {
        this.opts.onDebug?.({
          type: "io-skip",
          targetId: target.id,
          reason: "no-element",
        });
        continue;
      }
      this.io.observe(el);
    }
  }

  private readonly handleIntersection = (
    entries: IntersectionObserverEntry[],
  ): void => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const target = this.targets.find((t) => {
        const el = t.getElement?.();
        return el === entry.target;
      });
      if (!target) continue;

      if (this.inFlight.has(target.id)) {
        this.opts.onDebug?.({
          type: "io-skip",
          targetId: target.id,
          reason: "in-flight",
        });
        continue;
      }

      const now = performance.now();
      const last = this.lastFireAt.get(target.id);
      if (last != null && now - last < this.opts.cooldownMs) {
        this.opts.onDebug?.({
          type: "io-skip",
          targetId: target.id,
          reason: "target-cooldown",
        });
        continue;
      }

      if (
        this.lastGlobalFireAt > 0 &&
        now - this.lastGlobalFireAt < this.opts.globalCooldownMs
      ) {
        this.opts.onDebug?.({
          type: "io-skip",
          targetId: target.id,
          reason: "global-cooldown",
        });
        continue;
      }

      if (this.prefetchedOnce.has(target.id)) {
        this.opts.onDebug?.({
          type: "io-skip",
          targetId: target.id,
          reason: "already-prefetched",
        });
        continue;
      }

      this.opts.onDebug?.({ type: "io-prefetch", targetId: target.id });

      const controller = new AbortController();
      this.inFlight.set(target.id, { controller, targetId: target.id });
      this.lastFireAt.set(target.id, now);
      this.lastGlobalFireAt = now;
      this.prefetchedOnce.add(target.id);

      try {
        Promise.resolve(target.prefetch(controller.signal))
          .catch(() => {})
          .finally(() => {
            this.inFlight.delete(target.id);
          });
      } catch {
        this.inFlight.delete(target.id);
      }
    }
  };

  private hasFinePointer(): boolean {
    try {
      return window.matchMedia("(pointer: fine)").matches;
    } catch {
      return true;
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "touch") return;
    this.pushSample(event.clientX, event.clientY, performance.now());
  };

  private readonly onPointerDown = (): void => {
    // Click committed — drop pending predictions; network already in flight is fine.
    this.cancelAll("pointerdown");
    this.samples = [];
  };

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.evaluate(now);
    this.rafId = window.requestAnimationFrame(this.tick);
  };

  private trimSamples(now: number): void {
    const cutoff = now - this.opts.sampleWindowMs;
    while (this.samples.length && this.samples[0]!.t < cutoff) {
      this.samples.shift();
    }
    while (this.samples.length > this.opts.maxSamples) {
      this.samples.shift();
    }
  }

  private evaluate(now: number): void {
    this.trimSamples(now);
    const velocity = velocityFromSamples(this.samples);
    const origin = this.lastPointer;
    if (!velocity || !origin) return;

    let best: { target: PrefetchTarget; confidence: number; etaMs: number } | null =
      null;

    for (const target of this.targets) {
      const rect = target.getRect();
      if (!rect) continue;

      const score = scoreTrajectoryCollision(origin, velocity, rect, {
        paddingPx: this.opts.paddingPx,
        horizonMs: this.opts.horizonMs,
      });

      // Cancel invalid in-flight predictions when confidence collapses.
      const flying = this.inFlight.get(target.id);
      if (flying && score.confidence < this.opts.cancelConfidence) {
        this.cancelTarget(target.id, "confidence-drop");
      }

      if (score.confidence < this.opts.confidenceThreshold) continue;
      if (!best || score.confidence > best.confidence) {
        best = { target, confidence: score.confidence, etaMs: score.etaMs };
      }
    }

    if (!best) return;
    this.maybePrefetch(best.target, best.confidence, best.etaMs, now);
  }

  private maybePrefetch(
    target: PrefetchTarget,
    confidence: number,
    etaMs: number,
    now: number,
  ): void {
    if (this.inFlight.has(target.id)) {
      this.opts.onDebug?.({
        type: "skip",
        targetId: target.id,
        reason: "in-flight",
      });
      return;
    }

    const last = this.lastFireAt.get(target.id);
    if (last != null && now - last < this.opts.cooldownMs) {
      this.opts.onDebug?.({
        type: "skip",
        targetId: target.id,
        reason: "target-cooldown",
      });
      return;
    }

    if (
      this.lastGlobalFireAt > 0 &&
      now - this.lastGlobalFireAt < this.opts.globalCooldownMs
    ) {
      this.opts.onDebug?.({
        type: "skip",
        targetId: target.id,
        reason: "global-cooldown",
      });
      return;
    }

    // One successful prefetch per target per session mount is enough —
    // React Query / router caches do the rest. Cuts wasted API load.
    if (this.prefetchedOnce.has(target.id)) {
      this.opts.onDebug?.({
        type: "skip",
        targetId: target.id,
        reason: "already-prefetched",
      });
      return;
    }

    const controller = new AbortController();
    this.inFlight.set(target.id, { controller, targetId: target.id });
    this.lastFireAt.set(target.id, now);
    this.lastGlobalFireAt = now;
    this.prefetchedOnce.add(target.id);

    this.opts.onDebug?.({
      type: "prefetch",
      targetId: target.id,
      confidence,
      etaMs,
    });

    // Invoke immediately so tests / callers can observe the AbortSignal without
    // waiting a microtask; still settle via Promise for error isolation.
    try {
      Promise.resolve(target.prefetch(controller.signal))
        .catch(() => {
          /* swallow — prefetch is best-effort */
        })
        .finally(() => {
          this.inFlight.delete(target.id);
        });
    } catch {
      this.inFlight.delete(target.id);
    }
  }

  private cancelTarget(targetId: string, reason: string): void {
    const flying = this.inFlight.get(targetId);
    if (!flying) return;
    flying.controller.abort();
    this.inFlight.delete(targetId);
    // Allow a later genuine approach to prefetch again.
    this.prefetchedOnce.delete(targetId);
    this.opts.onDebug?.({ type: "cancel", targetId, reason });
  }

  private cancelAll(reason: string): void {
    for (const id of [...this.inFlight.keys()]) {
      this.cancelTarget(id, reason);
    }
  }
}
