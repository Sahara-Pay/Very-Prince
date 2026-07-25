"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { RegisterOrgModal } from "@/components/RegisterOrgModal";
import { GlassButton } from "@/components/GlassButton";
import type { Org } from "@/lib/api";
import { useSSEWithSWR } from "@/hooks/useSSE";
import { OrganizationSkeletonCard } from "@/components/OrganizationSkeletonCard";

/**
 * @file dashboard/org/page.tsx
 * @description Organizations management within the dashboard.
 * Lists all registered organizations with search functionality.
 */
export default function DashboardOrganizationsPage() {
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
      setPage(1);
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
    return `${process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001"}/api/v1/organizations/paginate?${params.toString()}`;
  }, [debouncedSearch, page]);

  const { data, error, isLoading } = useQuery({
    queryKey: ["organizations", "dashboard", page, debouncedSearch],
    queryFn: () => fetchOrganizationsPage(apiUrl),
  });

  return (
    <div className="space-y-8">
      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Organizations</h1>
          <p className="mt-2 text-white/60">
            Browse and manage registered organizations
          </p>
        </div>
        <GlassButton
          variant="primary"
          onClick={() => setShowRegisterModal(true)}
        >
          + Register Organization
        </GlassButton>
      </div>

      {/* ── Search Bar ────────────────────────────────────────────────────────── */}
      <div>
        <input
          type="text"
          placeholder="Search organizations..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full px-4 py-3 rounded-xl bg-white/10 border border-white/20 text-white placeholder-white/40 transition-all duration-200 focus:bg-white/15 focus:border-white/30 focus:outline-none"
        />
      </div>

      {/* ── Content ────────────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <OrganizationSkeletonCard key={i} />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-6">
          <p className="text-red-200">Failed to load organizations. Please try again.</p>
        </div>
      ) : data?.list && data.list.length > 0 ? (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {data.list.map((org: Org) => (
            <Link key={org.id} href={`/dashboard/org/${org.id}`}>
              <div className="glass-panel p-6 hover:bg-white/15 transition-all duration-200 cursor-pointer group">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white group-hover:text-stellar-teal transition-colors">
                      {org.name}
                    </h3>
                    <p className="text-xs text-white/50 mt-1">{org.id}</p>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t border-white/10">
                  <span className="text-xs text-stellar-teal">View Details →</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-xl bg-white/5 border border-white/10 p-12 text-center">
          <p className="text-white/60">No organizations found</p>
        </div>
      )}

      {/* ── Register Modal ────────────────────────────────────────────────────── */}
      {showRegisterModal && (
        <RegisterOrgModal
          onClose={() => setShowRegisterModal(false)}
          onSuccess={() => {
            setShowRegisterModal(false);
          }}
        />
      )}
    </div>
  );
}
