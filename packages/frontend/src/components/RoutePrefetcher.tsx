"use client";

/**
 * @file RoutePrefetcher.tsx
 * @description Mounts the predictive route-prefetching hook. Renders nothing.
 * Wrapped in Suspense because the hook uses useSearchParams(), which requires
 * one during static rendering (same requirement as app/dashboard/page.tsx).
 */

import { Suspense } from "react";
import { useRoutePrefetcher } from "@/hooks/useRoutePrefetcher";

function RoutePrefetcherInner() {
  useRoutePrefetcher();
  return null;
}

export default function RoutePrefetcher() {
  return (
    <Suspense fallback={null}>
      <RoutePrefetcherInner />
    </Suspense>
  );
}
