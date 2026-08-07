"use client";

import { useState, Suspense, useEffect } from "react";
import { WalletButton } from "@/components/WalletButton";
import dynamic from "next/dynamic";
import { useFreighter } from "@/hooks/useFreighter";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { OrgDetailsWidget } from "@/components/OrgDetailsWidget";
import { FundingHistoryChart } from "@/components/FundingHistoryChart";
import { MaintainerBalancesWidget } from "@/components/MaintainerBalancesWidget";
import { RelatedTokensWidget } from "@/components/RelatedTokensWidget";
import { WebhookSettings } from "@/components/WebhookSettings";
import { ApiKeySettings } from "@/components/ApiKeySettings";
import {
  OrgDetailsSkeleton,
  FundingHistorySkeleton,
  MaintainerBalancesSkeleton,
  RelatedTokensSkeleton,
  DashboardFallbackSkeleton,
} from "@/components/DashboardSkeletons";
import {
  SuspenseOrchestratorProvider,
  OrchestratedBoundary,
} from "@/components/SuspenseOrchestrator";
import { buildClaimPayoutTransaction, submitSignedTransaction } from "@/lib/sorobanClient";
import Link from "next/link";
import { useRouter } from "next/navigation";

const FundOrgModal = dynamic(
  () => import("@/components/FundOrgModal").then((mod) => mod.FundOrgModal),
  { ssr: false }
);
const AllocatePayoutModal = dynamic(
  () => import("@/components/AllocatePayoutModal").then((mod) => mod.AllocatePayoutModal),
  { ssr: false }
);

interface DashboardContentProps {
  initialOrgId?: string | undefined;
}

export function DashboardContent({ initialOrgId }: DashboardContentProps) {
  const { isConnected, publicKey, isInitialized, signTransaction } = useFreighter();
  const router = useRouter();
  const [orgIdInput, setOrgIdInput] = useState(initialOrgId || "");
  const [showFundModal, setShowFundModal] = useState(false);
  const [showAllocateModal, setShowAllocateModal] = useState(false);
  const [claimingAddress, setClaimingAddress] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "settings">("overview");

  // Sync input state with URL param
  useEffect(() => {
    if (initialOrgId) {
      setOrgIdInput(initialOrgId);
    }
  }, [initialOrgId]);

  const handleLookupOrg = () => {
    const id = orgIdInput.trim();
    if (!id) return;
    router.push(`/dashboard?org=${id}`);
  };

  const handleClaim = async (address: string) => {
    if (!isConnected || !publicKey) return;
    setClaimingAddress(address);
    try {
      const unsignedXdr = await buildClaimPayoutTransaction(address);
      const signedXdr = await signTransaction(unsignedXdr);
      await submitSignedTransaction(signedXdr);
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Claim failed");
    } finally {
      setClaimingAddress(null);
    }
  };

  if (!isInitialized) {
    return <div className="flex min-h-[520px] flex-col items-center justify-center py-32 text-center" />;
  }

  if (!isConnected) {
    return (
      <div className="flex min-h-[520px] flex-col items-center justify-center py-32 text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-stellar-purple/30 bg-stellar-purple/10">
          <svg className="h-7 w-7 text-stellar-purple" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </div>
        <h2 className="mb-2 text-xl font-semibold text-white">Connect Your Wallet</h2>
        <p className="mb-8 max-w-sm text-sm text-white/50">
          Connect your Freighter wallet to interact with the PayoutRegistry on Stellar Testnet.
        </p>
        <WalletButton />
      </div>
    );
  }

  return (
    <>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">PayoutRegistry</h2>
          <p className="mt-1 text-sm text-white/50">Look up an organization to view maintainer balances.</p>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/leaderboard" className="text-sm text-white/60 hover:text-white transition-all">Leaderboard</Link>
          <Link href="/organizations" className="text-sm text-stellar-teal hover:underline transition-all">Browse Organizations →</Link>
          {publicKey && (
            <div className="hidden items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 sm:flex">
              <span className="h-2 w-2 rounded-full bg-green-400 shadow-[0_0_6px_2px_rgba(74,222,128,0.4)]" />
              <span className="font-mono text-xs text-white/60">{publicKey.slice(0, 6)}...{publicKey.slice(-6)}</span>
            </div>
          )}
        </div>
      </div>

      <div className="glass-card mb-8 p-6">
        <label htmlFor="org-id-input" className="mb-2 block text-sm font-medium text-white/70">Organization ID</label>
        <div className="flex gap-3">
          <input
            id="org-id-input"
            type="text"
            value={orgIdInput}
            onChange={(e) => setOrgIdInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLookupOrg()}
            placeholder="e.g. stellar (max 9 chars)"
            maxLength={9}
            className="flex-1 rounded-lg border border-white/[0.12] bg-white/[0.06] px-4 py-2.5 font-mono text-sm text-white placeholder-white/30 outline-none transition-all focus:border-stellar-purple/60 focus:bg-white/[0.08] focus:ring-1 focus:ring-stellar-purple/30"
          />
          <button
            onClick={handleLookupOrg}
            disabled={!orgIdInput.trim()}
            className="rounded-lg bg-gradient-to-r from-stellar-purple to-brand-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-stellar-purple/20 transition-all duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Lookup
          </button>
        </div>
      </div>

      {initialOrgId && (
        <>
          <div className="mb-6 flex h-[41px] gap-8 border-b border-white/10">
            <button
              onClick={() => setActiveTab("overview")}
              className={`pb-4 text-sm font-semibold transition-all ${activeTab === "overview" ? "border-b-2 border-stellar-purple text-white" : "text-white/40 hover:text-white/70"}`}
            >
              Overview
            </button>
            <button
              onClick={() => setActiveTab("settings")}
              className={`pb-4 text-sm font-semibold transition-all ${activeTab === "settings" ? "border-b-2 border-stellar-purple text-white" : "text-white/40 hover:text-white/70"}`}
            >
              Settings
            </button>
          </div>

          {activeTab === "overview" ? (
            <SuspenseOrchestratorProvider fallback={<DashboardFallbackSkeleton />}>
              <ErrorBoundary variant="inline">
                <Suspense
                  fallback={
                    <OrchestratedBoundary id="orgDetails" isCritical={true} isReady={false}>
                      <OrgDetailsSkeleton />
                    </OrchestratedBoundary>
                  }
                >
                  <OrchestratedBoundary id="orgDetails" isCritical={true} isReady={true}>
                    <OrgDetailsWidget 
                      orgId={initialOrgId} 
                      onShowFundModal={() => setShowFundModal(true)}
                      onShowAllocateModal={() => setShowAllocateModal(true)}
                    />
                  </OrchestratedBoundary>
                </Suspense>
              </ErrorBoundary>

              <div className="mb-8">
                <ErrorBoundary variant="inline">
                  <Suspense
                    fallback={
                      <OrchestratedBoundary id="fundingHistory" isCritical={true} isReady={false}>
                        <FundingHistorySkeleton />
                      </OrchestratedBoundary>
                    }
                  >
                    <OrchestratedBoundary id="fundingHistory" isCritical={true} isReady={true}>
                      <FundingHistoryChart orgId={initialOrgId} />
                    </OrchestratedBoundary>
                  </Suspense>
                </ErrorBoundary>
              </div>

              <ErrorBoundary variant="inline">
                <Suspense
                  fallback={
                    <OrchestratedBoundary id="maintainers" isCritical={true} isReady={false}>
                      <MaintainerBalancesSkeleton />
                    </OrchestratedBoundary>
                  }
                >
                  <OrchestratedBoundary id="maintainers" isCritical={true} isReady={true}>
                    <MaintainerBalancesWidget 
                      orgId={initialOrgId} 
                      onClaim={handleClaim}
                      claimingAddress={claimingAddress}
                      onAllocateClick={() => setShowAllocateModal(true)}
                    />
                  </OrchestratedBoundary>
                </Suspense>
              </ErrorBoundary>

              {/* Non-critical data (related tokens) defers gracefully without blocking main render */}
              <ErrorBoundary variant="inline">
                <Suspense
                  fallback={
                    <OrchestratedBoundary id="relatedTokens" isCritical={false} isReady={false}>
                      <RelatedTokensSkeleton />
                    </OrchestratedBoundary>
                  }
                >
                  <OrchestratedBoundary id="relatedTokens" isCritical={false} isReady={true}>
                    <RelatedTokensWidget orgId={initialOrgId} />
                  </OrchestratedBoundary>
                </Suspense>
              </ErrorBoundary>
            </SuspenseOrchestratorProvider>
          ) : (
            <div className="space-y-8">
              <ApiKeySettings orgId={initialOrgId} publicKey={publicKey || ""} />
              <WebhookSettings orgId={initialOrgId} publicKey={publicKey || ""} />
            </div>
          )}
        </>
      )}

      {showFundModal && initialOrgId && (
        <ErrorBoundary variant="inline">
          <FundOrgModal
            orgId={initialOrgId}
            onClose={() => setShowFundModal(false)}
            onSuccess={() => {
              setShowFundModal(false);
              router.refresh();
            }}
          />
        </ErrorBoundary>
      )}

      {showAllocateModal && initialOrgId && (
        <ErrorBoundary variant="inline">
          <AllocatePayoutModal
            orgId={initialOrgId}
            onClose={() => setShowAllocateModal(false)}
            onSuccess={() => {
              setShowAllocateModal(false);
              router.refresh();
            }}
            onError={() => router.refresh()}
          />
        </ErrorBoundary>
      )}
    </>
  );
}
