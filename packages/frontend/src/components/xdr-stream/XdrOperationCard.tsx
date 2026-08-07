"use client";

import { useState } from "react";

export type OperationType =
  | "invoke_contract"
  | "create_account"
  | "payment"
  | "path_payment_strict_receive"
  | "path_payment_strict_send"
  | "manage_sell_offer"
  | "manage_buy_offer"
  | "create_passive_sell_offer"
  | "set_options"
  | "change_trust"
  | "allow_trust"
  | "account_merge"
  | "manage_data"
  | "bump_sequence"
  | "create_claimable_balance"
  | "claim_claimable_balance"
  | "begin_sponsoring_future_reserves"
  | "end_sponsoring_future_reserves"
  | "revoke_sponsorship"
  | "clawback"
  | "clawback_claimable_balance"
  | "set_trust_line_flags"
  | "liquidity_pool_deposit"
  | "liquidity_pool_withdraw"
  | "invoke_host_function"
  | "extend_footprint_ttl"
  | "restore_footprint"
  | "unknown";

export interface DecodedContractArg {
  type: string;
  value: string;
}

export interface DecodedOperation {
  type: OperationType;
  index: number;
  details: Record<string, string>;
  contractArgs?: DecodedContractArg[];
  sorobanData?: string;
}

function shortenAddress(addr: string, chars = 6): string {
  if (addr.length <= chars * 2 + 1) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

function formatStroops(stroops: string): string {
  try {
    const val = BigInt(stroops);
    const xlm = Number(val) / 10_000_000;
    return `${xlm.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 7 })} XLM`;
  } catch {
    return stroops;
  }
}

const OPERATION_ICONS: Record<string, string> = {
  invoke_contract: "📜",
  create_account: "🆕",
  payment: "💸",
  path_payment_strict_receive: "🔄",
  path_payment_strict_send: "🔄",
  manage_sell_offer: "📈",
  manage_buy_offer: "📉",
  create_passive_sell_offer: "📊",
  set_options: "⚙️",
  change_trust: "🔗",
  allow_trust: "✅",
  account_merge: "🔀",
  manage_data: "📝",
  bump_sequence: "⏭️",
  create_claimable_balance: "💰",
  claim_claimable_balance: "💵",
  begin_sponsoring_future_reserves: "🤝",
  end_sponsoring_future_reserves: "🤝",
  revoke_sponsorship: "🚫",
  clawback: "🪝",
  clawback_claimable_balance: "🪝",
  set_trust_line_flags: "🚩",
  liquidity_pool_deposit: "🏊",
  liquidity_pool_withdraw: "🏊",
  invoke_host_function: "⚡",
  extend_footprint_ttl: "⏰",
  restore_footprint: "♻️",
  unknown: "❓",
};

const TYPE_BADGE_COLORS: Record<string, string> = {
  invoke_contract: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  create_account: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  payment: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  invoke_host_function: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  manage_sell_offer: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  manage_buy_offer: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  change_trust: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  set_options: "bg-gray-500/20 text-gray-300 border-gray-500/30",
  account_merge: "bg-rose-500/20 text-rose-300 border-rose-500/30",
};

export function XdrOperationCard({
  operation,
}: {
  operation: DecodedOperation;
}) {
  const [expanded, setExpanded] = useState(false);

  const icon = OPERATION_ICONS[operation.type] ?? "❓";
  const badgeColor =
    TYPE_BADGE_COLORS[operation.type] ??
    "bg-white/10 text-white/70 border-white/20";
  const hasExtra =
    (operation.contractArgs && operation.contractArgs.length > 0) ||
    operation.sorobanData;

  return (
    <div className="animate-fade-in rounded-2xl border border-white/10 bg-white/5 p-5 transition-colors hover:bg-white/[0.07]">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-sm">
          {icon}
        </span>
        <span className="text-sm font-medium text-white">
          Operation #{operation.index}
        </span>
        <span
          className={`ml-auto rounded-full border px-2.5 py-0.5 text-xs font-medium ${badgeColor}`}
        >
          {operation.type.replace(/_/g, " ")}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {Object.entries(operation.details).map(([key, value]) => (
          <div key={key} className="flex flex-col">
            <span className="text-[11px] font-medium uppercase tracking-wider text-white/40">
              {key.replace(/_/g, " ")}
            </span>
            <span className="font-mono text-xs text-white/80 break-all">
              {key.includes("amount") || key === "starting_balance"
                ? formatStroops(value)
                : value.length > 40
                  ? shortenAddress(value)
                  : value}
            </span>
          </div>
        ))}
      </div>

      {hasExtra && (
        <>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-3 text-xs text-stellar-purple hover:text-stellar-purple/80 transition-colors"
          >
            {expanded ? "▼ Hide details" : "▶ Show Soroban details"}
          </button>

          {expanded && (
            <div className="mt-3 space-y-2 rounded-xl border border-white/5 bg-white/[0.03] p-3">
              {operation.contractArgs?.map((arg, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-white/40">
                    arg {i}
                  </span>
                  <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-white/50">
                    {arg.type}
                  </span>
                  <span className="font-mono text-xs text-white/70 break-all">
                    {arg.value}
                  </span>
                </div>
              ))}
              {operation.sorobanData && (
                <div className="mt-2">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-white/40">
                    Soroban Data
                  </span>
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-black/30 p-2 font-mono text-[10px] text-white/60">
                    {operation.sorobanData}
                  </pre>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
