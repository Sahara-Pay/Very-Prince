"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function XdrInputForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = value.trim();
    if (!trimmed) {
      setError("Please paste a valid XDR string.");
      return;
    }

    if (trimmed.length < 64) {
      setError("XDR string appears too short. Ensure it is Base64-encoded.");
      return;
    }

    router.push(`/dashboard/xdr-viewer?xdr=${encodeURIComponent(trimmed)}`);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <label className="block text-sm font-medium text-white/80">
        Paste Base64 XDR Transaction Envelope
      </label>
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        placeholder="AAAAAgAAAABB... (Base64-encoded Stellar XDR)"
        rows={4}
        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 font-mono text-xs text-white placeholder:text-white/30 focus:border-stellar-purple/50 focus:outline-none focus:ring-1 focus:ring-stellar-purple/30 transition-colors resize-none"
        spellCheck={false}
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button
        type="submit"
        className="inline-flex items-center justify-center rounded-lg bg-stellar-purple px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stellar-purple/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-stellar-purple focus-visible:ring-offset-2 focus-visible:ring-offset-stellar-blue"
      >
        Parse &amp; Stream
      </button>
    </form>
  );
}
