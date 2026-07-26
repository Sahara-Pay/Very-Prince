/**
 * @file FundOrgModal.tsx
 * @description Modal allowing users to fund an organization's budget.
 *
 * On mount the modal checks the connected wallet's native XLM balance via
 * Horizon and passes the result to <FaucetBanner> so the appropriate helper
 * guidance is shown without cluttering the happy-path UI.
 *
 * Transaction flow (fully client-side — no backend involvement):
 *   1. buildFundOrgTransaction  → produces unsigned XDR
 *   2. Freighter.signTransaction → user approves in the extension
 *   3. submitSignedTransaction  → broadcasts to Soroban RPC & polls ledger
 */

"use client";

import { usePersistedDraft } from "@/hooks/usePersistedDraft";
import { useEffect, useState } from "react";
import { useUnifiedWallet } from "@/hooks/useUnifiedWallet";
import { useFundOrg } from "@/hooks/useFundOrg";
import {
  readAccountXlmBalance,
} from "@/lib/sorobanClient";
import { FaucetBanner, type BalanceStatus } from "@/components/FaucetBanner";
import { GlassPanel } from "@/components/GlassPanel";

// ── Props ─────────────────────────────────────────────────────────────────────

interface FundOrgModalProps {
  orgId: string;
  onClose: () => void;
  onSuccess: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FundOrgModal({ orgId, onClose, onSuccess }: FundOrgModalProps) {
  const { isConnected, publicKey } = useUnifiedWallet();
  const [amount, setAmount] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);
  const [progressStep, setProgressStep] = useState<"idle" | "building" | "signing" | "submitting" | "confirmed">("idle");
  const { fundOrg, isSubmitting, error } = useFundOrg({ onProgress: setProgressStep });
  const shareText = `I just funded ${orgId} on PayoutRegistry! 🚀\n\n#Stellar #OpenSource`;

  // Balance detection for the smart FaucetBanner and display
  const [balanceStatus, setBalanceStatus] = useState<BalanceStatus>("loading");
  const [balance, setBalance] = useState<number | null>(null);

  // ── Detect wallet balance on mount ────────────────────────────────────────
  useEffect(() => {
    if (!publicKey) {
      setBalanceStatus("sufficient");
      setBalance(null);
      return;
    }

    let cancelled = false;

    readAccountXlmBalance(publicKey).then((balanceValue) => {
      if (cancelled) return;
      setBalance(balanceValue);
      if (balanceValue === null) {
        setBalanceStatus("unfunded");  // Horizon 404 — account never activated
      } else if (balanceValue === 0) {
        setBalanceStatus("empty");     // Account exists but has no XLM
      } else {
        setBalanceStatus("sufficient");
      }
    });

    return () => { cancelled = true; };
  }, [publicKey]);

  // ── Submit handler ────────────────────────────────────────────────────────

  const progressSteps = [
    { key: "building", label: "Building XDR" },
    { key: "signing", label: "Requesting Signature" },
    { key: "submitting", label: "Submitting" },
    { key: "confirmed", label: "Confirmed" },
  ] as const;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const numAmount = Number(amount);
    setProgressStep("building");
    setIsSuccess(false);

    try {
      await fundOrg(orgId, numAmount);
      setIsSuccess(true);
    } catch (err) {
      setProgressStep("idle");
      // Error is handled by the hook
    }
  };

  const handleClose = () => {
    if (isSuccess) {
      onSuccess();
    } else {
      onClose();
    }
  };


  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="fund-modal-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-stellar-blue/80 p-4 backdrop-blur-md"
      // Allow clicking the backdrop to close (unless a tx is in flight)
      onClick={(e) => { if (e.target === e.currentTarget && !isSubmitting) handleClose(); }}
    >
      <GlassPanel className="relative w-full max-w-md overflow-hidden p-8 shadow-2xl backdrop-blur-xl border-white/10 bg-white/5">
        {/* Background glow orbs */}
        <div className="pointer-events-none absolute -left-24 -top-24 h-48 w-48 rounded-full bg-stellar-purple/20 blur-[80px]" />
        <div className="pointer-events-none absolute -bottom-24 -right-24 h-48 w-48 rounded-full bg-stellar-teal/20 blur-[80px]" />

        <div className="relative">
          {/* ── Header ── */}
          <div className="mb-6 flex items-start justify-between">
            <div>
              <h2
                id="fund-modal-title"
                className="text-2xl font-bold tracking-tight text-white"
              >
                {isSuccess ? "Funding Successful" : "Fund Organization"}
              </h2>
              <p className="mt-1 text-sm text-white/50">
                {isSuccess ? (
                  <>You have successfully deposited XLM into <span className="font-mono text-stellar-purple">{orgId}</span>&apos;s budget.</>
                ) : (
                  <>Deposit XLM into <span className="font-mono text-stellar-purple">{orgId}</span>&apos;s budget.</>
                )}
              </p>
            </div>

            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              aria-label="Close modal"
              className="rounded-full bg-white/5 p-2 text-white/50 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-stellar-purple disabled:pointer-events-none"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* ── Smart Faucet Banner ── */}
          {/* Prominently shown for unfunded/empty wallets; collapses to a tooltip when funded */}
          {isSuccess ? (
            <div className="flex flex-col items-center py-6 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-stellar-teal/20 text-stellar-teal">
                <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="mb-6 text-white/80">
                Thank you for supporting <strong>{orgId}</strong>!
              </p>
              <div className="flex w-full flex-col gap-3">
                <a
                  href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Share funding on Twitter"
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1DA1F2] py-3 font-semibold text-white transition-all hover:brightness-110"
                >
                  <svg className="h-5 w-5 fill-current" viewBox="0 0 24 24">
                    <path d="M23.953 4.57a10 10 0 01-2.825.775 4.958 4.958 0 002.163-2.723c-.951.555-2.005.959-3.127 1.184a4.92 4.92 0 00-8.384 4.482C7.69 8.095 4.067 6.13 1.64 3.162a4.822 4.822 0 00-.666 2.475c0 1.71.87 3.213 2.188 4.096a4.904 4.904 0 01-2.228-.616v.06a4.923 4.923 0 003.946 4.827 4.996 4.996 0 01-2.212.085 4.936 4.936 0 004.604 3.417 9.867 9.867 0 01-6.102 2.105c-.39 0-.779-.023-1.17-.067a13.995 13.995 0 007.557 2.209c9.053 0 13.998-7.496 13.998-13.985 0-.21 0-.42-.015-.63A9.935 9.935 0 0024 4.59z" />
                  </svg>
                  Share to Twitter/X
                </a>
                <button
                  onClick={handleClose}
                  aria-label="Close success message"
                  className="w-full rounded-xl border border-white/10 bg-white/5 py-3 font-semibold text-white transition-all hover:bg-white/10"
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <>
              {(isSubmitting || progressStep !== "idle" || isSuccess) && (
                <div className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="mb-3 flex items-center justify-between text-[10px] uppercase tracking-[0.26em] text-white/45">
                    <span>Transaction progress</span>
                    <span>{progressStep === "confirmed" ? "Complete" : "In progress"}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {progressSteps.map((step, index) => {
                      const activeIndex = progressSteps.findIndex((item) => item.key === progressStep);
                      const isComplete = activeIndex >= 0 && index < activeIndex;
                      const isActive = index === activeIndex;
                      const isPending = !isComplete && !isActive;

                      return (
                        <div key={step.key} className="flex flex-1 items-center gap-2">
                          <div className="flex min-w-0 flex-1 flex-col items-center text-center">
                            <div
                              className={`flex h-8 w-8 items-center justify-center rounded-full border text-sm font-semibold transition-all ${
                                isComplete
                                  ? "border-stellar-teal bg-stellar-teal/20 text-stellar-teal"
                                  : isActive
                                    ? "border-stellar-purple bg-stellar-purple/20 text-stellar-purple"
                                    : "border-white/10 bg-white/5 text-white/40"
                              }`}
                            >
                              {index + 1}
                            </div>
                            <span className={`mt-2 text-[10px] leading-tight ${isPending ? "text-white/35" : "text-white/70"}`}>
                              {step.label}
                            </span>
                          </div>
                          {index < progressSteps.length - 1 && (
                            <div className={`h-[2px] flex-1 rounded-full ${isComplete || isActive ? "bg-stellar-teal" : "bg-white/10"}`} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <FaucetBanner balanceStatus={balanceStatus} />

              {/* ── Amount Input Form ── */}
              <form onSubmit={handleSubmit}>
                <div className="mb-5">
                  <label
                htmlFor="fund-amount"
                className="mb-2 block text-sm font-medium text-white/70"
              >
                Amount (XLM)
              </label>
              <div className="relative">
                <input
                  id="fund-amount"
                  type="number"
                  step="any"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  disabled={isSubmitting}
                  aria-describedby={error ? "fund-error" : undefined}
                  className="w-full rounded-xl border border-white/[0.12] bg-black/20 py-3 pl-9 pr-16 font-mono text-lg text-white placeholder-white/25 outline-none transition-all focus:border-stellar-teal/60 focus:bg-black/30 focus:ring-1 focus:ring-stellar-teal/30 disabled:opacity-50"
                  required
                />
                {/* Currency prefix */}
                <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-sm text-white/35">
                  ✦
                </span>
                {/* Currency suffix badge */}
                <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-white/10 px-2 py-1 text-xs font-semibold text-white/70">
                  XLM
                </div>
              </div>
            </div>

            {/* ── Balance and Fee Info ── */}
            <div className="mb-5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-3">
              <div className="flex justify-between text-sm">
                <span className="text-white/70">Your Balance:</span>
                <span className="font-mono text-white">
                  {balance !== null ? `${balance.toFixed(4)} XLM` : "Loading..."}
                </span>
              </div>
              <div className="mt-2 flex justify-between text-sm">
                <span className="text-white/70">Network Fee:</span>
                <span className="font-mono text-white">~0.00001 XLM</span>
              </div>
            </div>

            {/* ── Submit Button ── */}
            <button
              type="submit"
              disabled={isSubmitting || !amount || parseFloat(amount) <= 0 || (balance !== null && parseFloat(amount) > balance)}
              aria-label={
                isSubmitting ? "Processing funding on Testnet" :
                !isConnected ? "Please connect Freighter" :
                balanceStatus === "unfunded" || balanceStatus === "empty" ? "Fund your wallet first" :
                "Confirm funding"
              }
              className="mt-6 w-full rounded-xl bg-gradient-to-r from-stellar-purple to-stellar-teal py-3 font-semibold text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Processing on Testnet...
                </span>
              ) : !isConnected ? (
                "Please connect Freighter"
              ) : balanceStatus === "unfunded" || balanceStatus === "empty" ? (
                "Fund your wallet first ↑"
              ) : (
                "Confirm Funding"
              )}
            </button>

            {/* ── Fee note ── */}
            <p className="mt-3 text-center text-[10px] text-white/25">
              The network fee will be deducted from your wallet in addition to the funding amount.
            </p>
          </form>
            </>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
