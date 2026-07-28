"use client";

import { useState } from "react";
import { useFreighter } from "@/hooks/useFreighter";
import {
  buildFundOrgTransaction,
  submitSignedTransaction,
} from "@/lib/sorobanClient";

interface UseFundOrgOptions {
  onProgress?: (step: "building" | "signing" | "submitting" | "confirmed" | "idle") => void;
}

export function useFundOrg({ onProgress }: UseFundOrgOptions = {}) {
  const { isConnected, publicKey, signTransaction } = useFreighter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fundOrg = async (orgId: string, amount: number) => {
    if (!isConnected || !publicKey) {
      throw new Error("Please connect Freighter first.");
    }

    if (isNaN(amount) || amount <= 0) {
      throw new Error("Please enter a valid positive amount.");
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const stroops = BigInt(Math.floor(amount * 10_000_000));

      onProgress?.("building");
      const unsignedXdr = await buildFundOrgTransaction(orgId, publicKey, stroops);

      onProgress?.("signing");
      const signedXdr = await signTransaction(unsignedXdr);

      onProgress?.("submitting");
      await submitSignedTransaction(signedXdr);

      onProgress?.("confirmed");
      setIsSubmitting(false);
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Funding failed. Please try again.";
      onProgress?.("idle");
      setError(errorMessage);
      setIsSubmitting(false);
      throw new Error(errorMessage);
    }
  };

  return {
    fundOrg,
    isSubmitting,
    error,
  };
}