/**
 * @file dashboard/page.tsx
 * @description PayoutRegistry dashboard.
 */

"use client";

import { useState, useEffect, useCallback, Suspense, useOptimistic, useTransition, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { WalletButton } from "@/components/WalletButton";
import dynamic from "next/dynamic";
import { PayoutCard } from "@/components/PayoutCard";
import DashboardLoading from "./loading";

const FundOrgModal = dynamic(
  () => import("@/components/FundOrgModal").then((mod) => mod.FundOrgModal),
  { ssr: false }
);
const AllocatePayoutModal = dynamic(
  () => import("@/components/AllocatePayoutModal").then((mod) => mod.AllocatePayoutModal),
  { ssr: false }
);
import { EmptyMaintainersState } from "@/components/EmptyMaintainersState";
import { WebhookSettings } from "@/components/WebhookSettings";
import { ApiKeySettings } from "@/components/ApiKeySettings";
import { FundingHistoryChart } from "@/components/FundingHistoryChart";
import { useFreighter } from "@/hooks/useFreighter";
import {
  readMaintainers,
  readClaimableBalance,
  buildClaimPayoutTransaction,
  submitSignedTransaction,
} from "@/lib/sorobanClient";
import type { Organization, MaintainerBalance } from "@/lib/contractTypes";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useOrganizationData } from "@/hooks/useOrganizationData";
import { usePredictivePrefetch } from "@/hooks/usePredictivePrefetch";
import { prefetchFundOrgIntent } from "@/lib/predictivePrefetch";
import type { PrefetchTarget } from "@/lib/predictivePrefetch";

// ── Inner Component (uses useSearchParams) ────────────────────────────────────

function DashboardPageInner() {
  const { isConnected, publicKey, isInitialized, signTransaction } = useFreighter();
  const searchParams = useSearchParams();

  // ── State ─────────────────────────────────────────────────────────────────
  const [orgIdInput, setOrgIdInput] = useState("");
  const [lookupOrgId, setLookupOrgId] = useState<string | undefined>(undefined);
  const [showFundModal, setShowFundModal] = useState(false);
  const [claimingAddress, setClaimingAddress] = useState<string | null>(null);
  const [balances, setBalances] = useState<MaintainerBalance[]>([]);
  const [showAllocateModal, setShowAllocateModal] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "settings">("overview");
  const fundButtonRef = useRef<HTMLButtonElement | null>(null);
  
  type OptimisticAction =
    | { type: "allocate"; address: string; amount: bigint }
    | { type: "claim"; address: string };

  const [optimisticBalances, dispatchOptimisticBalance] = useOptimistic(
    balances,
    (state, action: OptimisticAction) => {
      if (action.type === "claim") {
        return state.map((b) =>
          b.address === action.address
            ? { ...b, stroops: BigInt(0), xlm: "0.0000000", isPending: true }
            : b
        );
      }

      const existingIndex = state.findIndex(b => b.address === action.address);
      if (existingIndex !== -1) {
        const newState = [...state];
        const current = newState[existingIndex]!;
        const newStroops = current.stroops + action.amount;
        newState[existingIndex] = {
          ...current,
          stroops: newStroops,
          xlm: (Number(newStroops) / 10_000_000).toFixed(7),
          isPending: true,
        };
        return newState;
      } else {
        return [
          ...state,
          {
            address: action.address,
            stroops: action.amount,
            xlm: (Number(action.amount) / 10_000_000).toFixed(7),
            isPending: true,
          },
        ];
      }
    }
  );

  const {
    data: orgData,
    isLoading: isOrgLoading,
    error: orgQueryError,
    refetch: refetchOrgData,
  } = useOrganizationData(lookupOrgId);
  const organization = orgData?.organization ?? null;

  // Predictive prefetch for Fund Org — warms the modal chunk before mousedown.
  // On mobile (coarse pointer) falls back to IntersectionObserver prefetching.
  const fundPrefetchTargets: PrefetchTarget[] = useMemo(
    () => [
      {
        id: "dashboard:fund-org",
        getRect: () => {
          const el = fundButtonRef.current;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          return {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
          };
        },
        getElement: () => fundButtonRef.current,
        prefetch: (signal) => prefetchFundOrgIntent(signal),
      },
    ],
    [],
  );
  usePredictivePrefetch({
    targets: fundPrefetchTargets,
    enabled: Boolean(organization),
  });
  const orgBudget = orgData?.budget ?? null;
import { DashboardContent } from "@/components/DashboardContent";

interface DashboardPageProps {
  searchParams: {
    org?: string;
  };
}

export default function DashboardPage({ searchParams }: DashboardPageProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <DashboardContent initialOrgId={searchParams.org} />
    </div>
  );
}
