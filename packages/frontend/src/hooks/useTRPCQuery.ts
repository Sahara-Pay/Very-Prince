/**
 * @file useTRPCQuery.ts
 * @description React Query hooks for tRPC with type safety.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { hashObject } from '../utils/hash';
import { trpcClient } from '../trpc/client';

// Organization hooks
export function useOrganization(id: string) {
  return useQuery({
    queryKey: ['organization', id],
    queryFn: () => trpcClient.organization.get.query({ id }),
    enabled: !!id,
    staleTime: 30 * 1000, // 30 seconds
    isDataEqual: (oldData, newData) => hashObject(oldData) === hashObject(newData),
  });
}

export function useOrganizationsList(params: { page?: number; limit?: number; search?: string } = {}) {
  return useQuery({
    queryKey: ['organizations', params],
    queryFn: () => trpcClient.organization.list.query(params),
    staleTime: 60 * 1000, // 1 minute
    isDataEqual: (oldData, newData) => hashObject(oldData) === hashObject(newData),
  });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: { id: string; name: string; admin: string; signerSecret: string }) =>
      trpcClient.organization.create.mutate(data),
    onSuccess: () => {
      // Invalidate organizations list to refresh data
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
  });
}

// Contract hooks
export function useContractStatus() {
  return useQuery({
    queryKey: ['contract-status'],
    queryFn: () => trpcClient.contract.getStatus.query(),
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchInterval: 5 * 60 * 1000, // Refresh every 5 minutes
    isDataEqual: (oldData, newData) => hashObject(oldData) === hashObject(newData),
  });
}

export function useContractDetails() {
  return useQuery({
    queryKey: ['contract-details'],
    queryFn: () => trpcClient.contract.getDetails.query(),
    staleTime: 10 * 60 * 1000, // 10 minutes
    isDataEqual: (oldData, newData) => hashObject(oldData) === hashObject(newData),
  });
}

// Stats hooks
export function useStatsOverview() {
  return useQuery({
    queryKey: ['stats-overview'],
    queryFn: () => trpcClient.stats.getOverview.query(),
    staleTime: 2 * 60 * 1000, // 2 minutes
    refetchInterval: 2 * 60 * 1000, // Refresh every 2 minutes
    isDataEqual: (oldData, newData) => hashObject(oldData) === hashObject(newData),
  });
}
