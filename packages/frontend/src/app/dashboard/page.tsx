/**
 * @file dashboard/page.tsx
 * @description PayoutRegistry dashboard.
 */

import { Suspense } from "react";
import { DashboardContent } from "@/components/DashboardContent";
import DashboardLoading from "./loading";
import Link from "next/link";
import { WalletButton } from "@/components/WalletButton";

interface DashboardPageProps {
  searchParams: {
    org?: string;
  };
}

export default function DashboardPage({ searchParams }: DashboardPageProps) {
  const initialOrgId = searchParams.org;

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
        <Suspense fallback={<DashboardLoading />}>
          <DashboardContent initialOrgId={initialOrgId} />
        </Suspense>
      </main>
    </div>
  );
}
