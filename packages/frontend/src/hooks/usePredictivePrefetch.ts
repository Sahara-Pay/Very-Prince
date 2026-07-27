/**
 * @file usePredictivePrefetch.ts
 * @description React binding for {@link PredictivePrefetchEngine}.
 */

"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  PredictivePrefetchEngine,
  type PrefetchTarget,
  type PredictivePrefetchOptions,
} from "@/lib/predictivePrefetch/engine";

export type UsePredictivePrefetchOptions = PredictivePrefetchOptions & {
  /** When false, the engine is stopped. Default true. */
  enabled?: boolean;
  targets: PrefetchTarget[];
};

/**
 * Starts a rAF trajectory loop for the given targets and tears it down on
 * unmount or when `enabled` flips false. Targets are refreshed every render
 * via `setTargets` without restarting the loop.
 */
export function usePredictivePrefetch({
  targets,
  enabled = true,
  ...engineOptions
}: UsePredictivePrefetchOptions): void {
  const engineRef = useRef<PredictivePrefetchEngine | null>(null);

  // Stable options identity for start/stop — recreate engine if knobs change.
  const optionsKey = useMemo(
    () =>
      JSON.stringify({
        confidenceThreshold: engineOptions.confidenceThreshold,
        cancelConfidence: engineOptions.cancelConfidence,
        cooldownMs: engineOptions.cooldownMs,
        horizonMs: engineOptions.horizonMs,
        requireFinePointer: engineOptions.requireFinePointer,
      }),
    [
      engineOptions.confidenceThreshold,
      engineOptions.cancelConfidence,
      engineOptions.cooldownMs,
      engineOptions.horizonMs,
      engineOptions.requireFinePointer,
    ],
  );

  useEffect(() => {
    if (!enabled) {
      engineRef.current?.stop();
      engineRef.current = null;
      return;
    }

    const engine = new PredictivePrefetchEngine(engineOptions);
    engineRef.current = engine;
    engine.setTargets(targets);
    engine.start();

    return () => {
      engine.stop();
      if (engineRef.current === engine) engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionsKey stands in for engineOptions
  }, [enabled, optionsKey]);

  useEffect(() => {
    engineRef.current?.setTargets(targets);
  }, [targets]);
}

/**
 * Build a target from an element ref + prefetch callback.
 */
export function targetFromElement(
  id: string,
  el: Element | null | undefined,
  prefetch: PrefetchTarget["prefetch"],
): PrefetchTarget | null {
  if (!el) return null;
  return {
    id,
    getRect: () => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      };
    },
    prefetch,
  };
}
