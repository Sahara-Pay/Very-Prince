import React from "react";
import { toast, ExternalToast } from "sonner";

/**
 * Helper to determine the network for Stellar Expert links.
 */
function getStellarExpertNetwork(): string {
  if (typeof process === "undefined") return "testnet";
  const passphrase = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || "";
  if (passphrase.includes("Public Global")) {
    return "public";
  }
  return "testnet";
}

/**
 * Creates a clickable link to Stellar Expert for a given transaction hash.
 */
function TransactionLink({ hash, message }: { hash: string; message: string }) {
  const network = getStellarExpertNetwork();
  const url = `https://stellar.expert/explorer/${network}/tx/${hash}`;

  return (
    <div className="flex flex-col gap-1">
      <span>{message}</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-400 hover:text-blue-300 underline text-sm truncate"
      >
        View on Stellar Expert
      </a>
    </div>
  );
}

/**
 * Centralized utility for handling transaction toasts.
 */
export const toastTransaction = {
  /**
   * Show a pending transaction toast.
   */
  pending: (message: string = "Transaction pending...", options?: ExternalToast) => {
    return toast.loading(message, options);
  },

  /**
   * Show a successful transaction toast, automatically linking to Stellar Expert if a hash is provided.
   */
  success: (
    message: string = "Transaction successful!",
    txHash?: string,
    options?: ExternalToast
  ) => {
    if (txHash) {
      return toast.success(<TransactionLink hash={txHash} message={message} />, options);
    }
    return toast.success(message, options);
  },

  /**
   * Show an error toast for a failed transaction.
   */
  error: (
    error: unknown,
    fallbackMessage: string = "Transaction failed",
    options?: ExternalToast
  ) => {
    let errorMessage = fallbackMessage;
    if (error instanceof Error) {
      errorMessage = error.message;
    } else if (typeof error === "string") {
      errorMessage = error;
    }
    return toast.error(errorMessage, options);
  },

  /**
   * Wrap a promise to automatically handle pending, success, and error toasts.
   */
  promise: async <T,>(
    promise: Promise<T>,
    {
      loading = "Transaction pending...",
      success = "Transaction successful!",
      error = "Transaction failed",
      getHash,
    }: {
      loading?: string;
      success?: string | ((data: T) => string);
      error?: string | ((err: unknown) => string);
      getHash?: (data: T) => string | undefined;
    }
  ) => {
    const id = toast.loading(loading);
    try {
      const data = await promise;
      const successMsg = typeof success === "function" ? success(data) : success;
      const hash = getHash ? getHash(data) : undefined;
      
      if (hash) {
        toast.success(<TransactionLink hash={hash} message={successMsg} />, { id });
      } else {
        toast.success(successMsg, { id });
      }
      return data;
    } catch (err) {
      const errorMsg = typeof error === "function" ? error(err) : error;
      let finalErrorMsg = errorMsg;
      if (err instanceof Error && error === "Transaction failed") {
        finalErrorMsg = err.message;
      }
      toast.error(finalErrorMsg, { id });
      throw err;
    }
  },
};
