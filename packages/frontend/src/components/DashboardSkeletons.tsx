import React from 'react';

/**
 * Skeleton for the organization details header widget.
 * Matches exact geometric dimensions, padding, margins, and border layout of OrgDetailsWidget.
 */
export function OrgDetailsSkeleton() {
  return (
    <div className="glass-card mb-8 p-6 animate-pulse" aria-label="Organization Details Skeleton">
      <div className="mb-4 flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-white/10" />
        <div className="space-y-2">
          <div className="h-5 w-32 rounded bg-white/20" />
          <div className="h-3 w-20 rounded bg-white/10" />
        </div>
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-black/20 px-4 py-3 space-y-2">
        <div className="h-3 w-24 rounded bg-white/10" />
        <div className="h-4 w-full rounded bg-white/20" />
      </div>
      <div className="mt-4 flex items-center justify-between rounded-xl border border-stellar-teal/20 bg-stellar-teal/5 p-4">
        <div className="space-y-2">
          <div className="h-3 w-24 rounded bg-white/10" />
          <div className="h-7 w-32 rounded bg-white/20" />
        </div>
        <div className="flex gap-2">
          <div className="h-10 w-32 rounded-lg bg-white/10" />
          <div className="h-10 w-24 rounded-lg bg-white/10" />
        </div>
      </div>
    </div>
  );
}

/**
 * Skeleton for the funding history chart.
 * Matches exact header controls, card padding, and 240px chart geometric dimensions of FundingHistoryChart.
 */
export function FundingHistorySkeleton() {
  return (
    <div className="glass-card mb-8 p-6 animate-pulse" aria-label="Funding History Skeleton">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div className="space-y-2">
          <div className="h-4 w-40 rounded bg-white/20" />
          <div className="h-3 w-64 rounded bg-white/10" />
        </div>
        <div className="h-9 w-48 rounded-lg bg-white/10" />
      </div>
      <div className="h-[240px] w-full rounded-xl bg-white/5 border border-white/[0.06]" />
    </div>
  );
}

/**
 * Skeleton for the maintainer balances grid.
 * Matches exact grid layout, gap, title styling, and payout card dimensions of MaintainerBalancesWidget.
 */
export function MaintainerBalancesSkeleton() {
  return (
    <div className="mb-8 space-y-4 animate-pulse" aria-label="Maintainer Balances Skeleton">
      <div className="h-4 w-32 rounded bg-white/20" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="glass-card p-5">
            <div className="flex justify-between items-start mb-4">
              <div className="h-4 w-24 rounded bg-white/20" />
              <div className="h-4 w-16 rounded bg-white/10" />
            </div>
            <div className="h-8 w-32 rounded bg-white/20 mb-4" />
            <div className="h-10 w-full rounded bg-white/10" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Skeleton for non-critical related asset tokens.
 * Matches exact layout and dimensions of RelatedTokensWidget.
 */
export function RelatedTokensSkeleton() {
  return (
    <div className="glass-card mb-8 p-6 animate-pulse" aria-label="Related Tokens Skeleton">
      <div className="h-4 w-40 rounded bg-white/20 mb-4" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-xl border border-white/[0.08] bg-white/[0.04] p-4 space-y-2">
            <div className="flex justify-between items-center">
              <div className="h-4 w-12 rounded bg-white/20" />
              <div className="h-3 w-10 rounded bg-white/10" />
            </div>
            <div className="h-3 w-20 rounded bg-white/10" />
            <div className="h-5 w-16 rounded bg-white/20 mt-2" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Unified combined fallback skeleton loader for the full dashboard.
 */
export function DashboardFallbackSkeleton() {
  return (
    <div className="space-y-8 w-full">
      <OrgDetailsSkeleton />
      <FundingHistorySkeleton />
      <MaintainerBalancesSkeleton />
      <RelatedTokensSkeleton />
    </div>
  );
}
