"use client";

/**
 * @file useRoutePrefetcher.ts
 * @description Predictive prefetching for App Router navigation.
 *
 * Learns two things from the user's own navigation history:
 *  1. Which page pattern tends to come next (RouteMarkovChain) — used to
 *     decide whether an org-detail view is likely coming up.
 *  2. Which org id tends to come next, given the last org viewed
 *     (OrgMarkovChain) — since `/dashboard/org/[id]` immediately redirects to
 *     `/dashboard?org=<id>` server-side, the org identity only ever shows up
 *     as a search param on `/dashboard`, never as its own pathname.
 *
 * When both signals agree with enough confidence, we warm the Next.js router
 * cache for the predicted href AND the React Query cache entry that
 * useOrganizationData() will ask for — using the exact same queryKey — so the
 * eventual real navigation hits cache instead of refetching.
 *
 * App Router has no `router.events` (Pages Router only), so navigation is
 * detected by watching `usePathname()` / `useSearchParams()` and diffing
 * against the prior values.
 */

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  loadRouteMarkovChain,
  saveRouteMarkovChain,
  loadOrgMarkovChain,
  saveOrgMarkovChain,
  normalizeRoute,
} from "@/lib/markov/routeMarkov";
import { readOrganization, readOrgBudget, readMaintainers } from "@/lib/sorobanClient";

const PREFETCH_THRESHOLD = 0.75;
const ORG_VIEW_PATTERN = "/dashboard?org";

// Module-level singletons so the models persist across navigations within the
// session without re-reading localStorage on every route change.
const routeChain = loadRouteMarkovChain();
const orgChain = loadOrgMarkovChain();

export function useRoutePrefetcher(): void {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  const prevPatternRef = useRef<string | null>(null);
  const prevOrgIdRef = useRef<string | null>(null);

  const orgId = pathname === "/dashboard" ? searchParams.get("org") : null;
  const currentPattern = normalizeRoute(pathname, !!orgId);

  useEffect(() => {
    // ── Record observed transitions ──────────────────────────────────────
    if (prevPatternRef.current && prevPatternRef.current !== currentPattern) {
      routeChain.recordTransition(prevPatternRef.current, currentPattern, pathname);
      schedule(() => saveRouteMarkovChain(routeChain));
    }
    if (orgId && prevOrgIdRef.current && prevOrgIdRef.current !== orgId) {
      orgChain.recordTransition(prevOrgIdRef.current, orgId, `/dashboard?org=${orgId}`);
      schedule(() => saveOrgMarkovChain(orgChain));
    }

    // ── Predict and prefetch ─────────────────────────────────────────────
    const [topRoutePrediction] = routeChain.predict(currentPattern);
    if (topRoutePrediction && topRoutePrediction.probability >= PREFETCH_THRESHOLD) {
      if (topRoutePrediction.key === ORG_VIEW_PATTERN) {
        // An org-detail view is likely next — figure out *which* org.
        const lastKnownOrgId = orgId ?? prevOrgIdRef.current;
        const [topOrgPrediction] = lastKnownOrgId ? orgChain.predict(lastKnownOrgId) : [];
        schedule(() =>
          dispatchOrgPrefetch(topOrgPrediction?.key ?? null, router, queryClient)
        );
      } else {
        schedule(() => router.prefetch(topRoutePrediction.href));
      }
    }

    prevPatternRef.current = currentPattern;
    if (orgId) prevOrgIdRef.current = orgId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPattern, orgId, pathname, router, queryClient]);
}

/** Defer non-urgent work so it never blocks the current frame (no main-thread jank). */
function schedule(work: () => void): void {
  if (typeof window === "undefined") return;
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(work, { timeout: 2000 });
  } else {
    setTimeout(work, 0);
  }
}

function dispatchOrgPrefetch(
  predictedOrgId: string | null,
  router: ReturnType<typeof useRouter>,
  queryClient: QueryClient
): void {
  if (!predictedOrgId) {
    // We know an org view is likely, but don't yet have enough history to
    // guess which org — still worth warming the route shell itself.
    router.prefetch("/dashboard");
    return;
  }

  router.prefetch(`/dashboard?org=${predictedOrgId}`);

  // Mirrors useOrganizationData's queryKey/queryFn exactly, so the eventual
  // useQuery() call on navigation hits this warmed cache entry instead of refetching.
  void queryClient.prefetchQuery({
    queryKey: ["organization", predictedOrgId],
    queryFn: async () => {
      const [organization, budget, maintainers] = await Promise.all([
        readOrganization(predictedOrgId),
        readOrgBudget(predictedOrgId),
        readMaintainers(predictedOrgId),
      ]);
      return { organization, budget, maintainers };
    },
    staleTime: 60 * 1000,
  });
}
