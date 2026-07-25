/**
 * @file dashboard/page.tsx
 * @description PayoutRegistry dashboard.
 */

"use client";

import { useState, useEffect, useCallback, Suspense, useOptimistic, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { WalletButton } from "@/components/WalletButton";
import dynamic from "next/dynamic";
import { PayoutCard } from "@/components/PayoutCard";

const FundOrgModal = dynamic(
  () => import("@/components/FundOrgModal").then((mod) => mod.FundOrgModal),
  { ssr: false }
);
const AllocatePayoutModal = dynamic(
  () => import("@/components/AllocatePayoutModal").then((mod) => mod.AllocatePayoutModal),
  { ssr: false }
);
import { EmptyMaintainersState } from "@/components/EmptyMaintainersState";
import { WebhookSettings } from "@/components/WebhookSettings";
import { ApiKeySettings } from "@/components/ApiKeySettings";
import { FundingHistoryChart } from "@/components/FundingHistoryChart";
import { useFreighter } from "@/hooks/useFreighter";
import {
  readMaintainers,
  readClaimableBalance,
  buildClaimPayoutTransaction,
  submitSignedTransaction,
} from "@/lib/sorobanClient";
import type { Organization, MaintainerBalance } from "@/lib/contractTypes";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useOrganizationData } from "@/hooks/useOrganizationData";

// ── Inner Component (uses useSearchParams) ────────────────────────────────────

function DashboardPageInner() {
  const { isConnected, publicKey, isInitialized, signTransaction } = useFreighter();
  const searchParams = useSearchParams();

  // ── State ─────────────────────────────────────────────────────────────────
  const [orgIdInput, setOrgIdInput] = useState("");
  const [lookupOrgId, setLookupOrgId] = useState<string | undefined>(undefined);
  const [showFundModal, setShowFundModal] = useState(false);
  const [claimingAddress, setClaimingAddress] = useState<string | null>(null);
  const [balances, setBalances] = useState<MaintainerBalance[]>([]);
  const [showAllocateModal, setShowAllocateModal] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "settings">("overview");
  
  type OptimisticAction =
    | { type: "allocate"; address: string; amount: bigint }
    | { type: "claim"; address: string };

  const [optimisticBalances, dispatchOptimisticBalance] = useOptimistic(
    balances,
    (state, action: OptimisticAction) => {
      if (action.type === "claim") {
        return state.map((b) =>
          b.address === action.address
            ? { ...b, stroops: BigInt(0), xlm: "0.0000000", isPending: true }
            : b
        );
      }

      const existingIndex = state.findIndex(b => b.address === action.address);
      if (existingIndex !== -1) {
        const newState = [...state];
        const current = newState[existingIndex]!;
        const newStroops = current.stroops + action.amount;
        newState[existingIndex] = {
          ...current,
          stroops: newStroops,
          xlm: (Number(newStroops) / 10_000_000).toFixed(7),
          isPending: true,
        };
        return newState;
      } else {
        return [
          ...state,
          {
            address: action.address,
            stroops: action.amount,
            xlm: (Number(action.amount) / 10_000_000).toFixed(7),
            isPending: true,
          },
        ];
      }
    }
  );

  const {
    data: orgData,
    isLoading: isOrgLoading,
    error: orgQueryError,
    refetch: refetchOrgData,
  } = useOrganizationData(lookupOrgId);
  const organization = orgData?.organization ?? null;
  const orgBudget = orgData?.budget ?? null;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // ── Handlers ──────────────────────────────────────────────────────────────

  /** Fetch org data, budget, and all maintainer balances from Soroban RPC. */
  const handleLookupOrg = useCallback(async (idOverride?: string) => {
    const id = (idOverride ?? orgIdInput).trim();
    if (!id) return;
    setIsLoading(true);
    setError(null);
    setBalances([]);

    try {
      let maintainerAddresses: string[];
      if (id === lookupOrgId) {
        // Same org already tracked by the query — just refetch it, then
        // read maintainers directly since we need the address list now.
        await refetchOrgData();
        maintainerAddresses = await readMaintainers(id);
      } else {
        setLookupOrgId(id);
        maintainerAddresses = await readMaintainers(id);
      }

      const balanceResults = await Promise.all(
        maintainerAddresses.map((addr) => readClaimableBalance(addr))
      );
      setBalances(balanceResults);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [orgIdInput, lookupOrgId, refetchOrgData]);

  /** Auto-lookup when ?org= param is present in the URL. */
  useEffect(() => {
    const orgFromUrl = searchParams.get("org");
    if (orgFromUrl) {
      setOrgIdInput(orgFromUrl);
      void handleLookupOrg(orgFromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Prepare, sign, and submit the claim_payout transaction. */
  const handleClaim = async (address: string) => {
    if (!isConnected || !publicKey) return;
    setClaimingAddress(address);
    try {
      const unsignedXdr = await buildClaimPayoutTransaction(address);
      const signedXdr = await signTransaction(unsignedXdr);

      // Optimistically zero out the balance right after signing, before
      // waiting for full on-chain confirmation.
      startTransition(() => {
        dispatchOptimisticBalance({ type: "claim", address });
      });

      await submitSignedTransaction(signedXdr);
      void handleLookupOrg();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Claim failed");
      // Reconcile immediately — don't leave a phantom zeroed balance if the
      // submission actually failed after the optimistic update fired.
      void handleLookupOrg();
    } finally {
      setClaimingAddress(null);
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* ── Navigation ── */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-stellar-blue/80 backdrop-blur-xl">
        <nav
          className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4"
          aria-label="Dashboard navigation"
        >
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="flex items-center gap-2 text-white/60 transition-colors hover:text-white"
              aria-label="Back to home"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              Home
            </Link>
            <span className="text-white/20">/</span>
            <h1 className="text-sm font-semibold text-white">Dashboard</h1>
          </div>
          <WalletButton />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        {/* ── Wallet Guard ── */}
        {!isInitialized ? (
          <div className="flex min-h-[520px] flex-col items-center justify-center py-32 text-center" />
        ) : !isConnected ? (
          <div className="flex min-h-[520px] flex-col items-center justify-center py-32 text-center">
            <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-stellar-purple/30 bg-stellar-purple/10">
              <LockIcon />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-white">
              Connect Your Wallet
            </h2>
            <p className="mb-8 max-w-sm text-sm text-white/50">
              Connect your Freighter wallet to interact with the PayoutRegistry
              on Stellar Testnet.
            </p>
            <WalletButton />
          </div>
        ) : (
          <>
            {/* ── Connected State ── */}
            <div className="mb-8 flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-white">
                  PayoutRegistry
                </h2>
                <p className="mt-1 text-sm text-white/50">
                  Look up an organization to view maintainer balances.
                </p>
              </div>
              <div className="flex items-center gap-4">
                <Link href="/leaderboard" className="text-sm text-white/60 hover:text-white transition-all">
                  Leaderboard
                </Link>
                <Link href="/organizations" className="text-sm text-stellar-teal hover:underline transition-all">
                  Browse Organizations →
                </Link>
                {publicKey && (
                  <div className="hidden items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 sm:flex">
                    <span className="h-2 w-2 rounded-full bg-green-400 shadow-[0_0_6px_2px_rgba(74,222,128,0.4)]" />
                    <span className="font-mono text-xs text-white/60">
                      {publicKey.slice(0, 6)}...{publicKey.slice(-6)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* ── Org Lookup Form ── */}
            <div className="glass-card mb-8 p-6">
              <label
                htmlFor="org-id-input"
                className="mb-2 block text-sm font-medium text-white/70"
              >
                Organization ID
              </label>
              <div className="flex gap-3">
                <input
                  id="org-id-input"
                  type="text"
                  value={orgIdInput}
                  onChange={(e) => setOrgIdInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleLookupOrg()}
                  placeholder="e.g. stellar (max 9 chars)"
                  maxLength={9}
                  className="flex-1 rounded-lg border border-white/[0.12] bg-white/[0.06] px-4 py-2.5 font-mono text-sm text-white placeholder-white/30 outline-none transition-all focus:border-stellar-purple/60 focus:bg-white/[0.08] focus:ring-1 focus:ring-stellar-purple/30"
                />
                <button
                  onClick={() => void handleLookupOrg()}
                  disabled={isLoading || isOrgLoading || !orgIdInput.trim()}
                  aria-label={isLoading || isOrgLoading ? "Looking up organization" : "Look up organization"}
                  className="rounded-lg bg-gradient-to-r from-stellar-purple to-brand-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-stellar-purple/20 transition-all duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isLoading || isOrgLoading ? "Loading..." : "Lookup"}
                </button>
              </div>
              <p id="org-id-hint" className="mt-2 text-xs text-white/30">
                Enter the Symbol ID used when registering the organization
                on-chain.
              </p>
            </div>

            {/* ── Tabs ── */}
            <div className="mb-6 flex h-[41px] gap-8 border-b border-white/10">
              {organization && (
                <>
                <button
                  onClick={() => setActiveTab("overview")}
                  role="tab"
                  aria-selected={activeTab === "overview"}
                  className={`pb-4 text-sm font-semibold transition-all ${
                    activeTab === "overview"
                      ? "border-b-2 border-stellar-purple text-white"
                      : "text-white/40 hover:text-white/70"
                  }`}
                >
                  Overview
                </button>
                <button
                  onClick={() => setActiveTab("settings")}
                  role="tab"
                  aria-selected={activeTab === "settings"}
                  className={`pb-4 text-sm font-semibold transition-all ${
                    activeTab === "settings"
                      ? "border-b-2 border-stellar-purple text-white"
                      : "text-white/40 hover:text-white/70"
                  }`}
                >
                  Settings
                </button>
                </>
              )}
            </div>

            {/* ── Error ── */}
            {(error || orgQueryError) && (
              <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error ?? (orgQueryError instanceof Error ? orgQueryError.message : "Failed to load organization")}
              </div>
            )}

            {/* ── Content ── */}
            {organization && (
              activeTab === "overview" ? (
                <>
                  <div className="glass-card mb-8 p-6">
                    <div className="mb-4 flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-stellar-purple to-stellar-teal font-bold text-white">
                        {organization.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h3 className="font-semibold text-white">
                          {organization.name}
                        </h3>
                        <p className="font-mono text-xs text-white/40">
                          ID: {organization.id}
                        </p>
                      </div>
                    </div>
                    <div className="rounded-lg border border-white/[0.06] bg-black/20 px-4 py-3">
                      <p className="text-xs font-medium text-white/40">
                        Admin Address
                      </p>
                      <p className="mt-1 break-all font-mono text-sm text-white/70">
                        {organization.admin}
                      </p>
                    </div>

                    {orgBudget && (
                      <div className="mt-4 flex items-center justify-between rounded-xl border border-stellar-teal/20 bg-stellar-teal/5 p-4">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wider text-stellar-teal/80">
                            Available Budget
                          </p>
                          <div className="mt-1 flex items-baseline gap-2">
                            <span className="text-2xl font-bold tracking-tight text-white">
                              {orgBudget.xlm}
                            </span>
                            <span className="text-sm font-medium text-stellar-teal">
                              XLM
                            </span>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setShowAllocateModal(true)}
                            aria-label="Open allocate payout form"
                            className="rounded-lg border border-stellar-purple/30 bg-stellar-purple/10 px-5 py-2.5 text-sm font-semibold text-stellar-purple hover:bg-stellar-purple/20 transition-all"
                          >
                            Allocate Payout
                          </button>
                          <button
                            onClick={() => setShowFundModal(true)}
                            aria-label="Open fund organization form"
                            className="rounded-lg bg-white/10 px-5 py-2.5 text-sm font-semibold text-white hover:bg-stellar-teal transition-all"
                          >
                            Fund Org
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mb-8">
                  <ErrorBoundary variant="inline">
                    <FundingHistoryChart orgId={organization.id} />
                    </ErrorBoundary>
                  </div>

                  {/* ── Maintainer Balances ── */}
                  {optimisticBalances.length > 0 && (
                    <div>
                      <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-white/40">
                        Maintainers ({optimisticBalances.length})
                      </h3>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {optimisticBalances.map((balance) => (
                          <ErrorBoundary key={balance.address} variant="inline">
                          <PayoutCard
                            key={balance.address}
                            balance={balance}
                            onClaim={handleClaim}
                            isClaiming={claimingAddress === balance.address}
                          />
                          </ErrorBoundary>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Empty State ── */}
                  {optimisticBalances.length === 0 && !isLoading && (
                    <EmptyMaintainersState
                      orgId={organization.id}
                      onAllocateClick={() => setShowAllocateModal(true)}
                    />
                  )}
                </>
              ) : (
                <div className="space-y-8">
                  <ApiKeySettings orgId={organization.id} publicKey={publicKey || ""} />
                  <WebhookSettings orgId={organization.id} publicKey={publicKey || ""} />
                </div>
              )
            )}
          </>
        )}
      </main>

      {showFundModal && organization && (
        <ErrorBoundary variant="inline">
        <FundOrgModal
          orgId={organization.id}
          onClose={() => setShowFundModal(false)}
          onSuccess={() => {
            setShowFundModal(false);
            void handleLookupOrg();
          }}
        />
        </ErrorBoundary>
      )}

      {showAllocateModal && organization && (
        <ErrorBoundary variant="inline">
        <AllocatePayoutModal
          orgId={organization.id}
          onClose={() => setShowAllocateModal(false)}
          onSuccess={(data) => {
            startTransition(() => {
              dispatchOptimisticBalance({ type: "allocate", ...data });
            });
            // The modal itself handles the transaction submission
            // and we'll eventually refresh data when confirmed.
            setTimeout(() => void handleLookupOrg(), 5000);
          }}
          onError={() => void handleLookupOrg()}
        />
        </ErrorBoundary>
      )}
    </div>
  );
}

// ── Root Export (Suspense boundary required for useSearchParams) ──────────────

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <DashboardPageInner />
    </Suspense>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function LockIcon() {
  return (
    <svg
      className="h-7 w-7 text-stellar-purple"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
      />
    </svg>
  );
}
