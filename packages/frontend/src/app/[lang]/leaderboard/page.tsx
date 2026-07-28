"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GlassPanel } from "@/components/GlassPanel";
import { GlassButton } from "@/components/GlassButton";
import { fetchTopMaintainers, type TopMaintainer } from "@/lib/api";
import { Locale } from "@/lib/i18n";
import { getDictionary } from "@/lib/getDictionary";
import type { Dictionary } from "@/lib/getDictionary";

interface LeaderboardPageProps {
  params: {
    lang: Locale;
  };
}

export default function LeaderboardPage({ params }: LeaderboardPageProps) {
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ["leaderboard", params.lang],
    queryFn: async () => {
      const [maintainers, dictionary] = await Promise.all([
        fetchTopMaintainers(),
        getDictionary(params.lang),
      ]);
      return { maintainers, dictionary };
    },
  });

  const maintainers: TopMaintainer[] = data?.maintainers ?? [];
  const dictionary: Dictionary | undefined = data?.dictionary;

  const truncateAddress = (address: string) => {
    if (!address) return "";
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  const handleCopy = (address: string) => {
    navigator.clipboard.writeText(address);
    setCopiedAddress(address);
    setTimeout(() => setCopiedAddress(null), 2000);
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stellar-blue">
        <div className="text-xl font-medium text-white/60 animate-pulse">
          {dictionary?.common.loading || "Loading..."}
        </div>
      </div>
    );
  }

  if (error || !dictionary) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stellar-blue">
        <div className="text-xl font-medium text-red-400">
          {error instanceof Error ? error.message : "An error occurred"}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stellar-blue px-6 py-12 md:py-24">
      {/* 
          Internal Documentation: Leaderboard Mechanics
          
          The leaderboard is a transparency tool designed to gamify open-source 
          contributions. By highlighting top earners, we aim to:
          
          1. Increase visibility for active maintainers.
          2. Encourage organizations to increase their payout budgets.
          3. Provide social proof for contributors' impact on the ecosystem.
          
          Data Integrity:
          - All earnings data is pulled directly from Stellar Soroban events.
          - The "Organizations Assisted" count reflects unique org IDs found 
            in the `allocate_payout` event topics.
          - Rank calculation is performed server-side with a 5-minute cache 
            to ensure performance without sacrificing data freshness.
          
          UX Considerations:
          - Glassmorphism primitives are used to maintain visual consistency 
            with the rest of the application.
          - Address truncation prevents UI clutter while maintaining the 
            cryptographic identity of the maintainers.
          - The "Copy Address" utility provides a seamless way for others to 
            send additional tips or contact the maintainers.
      */}
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-12 text-center animate-fade-in">
          <h1 className="mb-4 text-4xl font-bold tracking-tight text-white md:text-5xl lg:text-6xl">
            {dictionary.leaderboard.title}
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-white/60">
            {dictionary.leaderboard.description}
          </p>
        </div>

        {/* Leaderboard Table */}
        <GlassPanel className="overflow-hidden border border-white/10 shadow-2xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-white/10 bg-white/5 text-sm font-semibold uppercase tracking-wider text-white/40">
                  <th className="px-6 py-4">{dictionary.leaderboard.rank}</th>
                  <th className="px-6 py-4">{dictionary.leaderboard.maintainer}</th>
                  <th className="px-6 py-4 text-right">{dictionary.leaderboard.orgs_assisted}</th>
                  <th className="px-6 py-4 text-right">{dictionary.leaderboard.earnings}</th>
                  <th className="px-6 py-4 text-center">{dictionary.dashboard.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {maintainers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-white/40">
                      No maintainers found yet.
                    </td>
                  </tr>
                ) : (
                  maintainers.map((maintainer, index) => (
                    <tr 
                      key={maintainer.address} 
                      className="group transition-colors hover:bg-white/5"
                    >
                      <td className="px-6 py-6">
                        <div className={`flex h-8 w-8 items-center justify-center rounded-full font-bold ${
                          index === 0 ? "bg-yellow-400/20 text-yellow-400" :
                          index === 1 ? "bg-slate-300/20 text-slate-300" :
                          index === 2 ? "bg-amber-600/20 text-amber-600" :
                          "bg-white/5 text-white/40"
                        }`}>
                          {index + 1}
                        </div>
                      </td>
                      <td className="px-6 py-6">
                        <div className="flex flex-col">
                          <span className="font-mono text-sm font-medium text-white">
                            {truncateAddress(maintainer.address)}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-6 text-right">
                        <span className="rounded-full bg-stellar-purple/10 px-3 py-1 text-xs font-semibold text-stellar-purple border border-stellar-purple/20">
                          {maintainer.organizationsAssisted}
                        </span>
                      </td>
                      <td className="px-6 py-6 text-right">
                        <div className="flex flex-col items-end">
                          <span className="text-lg font-bold text-stellar-teal">
                            {maintainer.totalEarningsXlm} XLM
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-6 text-center">
                        <GlassButton
                          variant="secondary"
                          onClick={() => handleCopy(maintainer.address)}
                          className="!px-3 !py-1.5 text-xs"
                        >
                          {copiedAddress === maintainer.address 
                            ? dictionary.leaderboard.address_copied 
                            : dictionary.leaderboard.copy_address}
                        </GlassButton>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}
