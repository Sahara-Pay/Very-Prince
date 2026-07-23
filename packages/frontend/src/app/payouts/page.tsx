/**
 * @file payouts/page.tsx
 * @description Maintainer dashboard for viewing and claiming payouts.
 */

"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "@tanstack/react-query";
import useSWR from "swr";
import { WalletButton } from "@/components/WalletButton";
import { useSSEWithSWR } from "@/hooks/useSSE";
import { useUnifiedWallet } from "@/hooks/useUnifiedWallet";

interface PendingPayout {
  orgId: string;
  amountStroops: string;
  amountXlm: string;
  orgName?: string;
}

interface PayoutEntry {
  orgId: string;
  amountStroops: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
}

interface ProfileStats {
  address: string;
  totalStroops: string;
  totalXlm: string;
  orgIds: string[];
  payouts: PayoutEntry[];
}

function formatXlm(stroops: string): string {
  return (Number(stroops) / 10_000_000).toFixed(2);
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PayoutsPage() {
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
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001"}${url}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch payouts: ${response.statusText}`);
      }
      const data = await response.json();

      // Transform data to include XLM amount
      return data.map((payout: any) => ({
        ...payout,
        amountXlm: (Number(payout.amountStroops) / 10_000_000).toFixed(2),
      }));
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  // Fetch transaction history (claimed payouts) for the connected wallet
  const { data: historyData, error: historyError, isLoading: isHistoryLoading } = useSWR<ProfileStats>(
    isConnected && publicKey ? [`/api/v1/profile/${publicKey}/stats`] : null,
    async ([url]) => {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001"}${url}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch transaction history: ${response.statusText}`);
      }
      return response.json();
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
    }
  );

  const exportMutation = useMutation({
    mutationFn: async (format: 'csv' | 'json') => {
      if (!publicKey) return;
      const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
      const url = new URL(`/api/export/payouts/${publicKey}`, baseUrl);
      url.searchParams.set('type', format);

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Export failed: ${response.statusText}`);
      }

      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = `payout-history-${publicKey}-${new Date().toISOString().split('T')[0]}.${format}`;

      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1];
        }
      }

      return { blob: await response.blob(), filename };
    },
    onSuccess: (data) => {
      if (!data) return;
      const downloadUrl = window.URL.createObjectURL(data.blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = data.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);
    },
    onError: (error) => {
      console.error("Export failed:", error);
      alert(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    },
  });

  const handleClaimPayout = async (orgId: string) => {
    try {
      await claimPayout(orgId);
      // Refresh the payouts list after successful claim
      await refetch();
    } catch (error) {
      console.error("Failed to claim payout:", error);
    }
  };

  const handleExportData = async (format: 'csv' | 'json') => {
    if (!publicKey) return;

    setIsExporting(true);
    exportMutation.mutate(format, {
      onSettled: () => setIsExporting(false),
    });
  };

  if (!isConnected) {
    return (
      <div className="flex min-h-screen flex-col">
        {/* Navigation */}
        <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-stellar-blue/80 backdrop-blur-xl">
          <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <div className="flex items-center gap-4">
              <Link href="/" className="flex items-center gap-2 text-white/60 transition-colors hover:text-white">
                <span className="text-sm font-bold">VP</span>
              </Link>
              <span className="text-white/20">/</span>
              <Link href="/dashboard" className="text-sm text-white/60 hover:text-white">Dashboard</Link>
              <span className="text-white/20">/</span>
              <h1 className="text-sm font-semibold text-white">Payouts</h1>
            </div>
            <WalletButton />
          </nav>
        </header>

        <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-20">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-white mb-4">Connect Your Wallet</h2>
            <p className="text-white/60 mb-8">
              Please connect your Freighter wallet to view and claim your pending payouts.
            </p>
            <WalletButton />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* Navigation */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-stellar-blue/80 backdrop-blur-xl">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2 text-white/60 transition-colors hover:text-white">
              <span className="text-sm font-bold">VP</span>
              </Link>
            <span className="text-white/20">/</span>
            <Link href="/dashboard" className="text-sm text-white/60 hover:text-white">Dashboard</Link>
            <span className="text-white/20">/</span>
            <h1 className="text-sm font-semibold text-white">Payouts</h1>
          </div>
          <WalletButton />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10 space-y-12">
        {/* Payouts Header & Pending Section */}
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-3xl font-bold text-white mb-2">Your Payouts</h2>
              <p className="text-white/50">
                Manage and claim your pending payouts from organizations you contribute to.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleExportData('csv')}
                disabled={isExporting}
                aria-label={isExporting ? "Exporting data as CSV" : "Export payouts as CSV"}
                className="rounded-lg bg-white/10 hover:bg-white/20 px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isExporting ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"></div>
                    Exporting...
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Export CSV
                  </>
                )}
              </button>
              <button
                onClick={() => handleExportData('json')}
                disabled={isExporting}
                aria-label={isExporting ? "Exporting data as JSON" : "Export payouts as JSON"}
                className="rounded-lg bg-white/10 hover:bg-white/20 px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isExporting ? (
                  <>
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"></div>
                    Exporting...
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Export JSON
                  </>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {error.message || "Failed to load payouts"}
            </div>
          )}

          {isLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="glass-card animate-pulse">
                  <div className="flex items-center justify-between p-6">
                    <div className="space-y-2">
                      <div className="h-4 w-32 bg-white/10 rounded"></div>
                      <div className="h-3 w-24 bg-white/5 rounded"></div>
                    </div>
                    <div className="h-8 w-20 bg-white/10 rounded"></div>
                  </div>
                </div>
              ))}
            </div>
          ) : payouts && payouts.length > 0 ? (
            <div className="space-y-4">
              {payouts.map((payout: PendingPayout, index: number) => (
                <div key={`${payout.orgId}-${index}`} className="glass-card">
                  <div className="flex items-center justify-between p-6">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="h-10 w-10 rounded-lg bg-stellar-purple/20 flex items-center justify-center">
                          <span className="text-lg">🏛️</span>
                        </div>
                        <div>
                          <h3 className="font-semibold text-white">
                            {payout.orgName || payout.orgId}
                          </h3>
                          <p className="text-sm text-white/40 font-mono">{payout.orgId}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <div className="flex items-center gap-2 text-white/60">
                          <span className="h-1.5 w-1.5 rounded-full bg-stellar-teal"></span>
                          Claimable: <span className="font-mono">{payout.amountXlm} XLM</span>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleClaimPayout(payout.orgId)}
                      disabled={isSigning}
                      className="rounded-lg bg-gradient-to-r from-stellar-purple to-brand-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-stellar-purple/20 transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSigning ? "Claiming..." : "Claim"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 glass-card">
              <div className="mb-4">
                <div className="h-12 w-12 rounded-full bg-white/5 flex items-center justify-center mx-auto">
                  <span className="text-xl">💰</span>
                </div>
              </div>
              <h3 className="text-lg font-semibold text-white mb-1">No Pending Payouts</h3>
              <p className="text-white/50 text-sm max-w-md mx-auto">
                You don't have any pending payouts at the moment. Check back later or contact organizations you contribute to.
              </p>
            </div>
          )}
        </div>

        {/* Transaction History Section */}
        <div className="border-t border-white/[0.06] pt-10 space-y-6">
          <h2 className="text-2xl font-bold text-white">Transaction History</h2>

          {historyError && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {historyError.message || "Failed to load transaction history"}
            </div>
          )}

          {isHistoryLoading ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="glass-card animate-pulse p-4 h-20"></div>
                ))}
              </div>
              <div className="glass-card animate-pulse h-40"></div>
            </div>
          ) : historyData ? (
            <div className="space-y-6">
              {/* Stats Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="glass-card p-4 space-y-1">
                  <p className="text-xs text-white/50 uppercase tracking-wide">Total Earned</p>
                  <p className="text-xl font-bold text-white">{formatXlm(historyData.totalStroops)} XLM</p>
                </div>
                <div className="glass-card p-4 space-y-1">
                  <p className="text-xs text-white/50 uppercase tracking-wide">Payouts Received</p>
                  <p className="text-xl font-bold text-white">{historyData.payouts.length}</p>
                </div>
                <div className="glass-card p-4 space-y-1">
                  <p className="text-xs text-white/50 uppercase tracking-wide">Contributing Orgs</p>
                  <p className="text-xl font-bold text-white">{historyData.orgIds.length}</p>
                </div>
              </div>

              {/* Timeline list */}
              {historyData.payouts.length === 0 ? (
                <div className="text-center py-12 glass-card">
                  <div className="mb-4">
                    <div className="h-12 w-12 rounded-full bg-white/5 flex items-center justify-center mx-auto">
                      <span className="text-xl">⌛</span>
                    </div>
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-1">No Past Transactions</h3>
                  <p className="text-white/50 text-sm">
                    No payouts have been recorded for your address yet.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-white/[0.06] border border-white/[0.06] rounded-xl overflow-hidden bg-white/[0.02]">
                  {historyData.payouts.map((payout, i) => (
                    <div
                      key={`${payout.txHash}-${i}`}
                      className="flex flex-col gap-2 p-4 hover:bg-white/[0.04] transition-colors sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-white">
                            {formatXlm(payout.amountStroops)} XLM
                          </span>
                          <span className="text-xs text-white/40">
                            from{" "}
                            <span className="text-stellar-purple font-medium">{payout.orgId}</span>
                          </span>
                        </div>
                        <p className="text-xs text-white/40">
                          {formatDate(payout.ledgerClosedAt)} — Ledger #{payout.ledger}
                        </p>
                      </div>
                      <a
                        href={`https://stellar.expert/explorer/testnet/tx/${payout.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-mono text-stellar-teal hover:underline break-all sm:shrink-0"
                      >
                        {shortAddress(payout.txHash)}
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
