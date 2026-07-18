/**
 * @file FaucetBanner.tsx
 * @description Contextual Testnet faucet helper banner.
 *
 * Rendered inside FundOrgModal when the connected wallet has a zero or
 * unfunded balance. Provides clear, actionable guidance so reviewers and
 * first-time users can immediately obtain testnet XLM and continue.
 *
 * Three distinct visual states driven by the `balanceStatus` prop:
 *
 *   "unfunded"  — Account has never been funded (404 from Horizon).
 *                 Shows a prominent warning banner with two CTA paths.
 *   "empty"     — Account exists but has 0 XLM.
 *                 Shows the same banner — the user needs to fund again.
 *   "sufficient" — Balance is > 0. Shows a small collapsible info tooltip
 *                  so the path is still discoverable without being intrusive.
 */

"use client";

import { useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BalanceStatus = "loading" | "unfunded" | "empty" | "sufficient";

interface FaucetBannerProps {
  /**
   * The detected balance status for the connected wallet.
   * - "loading"    — balance check in flight
   * - "unfunded"   — Horizon 404, account never activated
   * - "empty"      — account exists, native balance === 0
   * - "sufficient" — account has a positive XLM balance
   */
  balanceStatus: BalanceStatus;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FAUCET_URL =
  "https://laboratory.stellar.org/#account-creator?network=test";

// ── Component ─────────────────────────────────────────────────────────────────

export function FaucetBanner({ balanceStatus }: FaucetBannerProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (balanceStatus === "loading") {
    return (
      <div className="mb-5 flex items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
        <div className="h-3 w-3 animate-pulse rounded-full bg-white/20" />
        <div className="h-3 w-40 animate-pulse rounded bg-white/10" />
      </div>
    );
  }

  // ── Sufficient balance — unobtrusive info link ────────────────────────────
  if (balanceStatus === "sufficient") {
    return (
      <div className="relative mb-5">
        <button
          type="button"
          onClick={() => setTooltipOpen((o) => !o)}
          className="flex items-center gap-1.5 text-xs text-white/35 transition-colors hover:text-white/60"
          aria-expanded={tooltipOpen}
          aria-controls="faucet-tooltip"
        >
          <InfoIcon />
          Need testnet tokens?
        </button>

        {tooltipOpen && (
          <div id="faucet-tooltip" className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border border-white/10 bg-[#0d1130] p-4 shadow-2xl shadow-black/40">
            {/* Arrow */}
            <div className="absolute -bottom-1.5 left-4 h-3 w-3 rotate-45 border-b border-r border-white/10 bg-[#0d1130]" />
            <TooltipContent />
          </div>
        )}
      </div>
    );
  }

  // ── Unfunded / empty — prominent warning banner ───────────────────────────
  return (
    <div
      role="alert"
      className="mb-5 overflow-hidden rounded-xl border border-amber-500/25 bg-amber-500/[0.07]"
    >
      {/* Accent bar */}
      <div className="h-0.5 w-full bg-gradient-to-r from-amber-500/60 via-amber-400/40 to-transparent" />

      <div className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/15">
            <span className="text-[10px] font-bold text-amber-400">!</span>
          </span>
          <p className="text-sm font-semibold text-amber-300">
            {balanceStatus === "unfunded"
              ? "Your wallet hasn't been activated on Testnet"
              : "Your wallet has no Testnet XLM"}
          </p>
        </div>

        <p className="mb-3 text-xs leading-relaxed text-white/50">
          Stellar accounts must hold a minimum reserve of XLM to exist on the
          network. Fund your wallet before submitting transactions.
        </p>

        <TooltipContent />
      </div>
    </div>
  );
}

// ── Shared CTA content ────────────────────────────────────────────────────────

function TooltipContent() {
  return (
    <div className="flex flex-col gap-2">
      {/* Primary CTA — Stellar Laboratory */}
      <a
        href={FAUCET_URL}
        target="_blank"
        rel="noopener noreferrer"
        id="stellar-faucet-link"
        aria-label="Open Stellar Friendbot faucet in new tab"
        className="group flex items-center justify-between gap-3 rounded-lg border border-stellar-teal/20 bg-stellar-teal/[0.08] px-3 py-2.5 transition-all duration-200 hover:border-stellar-teal/50 hover:bg-stellar-teal/[0.14]"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-stellar-teal/15">
            <FaucetIcon />
          </span>
          <div>
            <p className="text-xs font-semibold text-stellar-teal">
              Stellar Friendbot (Laboratory)
            </p>
            <p className="text-[10px] text-white/35">
              Instantly fund any testnet address
            </p>
          </div>
        </div>
        <ExternalLinkIcon className="h-3.5 w-3.5 shrink-0 text-white/25 transition-colors group-hover:text-stellar-teal/60" />
      </a>

      {/* Secondary CTA — Freighter built-in */}
      <div className="flex items-start gap-2 rounded-lg border border-stellar-purple/20 bg-stellar-purple/[0.06] px-3 py-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-stellar-purple/15">
          <FreighterIcon />
        </span>
        <div>
          <p className="text-xs font-semibold text-stellar-purple">
            Freighter built-in faucet
          </p>
          <p className="text-[10px] leading-relaxed text-white/35">
            Open Freighter → switch to <strong className="text-white/50">Testnet</strong> → tap{" "}
            <strong className="text-white/50">&quot;Fund Account&quot;</strong> under your balance.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function InfoIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-4M12 8h.01" />
    </svg>
  );
}

function FaucetIcon() {
  return (
    <svg className="h-4 w-4 text-stellar-teal" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3" />
    </svg>
  );
}

function FreighterIcon() {
  return (
    <svg className="h-4 w-4 text-stellar-purple" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h14a2 2 0 002-2v-3" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 12h5v4h-5a2 2 0 010-4z" />
    </svg>
  );
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}
