/**
 * @file EmptyMaintainersState.tsx
 * @description A premium empty state component for organizations with no maintainers.
 */

"use client";

interface EmptyMaintainersStateProps {
  orgId: string;
  onAllocateClick: () => void;
}

export function EmptyMaintainersState({ orgId, onAllocateClick }: EmptyMaintainersStateProps) {
  return (
    <div className="glass-card relative overflow-hidden p-8 md:p-12 text-center flex flex-col items-center justify-center border border-white/[0.08] bg-white/[0.02] backdrop-blur-md rounded-2xl shadow-xl transition-all duration-300 hover:border-stellar-purple/30">
      {/* Background ambient glow */}
      <div className="absolute -top-24 -left-24 h-48 w-48 rounded-full bg-stellar-purple/10 blur-[80px] pointer-events-none" />
      <div className="absolute -bottom-24 -right-24 h-48 w-48 rounded-full bg-stellar-teal/10 blur-[80px] pointer-events-none" />

      {/* Illustrative Icon */}
      <div className="relative mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-stellar-purple/20 to-stellar-teal/20 text-white shadow-inner">
        <div className="absolute inset-0.5 rounded-[14px] bg-stellar-blue/80" />
        <svg
          className="relative h-10 w-10 text-white/75 drop-shadow-[0_0_8px_rgba(123,97,255,0.5)]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z"
          />
        </svg>
      </div>

      {/* Content */}
      <h4 className="mb-2 text-xl font-bold tracking-tight text-white">
        No Maintainers Registered
      </h4>
      <p className="mx-auto mb-8 max-w-md text-sm text-white/50 leading-relaxed">
        There are currently no maintainers registered for the organization{" "}
        <span className="font-mono text-stellar-teal bg-white/[0.05] px-2 py-0.5 rounded text-xs border border-white/5">
          {orgId}
        </span>. You can allocate a new payout to automatically register a maintainer and set up their claimable balance.
      </p>

      {/* CTA Button */}
      <button
        onClick={onAllocateClick}
        className="group relative inline-flex items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-stellar-purple to-stellar-teal p-[1px] font-semibold text-white shadow-lg shadow-stellar-purple/20 transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98]"
      >
        <span className="relative flex items-center gap-2 rounded-[11px] bg-stellar-blue px-6 py-3 transition-colors group-hover:bg-transparent">
          <svg
            className="h-4 w-4 text-stellar-teal group-hover:text-white transition-colors"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Allocate First Payout
        </span>
      </button>
    </div>
  );
}
