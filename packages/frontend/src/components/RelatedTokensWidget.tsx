"use client";

import React from "react";

interface TokenInfo {
  symbol: string;
  name: string;
  balance: string;
  change: string;
}

const MOCK_TOKENS: TokenInfo[] = [
  { symbol: "XLM", name: "Stellar Lumens", balance: "10,450.00", change: "+2.4%" },
  { symbol: "USDC", name: "USD Coin", balance: "2,500.00", change: "+0.1%" },
  { symbol: "AQUA", name: "Aqua Token", balance: "150,000.00", change: "-1.2%" },
  { symbol: "SHX", name: "Stronghold", balance: "45,000.00", change: "+5.8%" },
];

export function RelatedTokensWidget({ orgId }: { orgId: string }) {
  return (
    <div className="glass-card mb-8 p-6">
      <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-white/40">
        Related Asset Tokens ({orgId})
      </h3>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {MOCK_TOKENS.map((token) => (
          <div
            key={token.symbol}
            className="rounded-xl border border-white/[0.08] bg-white/[0.04] p-4 transition-all hover:bg-white/[0.08]"
          >
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm font-bold text-white">{token.symbol}</span>
              <span
                className={`font-mono text-xs ${
                  token.change.startsWith("+") ? "text-green-400" : "text-red-400"
                }`}
              >
                {token.change}
              </span>
            </div>
            <p className="mt-1 text-xs text-white/40">{token.name}</p>
            <p className="mt-2 font-mono text-base font-semibold text-stellar-teal">
              {token.balance}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
