/**
 * @file prefetchActions.ts
 * @description Concrete prefetch payloads for dashboard / org interactive targets.
 */

import type { QueryClient } from "@tanstack/react-query";
import {
  readMaintainers,
  readOrgBudget,
  readOrganization,
} from "@/lib/sorobanClient";
import { trpcClient } from "@/trpc/client";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001/api";

/**
 * Warm the org → dashboard path:
 * - Next.js route flight (`router.prefetch`) — RSC / soft-nav warm
 * - React Query org bundle matching `useOrganizationData` (Soroban)
 * - Funding history matching `FundingHistoryChart` (REST)
 * - tRPC `organization.get` under a dedicated key (no cache collision)
 */
export async function prefetchOrganizationIntent(
  orgId: string,
  deps: {
    queryClient: QueryClient;
    router: { prefetch: (href: string) => void };
    signal?: AbortSignal;
  },
): Promise<void> {
  const { queryClient, router, signal } = deps;
  if (signal?.aborted) return;

  router.prefetch(`/dashboard?org=${orgId}`);

  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };

  const orgBundle = queryClient.prefetchQuery({
    queryKey: ["organization", orgId],
    queryFn: async () => {
      throwIfAborted();
      const [organization, budget, maintainers] = await Promise.all([
        readOrganization(orgId),
        readOrgBudget(orgId),
        readMaintainers(orgId),
      ]);
      return { organization, budget, maintainers };
    },
    staleTime: 60_000,
  });

  const fundingHistory = queryClient.prefetchQuery({
    queryKey: ["funding-history", orgId],
    queryFn: async () => {
      throwIfAborted();
      const res = await fetch(
        `${BACKEND_URL}/stats/funding-history/${orgId}`,
        signal ? { signal } : undefined,
      );
      if (!res.ok) throw new Error("Failed to prefetch funding history");
      return res.json();
    },
    staleTime: 60_000,
  });

  // Dedicated key — `useOrganization` / `useOrganizationData` share
  // `["organization", id]` but return different shapes.
  const trpcOrg = queryClient.prefetchQuery({
    queryKey: ["trpc", "organization.get", orgId],
    queryFn: async () => {
      throwIfAborted();
      return trpcClient.organization.get.query({ id: orgId });
    },
    staleTime: 30_000,
  });

  await Promise.allSettled([orgBundle, fundingHistory, trpcOrg]);
}

/**
 * Warm the Fund Org modal path: dynamic JS chunk before mousedown.
 */
export async function prefetchFundOrgIntent(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await import("@/components/FundOrgModal");
}
