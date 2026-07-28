"use client";

import React from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { trpcClient } from "@/trpc/client";

interface OrgDetailsWidgetProps {
  orgId: string;
  onShowFundModal: () => void;
  onShowAllocateModal: () => void;
}

export function OrgDetailsWidget({ orgId, onShowFundModal, onShowAllocateModal }: OrgDetailsWidgetProps) {
  const { data: orgData } = useSuspenseQuery({
    queryKey: ["organization", orgId],
    queryFn: () => trpcClient.organization.get.query({ id: orgId }),
    staleTime: 30 * 1000,
  });

  if (!orgData) return null;

  return (
    <div className="glass-card mb-8 p-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-stellar-purple to-stellar-teal font-bold text-white">
          {orgData.name.charAt(0).toUpperCase()}
        </div>
        <div>
          <h3 className="font-semibold text-white">{orgData.name}</h3>
          <p className="font-mono text-xs text-white/40">ID: {orgData.id}</p>
        </div>
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-black/20 px-4 py-3">
        <p className="text-xs font-medium text-white/40">Admin Address</p>
        <p className="mt-1 break-all font-mono text-sm text-white/70">
          {orgData.admin}
        </p>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-xl border border-stellar-teal/20 bg-stellar-teal/5 p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-stellar-teal/80">
            Available Budget
          </p>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight text-white">
              {orgData.budgetXlm}
            </span>
            <span className="text-sm font-medium text-stellar-teal">XLM</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onShowAllocateModal}
            className="rounded-lg border border-stellar-purple/30 bg-stellar-purple/10 px-5 py-2.5 text-sm font-semibold text-stellar-purple hover:bg-stellar-purple/20 transition-all"
          >
            Allocate Payout
          </button>
          <button
            onClick={onShowFundModal}
            className="rounded-lg bg-white/10 px-5 py-2.5 text-sm font-semibold text-white hover:bg-stellar-teal transition-all"
          >
            Fund Org
          </button>
        </div>
      </div>
    </div>
  );
}
