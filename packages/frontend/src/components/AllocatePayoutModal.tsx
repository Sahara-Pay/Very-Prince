/**
 * @file AllocatePayoutModal.tsx
 * @description Modal for org admins to allocate payouts to maintainers.
 */

"use client";

import { useState } from "react";
import { useFreighter } from "@/hooks/useFreighter";
import { buildAllocatePayoutTransaction, submitSignedTransaction } from "@/lib/sorobanClient";
import { toastTransaction } from "@/lib/transactionToast";

interface AllocatePayoutModalProps {
  orgId: string;
  onClose: () => void;
  onSuccess: (optimisticData: { address: string, amount: bigint }) => void;
}

export function AllocatePayoutModal({ orgId, onClose, onSuccess }: AllocatePayoutModalProps) {
  const { publicKey, signTransaction } = useFreighter();
  const [maintainer, setMaintainer] = useState("");
  const [amount, setAmount] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey || !maintainer || !amount) return;

    setIsSubmitting(true);
    const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 10_000_000));

    try {
      // 1. Build transaction
      const unsignedXdr = await buildAllocatePayoutTransaction(
        publicKey,
        orgId,
        maintainer,
        amountBigInt
      );

      // 2. Sign transaction (This triggers Freighter)
      const signedXdr = await signTransaction(unsignedXdr);

      // 3. Optimistic Update (Handled by parent)
      onSuccess({ address: maintainer, amount: amountBigInt });
      onClose();

      // 4. Submit to blockchain (background)
      await submitSignedTransaction(signedXdr);
      toastTransaction.success("Allocation confirmed on-chain!");
    } catch (err) {
      console.error(err);
      toastTransaction.error(err, "Allocation failed");
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="allocate-modal-title"
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[#0a0a1a] p-8 shadow-2xl">
        <h3 id="allocate-modal-title" className="mb-6 text-xl font-bold text-white">Allocate Payout</h3>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="mb-2 block text-sm font-medium text-white/60">Maintainer Address</label>
            <input
              type="text"
              value={maintainer}
              onChange={(e) => setMaintainer(e.target.value)}
              placeholder="G..."
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none focus:border-stellar-purple/50"
              required
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-white/60">Amount (XLM)</label>
            <input
              type="number"
              step="0.0000001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-white outline-none focus:border-stellar-purple/50"
              required
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="Cancel allocation"
              className="flex-1 rounded-xl border border-white/10 px-4 py-3 text-sm font-semibold text-white/60 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              aria-label={isSubmitting ? "Processing allocation" : "Allocate payout"}
              className="flex-[2] rounded-xl bg-gradient-to-r from-stellar-purple to-stellar-teal px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-stellar-purple/20 transition-all hover:brightness-110 disabled:opacity-50"
            >
              {isSubmitting ? "Processing..." : "Allocate Payout"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
