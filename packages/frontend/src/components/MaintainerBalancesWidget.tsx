"use client";

import React from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { trpcClient } from "@/trpc/client";
import { PayoutCard } from "./PayoutCard";
import { EmptyMaintainersState } from "./EmptyMaintainersState";
import { ErrorBoundary } from "./ErrorBoundary";

interface MaintainerBalancesWidgetProps {
  orgId: string;
  onClaim: (address: string) => Promise<void>;
  claimingAddress: string | null;
  onAllocateClick: () => void;
}

export function MaintainerBalancesWidget({ 
  orgId, 
  onClaim, 
  claimingAddress, 
  onAllocateClick 
}: MaintainerBalancesWidgetProps) {
  const { data: rawBalances } = useSuspenseQuery({
    queryKey: ["maintainer-balances", orgId],
    queryFn: () => trpcClient.organization.getMaintainerBalances.query({ orgId }),
    staleTime: 30 * 1000,
  });

  const balances = rawBalances?.map(b => ({
    ...b,
    stroops: BigInt(b.stroops),
  }));

  if (!balances || balances.length === 0) {
    return (
      <EmptyMaintainersState
        orgId={orgId}
        onAllocateClick={onAllocateClick}
      />
    );
  }

  return (
    <div>
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-white/40">
        Maintainers ({balances.length})
      </h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {balances.map((balance) => (
          <ErrorBoundary key={balance.address} variant="inline">
            <PayoutCard
              balance={balance as any}
              onClaim={onClaim}
              isClaiming={claimingAddress === balance.address}
            />
          </ErrorBoundary>
        ))}
      </div>
    </div>
  );
}
