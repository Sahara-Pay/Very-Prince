/**
 * @file profile/[address]/page.tsx
 * @description Public profile page for any wallet address interacting with
 * the PayoutRegistry. Shows total XLM earned, contributing orgs, and a
 * full payout timeline. URL is easily shareable - no wallet required.
 *
 * Route: /profile/[address]
 */

import type { Metadata } from "next";
import Link from "next/link";
import { CopyButton } from "./CopyButton";

// -- Types -------------------------------------------------------------------

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

// -- Metadata ----------------------------------------------------------------

export async function generateMetadata({
  params,
}: {
  params: { address: string };
}): Promise<Metadata> {
  const short = `${params.address.slice(0, 6)}...${params.address.slice(-4)}`;
  return {
    title: `${short} - Very-prince Profile`,
    description: `Historical payout stats for Stellar address ${params.address} on the PayoutRegistry.`,
  };
}

// -- Data Fetching -----------------------------------------------------------

async function fetchProfileStats(address: string): Promise<ProfileStats | null> {
  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";
  try {
    const res = await fetch(`${apiUrl}/api/v1/profile/${address}/stats`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return res.json() as Promise<ProfileStats>;
  } catch {
    return null;
  }
}

// -- Helpers -----------------------------------------------------------------

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

// -- Page --------------------------------------------------------------------

export default async function ProfilePage({
  params,
}: {
  params: { address: string };
}) {
  const { address } = params;
  const stats = await fetchProfileStats(address);

  if (!stats) {
    return (
      <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-4 p-8">
        <p className="text-gray-400 text-lg">No profile found for this address.</p>
        <code className="text-xs text-gray-500 break-all max-w-md text-center">
          {address}
        </code>
        <Link href="/" className="text-indigo-400 hover:underline text-sm">
          Go home
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto px-4 py-12 space-y-8">

        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-white">Maintainer Profile</h1>
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <code className="text-sm text-indigo-400 break-all min-w-0">{address}</code>
            <CopyButton
              text={address}
              label="copy"
              className="text-gray-500 hover:text-gray-300 text-xs shrink-0"
            />
          </div>
        </div>

        {/* Stats Cards — responsive: 1 col on mobile, 3 on sm+ */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 min-w-0">
          <StatCard
            label="Total Earned"
            value={`${formatXlm(stats.totalStroops)} XLM`}
          />
          <StatCard
            label="Payouts Received"
            value={String(stats.payouts.length)}
          />
          <StatCard
            label="Contributing Orgs"
            value={String(stats.orgIds.length)}
          />
        </div>

        {/* Orgs */}
        {stats.orgIds.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
              Organizations
            </h2>
            <div className="flex flex-wrap gap-2">
              {stats.orgIds.map((orgId) => (
                <span
                  key={orgId}
                  className="bg-indigo-900/40 text-indigo-300 border border-indigo-700/50 rounded-full px-3 py-1 text-sm"
                >
                  {orgId}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Payout Timeline — responsive: stack on mobile, row on sm+ */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
            Payout Timeline
          </h2>

          {stats.payouts.length === 0 ? (
            <p className="text-gray-500 text-sm">No payouts recorded yet.</p>
          ) : (
            <div className="divide-y divide-gray-800 border border-gray-800 rounded-xl overflow-hidden">
              {stats.payouts.map((payout, i) => (
                <div
                  key={`${payout.txHash}-${i}`}
                  className="flex flex-col gap-1 px-4 py-3 hover:bg-gray-900 transition-colors sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-white">
                        {formatXlm(payout.amountStroops)} XLM
                      </span>
                      <span className="text-xs text-gray-500">
                        from{" "}
                        <span className="text-indigo-400">{payout.orgId}</span>
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">
                      {formatDate(payout.ledgerClosedAt)} - Ledger #{payout.ledger}
                    </p>
                  </div>
                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${payout.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-gray-500 hover:text-indigo-400 transition-colors break-all sm:shrink-0"
                  >
                    {shortAddress(payout.txHash)}
                  </a>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Share CTA */}
        <div className="pt-4 border-t border-gray-800 flex items-center justify-between">
          <p className="text-xs text-gray-600">
            Powered by{" "}
            <Link href="/" className="text-indigo-500 hover:underline">
              Very-prince
            </Link>
          </p>
          <CopyButton
            text={`${process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000"}/profile/${address}`}
            label="Share profile"
            className="text-xs text-gray-500 hover:text-white transition-colors"
          />
        </div>

      </div>
    </main>
  );
}

// -- Sub-component -----------------------------------------------------------

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-1 min-w-0">
      <p className="text-xs text-gray-500 uppercase tracking-wide truncate">{label}</p>
      <p className="text-xl font-bold text-white break-words">{value}</p>
    </div>
  );
}
