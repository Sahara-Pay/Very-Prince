/**
 * @file useOrganizationData.ts
 * @description Wraps Soroban org reads in React Query so concurrent mounts
 * share a single cached request instead of firing duplicate network calls.
 */

import { useQuery } from "@tanstack/react-query";
import { readOrganization, readOrgBudget, readMaintainers } from "@/lib/sorobanClient";

export function useOrganizationData(orgId: string | undefined) {
  return useQuery({
    queryKey: ["organization", orgId],
    queryFn: async () => {
      if (!orgId) throw new Error("orgId is required");
      const [organization, budget, maintainers] = await Promise.all([
        readOrganization(orgId),
        readOrgBudget(orgId),
        readMaintainers(orgId),
      ]);
      return { organization, budget, maintainers };
    },
    enabled: !!orgId,
    staleTime: 60 * 1000,
  });
}