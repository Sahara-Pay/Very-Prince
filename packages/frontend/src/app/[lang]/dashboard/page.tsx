"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { WalletButton } from "@/components/WalletButton";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useFreighter } from "@/hooks/useFreighter";
import { Locale } from "@/lib/i18n";
import { getDictionary } from "@/lib/getDictionary";
import type { Dictionary } from "@/lib/getDictionary";

interface DashboardPageProps {
  params: {
    lang: Locale;
  };
}

// ── Inner Component (uses useSearchParams) ────────────────────────────────────

function DashboardPageInner({ dictionary, lang }: { dictionary: Dictionary; lang: Locale }) {
  const { isConnected, publicKey } = useFreighter();
  const searchParams = useSearchParams();

  // ── State ─────────────────────────────────────────────────────────────────
  const [orgIdInput, setOrgIdInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleLookupOrg = async () => {
    const id = orgIdInput.trim();
    if (!id) return;
    setIsLoading(true);
    setError(null);

    try {
      // Placeholder for actual organization lookup
      console.log("Looking up organization:", id);
      // TODO: Implement actual organization lookup logic
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to lookup organization");
    } finally {
      setIsLoading(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen flex-col">
      {/* ── Navigation ────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-stellar-blue/80 backdrop-blur-xl">
        <nav
          className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4"
          aria-label="Main navigation"
        >
          <div className="flex items-center gap-3">
            {/* Logo mark */}
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-stellar-purple to-stellar-teal shadow-lg shadow-stellar-purple/30">
              <span className="text-sm font-bold text-white">VP</span>
            </div>
            <span className="text-sm font-semibold tracking-tight text-white">
              very-princess
            </span>
            {/* Network badge */}
            <span className="badge border border-stellar-teal/30 bg-stellar-teal/10 text-stellar-teal">
              <span className="h-1.5 w-1.5 rounded-full bg-stellar-teal" />
              Testnet
            </span>
          </div>

          <div className="flex items-center gap-4">
            <Link
              href={`/${lang}`}
              className="text-sm font-medium text-white/60 transition-colors hover:text-white"
            >
              {dictionary.common.dashboard}
            </Link>
            <Link
              href={`/${lang}/leaderboard`}
              className="text-sm font-medium text-white/60 transition-colors hover:text-white"
            >
              {dictionary.navigation.leaderboard}
            </Link>
            <LanguageSwitcher currentLocale={lang} />
            <WalletButton />
          </div>
        </nav>
      </header>

      {/* ── Dashboard Content ──────────────────────────────────────────────────── */}
      <main className="flex flex-1 flex-col px-6 py-8">
        <div className="mx-auto w-full max-w-6xl">
          {/* Page Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-white">
              {dictionary.dashboard.title}
            </h1>
            <p className="mt-2 text-white/60">
              {isConnected ? dictionary.dashboard.wallet_connected : dictionary.dashboard.connect_wallet}
            </p>
          </div>

          {/* Organization Lookup */}
          <div className="glass-card p-6">
            <h2 className="mb-4 text-lg font-semibold text-white">
              {dictionary.dashboard.organizations}
            </h2>
            
            <div className="flex gap-4">
              <input
                type="text"
                value={orgIdInput}
                onChange={(e) => setOrgIdInput(e.target.value)}
                placeholder={dictionary.dashboard.organization_id}
                className="flex-1 rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-white placeholder-white/40 focus:border-stellar-purple/30 focus:outline-none focus:ring-2 focus:ring-stellar-purple/20"
              />
              <button
                onClick={handleLookupOrg}
                disabled={isLoading || !orgIdInput.trim()}
                className="rounded-lg bg-gradient-to-r from-stellar-purple to-brand-500 px-6 py-2 text-sm font-semibold text-white shadow-lg shadow-stellar-purple/30 transition-all duration-200 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? dictionary.common.loading : "Lookup"}
              </button>
            </div>

            {error && (
              <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-red-400">
                {error}
              </div>
            )}
          </div>

          {/* Placeholder for dashboard content */}
          {!isConnected && (
            <div className="glass-card mt-6 p-12 text-center">
              <h3 className="text-xl font-semibold text-white mb-4">
                {dictionary.dashboard.connect_wallet}
              </h3>
              <p className="text-white/60">
                Connect your Freighter wallet to access the dashboard.
              </p>
            </div>
          )}

          {isConnected && !orgIdInput && (
            <div className="glass-card mt-6 p-12 text-center">
              <h3 className="text-xl font-semibold text-white mb-4">
                {dictionary.dashboard.select_organization}
              </h3>
              <p className="text-white/60">
                Enter an organization ID to get started.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ── Main Page Component ───────────────────────────────────────────────────────

export default async function DashboardPage({ params }: DashboardPageProps) {
  const dictionary = await getDictionary(params.lang);

  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-white">{dictionary.common.loading}</div>}>
      <DashboardPageInner dictionary={dictionary} lang={params.lang} />
    </Suspense>
  );
}
