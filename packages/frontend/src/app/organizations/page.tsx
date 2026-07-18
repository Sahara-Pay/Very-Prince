/**
 * @file organizations/page.tsx
 * @description Paginated list of registered organizations with search functionality.
 */

"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { WalletButton } from "@/components/WalletButton";
import { RegisterOrgModal } from "@/components/RegisterOrgModal";
import type { Org } from "@/lib/api";
import { useSSEWithSWR } from "@/hooks/useSSE";

export default function OrganizationsPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showRegisterModal, setShowRegisterModal] = useState(false);

  // Enable SSE for real-time updates
  useSSEWithSWR();

  // Debounce search term
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm);
      setPage(1); // Reset to first page when searching
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const fetchOrganizationsPage = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch organizations: ${response.statusText}`);
    }
    return response.json();
  };

  // Build API URL with search and pagination
  const apiUrl = useMemo(() => {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: "12",
    });
    if (debouncedSearch) {
      params.append("search", debouncedSearch);
    }
    return `${process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001/api/v1/contract"}/orgs?${params}`;
  }, [page, debouncedSearch]);

  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["organizations", page, debouncedSearch],
    queryFn: () => fetchOrganizationsPage(apiUrl),
    staleTime: 5000,
  });

  const orgs = data?.data || [];
  const totalPages = data?.meta?.totalPages || 1;
  const totalCount = data?.meta?.totalCount || 0;

  const handleLoadMore = () => {
    if (page < totalPages) {
      setPage(page + 1);
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* ── Navigation ── */}
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-stellar-blue/80 backdrop-blur-xl">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2 text-white/60 transition-colors hover:text-white">
              <span className="text-sm font-bold">VP</span>
            </Link>
            <span className="text-white/20">/</span>
            <Link href="/dashboard" className="text-sm text-white/60 hover:text-white">Dashboard</Link>
            <span className="text-white/20">/</span>
            <h1 className="text-sm font-semibold text-white">Organizations</h1>
          </div>
          <WalletButton />
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <div className="mb-8 flex flex-col gap-6">
          {/* Search Bar */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search organizations by name or ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded-lg border border-white/[0.1] bg-white/[0.05] px-4 py-3 pl-12 text-white placeholder-white/40 backdrop-blur-sm transition-all focus:border-stellar-purple/50 focus:outline-none focus:ring-2 focus:ring-stellar-purple/20"
            />
            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
          </div>

          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <h2 className="text-3xl font-bold text-white">All Organizations</h2>
              <p className="mt-2 text-white/50">
                Browse through {totalCount} organizations registered on the PayoutRegistry.
                {debouncedSearch && (
                  <span className="ml-2 text-stellar-purple">
                    (searching for "{debouncedSearch}")
                  </span>
                )}
              </p>
            </div>
            <button
              onClick={() => setShowRegisterModal(true)}
              className="rounded-lg bg-gradient-to-r from-stellar-purple to-brand-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-stellar-purple/20 transition-all hover:brightness-110"
            >
              + Register Organization
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-8 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {orgs.map((org: Org) => (
            <Link
              key={org.id}
              href={`/dashboard?org=${org.id}`}
              className="glass-card group flex flex-col p-6 transition-all hover:border-stellar-purple/50 hover:bg-white/[0.08]"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-stellar-purple/20 text-xl group-hover:bg-stellar-purple/30">
                🏢
              </div>
              <h3 className="text-lg font-bold text-white group-hover:text-stellar-purple transition-colors">
                {org.name}
              </h3>
              <p className="mt-1 font-mono text-xs text-white/40">{org.id}</p>
              <div className="mt-4 flex items-center gap-2 text-xs text-white/60">
                <span className="h-1.5 w-1.5 rounded-full bg-stellar-teal" />
                Admin: {org.admin.slice(0, 4)}...{org.admin.slice(-4)}
              </div>
              {org.publicBudget && (
                <div className="mt-2 flex items-center gap-2 text-xs text-white/60">
                  <span className="h-1.5 w-1.5 rounded-full bg-stellar-purple" />
                  Budget: {(Number(org.publicBudget) / 10_000_000).toFixed(2)} XLM
                </div>
              )}
            </Link>
          ))}
        </div>

        {orgs.length === 0 && !isLoading && !error && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="text-white/40">No organizations found.</p>
          </div>
        )}

        {page < totalPages && (
          <div className="mt-12 flex justify-center">
            <button
              onClick={handleLoadMore}
              disabled={isLoading}
              className="rounded-full bg-white/[0.06] px-8 py-3 text-sm font-semibold text-white border border-white/[0.1] hover:bg-white/[0.1] transition-all disabled:opacity-50"
            >
              {isLoading ? "Loading..." : "Load More"}
            </button>
          </div>
        )}
      </main>

      {showRegisterModal && (
        <RegisterOrgModal
          onClose={() => setShowRegisterModal(false)}
          onSuccess={() => {
            setShowRegisterModal(false);
            void refetch();
          }}
        />
      )}
    </div>
  );
}
