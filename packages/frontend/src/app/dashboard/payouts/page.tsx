"use client";

import { useState } from "react";
import { useUnifiedWallet } from "@/hooks/useUnifiedWallet";
import { GlassButton } from "@/components/GlassButton";
import { useSSEWithSWR } from "@/hooks/useSSE";
import { useQuery } from "@tanstack/react-query";

interface PendingPayout {
  orgId: string;
  amountStroops: string;
  amountXlm: string;
  orgName?: string;
}

/**
 * @file dashboard/payouts/page.tsx
 * @description View and claim pending payouts within the dashboard.
 */
export default function DashboardPayoutsPage() {
  const { isConnected, publicKey, claimPayout, isSigning } = useUnifiedWallet();
  const [isExporting, setIsExporting] = useState(false);

  // Enable SSE for real-time updates
  useSSEWithSWR();

  // Fetch pending payouts for the connected wallet
  const { data: payouts, error, isLoading, refetch } = useQuery({
    queryKey: ["payouts", publicKey],
    enabled: isConnected && Boolean(publicKey),
    queryFn: async () => {
      const url = `/api/v1/contract/maintainer/${publicKey}`;
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001"}${url}`
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch payouts: ${response.statusText}`);
      }
      const data = await response.json();

      return data.map((payout: any) => ({
        ...payout,
        amountXlm: (Number(payout.amountStroops) / 10_000_000).toFixed(2),
      }));
    },
  });

  const handleClaimAll = async () => {
    if (!payouts || payouts.length === 0) return;

    try {
      for (const payout of payouts) {
        await claimPayout(payout.orgId);
      }
      void refetch();
    } catch (err) {
      console.error("Error claiming payouts:", err);
    }
  };

  const handleExport = async () => {
    if (!payouts) return;

    setIsExporting(true);
    try {
      const csv = [
        ["Organization ID", "Amount (XLM)", "Amount (Stroops)"],
        ...payouts.map((p: PendingPayout) => [p.orgId, p.amountXlm, p.amountStroops]),
      ]
        .map((row) => row.join(","))
        .join("\n");

      const blob = new Blob([csv], { type: "text/csv" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `payouts-${new Date().toISOString().split("T")[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } finally {
      setIsExporting(false);
    }
  };

  const totalXlm = payouts
    ? payouts.reduce((sum: number, p: PendingPayout) => sum + parseFloat(p.amountXlm), 0).toFixed(2)
    : "0.00";

  return (
    <div className="space-y-8">
      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">My Payouts</h1>
          <p className="mt-2 text-white/60">
            View and claim your pending payouts
          </p>
        </div>
      </div>

      {/* ── Wallet Connection Status ──────────────────────────────────────────── */}
      {!isConnected ? (
        <div className="rounded-xl bg-stellar-purple/10 border border-stellar-purple/30 p-6">
          <h3 className="font-semibold text-white mb-2">Wallet Connection Required</h3>
          <p className="text-white/70 mb-4">
            Connect your Stellar wallet to view and claim your payouts.
          </p>
        </div>
      ) : (
        <>
          {/* ── Summary Card ──────────────────────────────────────────────────── */}
          {payouts && payouts.length > 0 && (
            <div className="glass-panel p-6">
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <p className="text-white/60 text-sm">Total Payouts</p>
                  <p className="text-2xl font-bold text-stellar-teal mt-2">{payouts.length}</p>
                </div>
                <div>
                  <p className="text-white/60 text-sm">Total Amount</p>
                  <p className="text-2xl font-bold text-stellar-purple mt-2">{totalXlm} XLM</p>
                </div>
                <div className="flex items-end justify-end gap-2">
                  <GlassButton
                    variant="secondary"
                    onClick={handleExport}
                    disabled={isExporting}
                  >
                    {isExporting ? "Exporting..." : "Export CSV"}
                  </GlassButton>
                </div>
              </div>
            </div>
          )}

          {/* ── Content ────────────────────────────────────────────────────────── */}
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-white/60">Loading payouts...</div>
            </div>
          ) : error ? (
            <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-6">
              <p className="text-red-200">Failed to load payouts. Please try again.</p>
            </div>
          ) : payouts && payouts.length > 0 ? (
            <>
              <div className="space-y-3">
                {payouts.map((payout: PendingPayout, index: number) => (
                  <div key={index} className="glass-card p-4 hover:bg-white/6 transition-all">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-white">{payout.orgId}</p>
                        <p className="text-xs text-white/50 mt-1">
                          {payout.amountXlm} XLM ({payout.amountStroops} stroops)
                        </p>
                      </div>
                      <GlassButton
                        variant="secondary"
                        onClick={() => claimPayout(payout.orgId)}
                        disabled={isSigning}
                      >
                        {isSigning ? "Claiming..." : "Claim"}
                      </GlassButton>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-3">
                <GlassButton
                  variant="primary"
                  onClick={handleClaimAll}
                  disabled={isSigning}
                >
                  {isSigning ? "Processing..." : "Claim All"}
                </GlassButton>
              </div>
            </>
          ) : (
            <div className="rounded-xl bg-white/5 border border-white/10 p-12 text-center">
              <p className="text-white/60">No pending payouts</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
