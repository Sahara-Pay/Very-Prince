/**
 * @file RegisterOrgModal.tsx
 * @description Modal allowing users to register a new organization on-chain and in the DB.
 */

"use client";

import { useState } from "react";
import { registerOrganization } from "@/lib/api";
import { useFreighter } from "@/hooks/useFreighter";
import { GlassPanel } from "@/components/GlassPanel";

interface RegisterOrgModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export function RegisterOrgModal({ onClose, onSuccess }: RegisterOrgModalProps) {
  const { isConnected, publicKey } = useFreighter();
  
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [signerSecret, setSignerSecret] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isConnected || !publicKey) {
      setError("Please connect Freighter first.");
      return;
    }

    if (!id.trim() || id.length > 9) {
      setError("ID must be 1-9 characters.");
      return;
    }

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    if (!signerSecret.startsWith("S") || signerSecret.length !== 56) {
      setError("Invalid Stellar secret key.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await registerOrganization(id, name, publicKey, signerSecret);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-stellar-blue/80 p-4 backdrop-blur-md"
      onClick={(e) => { if (e.target === e.currentTarget && !isSubmitting) onClose(); }}
    >
      <GlassPanel className="relative w-full max-w-md overflow-hidden p-8 shadow-2xl backdrop-blur-xl border-white/10 bg-white/5">
        <div className="pointer-events-none absolute -left-24 -top-24 h-48 w-48 rounded-full bg-stellar-purple/20 blur-[80px]" />
        <div className="pointer-events-none absolute -bottom-24 -right-24 h-48 w-48 rounded-full bg-stellar-teal/20 blur-[80px]" />

        <div className="relative">
          <div className="mb-6 flex items-start justify-between">
            <div>
              <h2 className="text-2xl font-bold tracking-tight text-white">Register Organization</h2>
              <p className="mt-1 text-sm text-white/50">Add a new organization to the registry.</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              aria-label="Close registration modal"
              className="rounded-full bg-white/5 p-2 text-white/50 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="org-id" className="mb-2 block text-sm font-medium text-white/70">Organization ID (max 9 chars)</label>
              <input
                id="org-id"
                type="text"
                maxLength={9}
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="stellar"
                disabled={isSubmitting}
                className="w-full rounded-xl border border-white/[0.12] bg-black/20 px-4 py-2.5 font-mono text-sm text-white outline-none focus:border-stellar-purple/60 focus:bg-black/30"
                required
              />
            </div>

            <div>
              <label htmlFor="org-name" className="mb-2 block text-sm font-medium text-white/70">Display Name</label>
              <input
                id="org-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Stellar Development Foundation"
                disabled={isSubmitting}
                className="w-full rounded-xl border border-white/[0.12] bg-black/20 px-4 py-2.5 text-sm text-white outline-none focus:border-stellar-purple/60 focus:bg-black/30"
                required
              />
            </div>

            <div>
              <label htmlFor="signer-secret" className="mb-2 block text-sm font-medium text-white/70">Admin Secret Key (S...)</label>
              <input
                id="signer-secret"
                type="password"
                value={signerSecret}
                onChange={(e) => setSignerSecret(e.target.value)}
                placeholder="S..."
                disabled={isSubmitting}
                className="w-full rounded-xl border border-white/[0.12] bg-black/20 px-4 py-2.5 font-mono text-sm text-white outline-none focus:border-stellar-purple/60 focus:bg-black/30"
                required
              />
              <p className="mt-2 text-[10px] text-white/30 italic">
                Note: In this scaffold, the secret is processed by the backend. In production, sign client-side.
              </p>
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting || !isConnected}
              aria-label={isSubmitting ? "Registering organization" : "Register organization"}
              className="w-full rounded-xl bg-gradient-to-r from-stellar-purple to-brand-500 py-3 text-sm font-semibold text-white shadow-lg shadow-stellar-purple/20 transition-all hover:brightness-110 disabled:opacity-50"
            >
              {isSubmitting ? "Registering..." : "Register Organization"}
            </button>
          </form>
        </div>
      </GlassPanel>
    </div>
  );
}
