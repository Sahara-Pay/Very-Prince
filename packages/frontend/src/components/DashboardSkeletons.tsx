import React from 'react';

/**
 * Skeleton for the organization details header widget.
 */
export function OrgDetailsSkeleton() {
  return (
    <div className="glass-card mb-8 p-6 animate-pulse">
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
      <div className="mt-4 h-24 rounded-xl bg-white/5 border border-white/10" />
    </div>
  );
}

/**
 * Skeleton for the funding history chart.
 */
export function FundingHistorySkeleton() {
  return (
    <div className="glass-card mb-8 p-6 animate-pulse">
      <div className="h-4 w-40 rounded bg-white/20 mb-6" />
      <div className="h-[300px] w-full rounded bg-white/5" />
    </div>
  );
}

/**
 * Skeleton for the maintainer balances grid.
 */
export function MaintainerBalancesSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-4 w-32 rounded bg-white/20 animate-pulse" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="glass-card p-5 animate-pulse">
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
