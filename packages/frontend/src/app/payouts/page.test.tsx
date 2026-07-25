import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import PayoutsPage from "./page";
import React from "react";

// Mock SWR to return pending payouts and history
vi.mock("swr", () => ({
  default: vi.fn((key) => {
    if (!key) return { data: undefined, error: undefined, isLoading: false };
    const url = key[0];
    if (url.includes("maintainer")) {
      return {
        data: [
          {
            orgId: "org-a",
            amountStroops: "50000000",
            amountXlm: "5.00",
            orgName: "Org A",
          },
        ],
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
      };
    }
    if (url.includes("profile")) {
      return {
        data: {
          address: "GABCD1234EFGH5678IJKL9012MNOP3456",
          totalStroops: "100000000",
          totalXlm: "10.00",
          orgIds: ["org-a", "org-b"],
          payouts: [
            {
              orgId: "org-a",
              amountStroops: "50000000",
              ledger: 12345,
              ledgerClosedAt: "2026-01-01T00:00:00Z",
              txHash: "ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
            },
          ],
        },
        error: undefined,
        isLoading: false,
      };
    }
    return { data: undefined, error: undefined, isLoading: false };
  }),
}));

// Mock unified wallet hook
vi.mock("@/hooks/useUnifiedWallet", () => ({
  useUnifiedWallet: vi.fn(() => ({
    isConnected: true,
    publicKey: "GABCD1234EFGH5678IJKL9012MNOP3456",
    claimPayout: vi.fn(),
    isSigning: false,
  })),
}));

// Mock SSE hook
vi.mock("@/hooks/useSSE", () => ({
  useSSEWithSWR: vi.fn(),
}));

describe("PayoutsPage transaction history and pending payouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the payouts and history headers", () => {
    render(<PayoutsPage />);
    expect(screen.getByText("Your Payouts")).toBeDefined();
    expect(screen.getByText("Transaction History")).toBeDefined();
  });

  it("renders pending payout details", () => {
    render(<PayoutsPage />);
    expect(screen.getByText("Org A")).toBeDefined();
    expect(screen.getByText("Claimable:")).toBeDefined();
    expect(screen.getByText("5.00 XLM")).toBeDefined();
  });

  it("renders transaction history stats cards", () => {
    render(<PayoutsPage />);
    expect(screen.getByText("Total Earned")).toBeDefined();
    expect(screen.getByText("10.00 XLM")).toBeDefined();
    expect(screen.getByText("Payouts Received")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("Contributing Orgs")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
  });

  it("renders the timeline of transactions", () => {
    render(<PayoutsPage />);
    expect(screen.getByText("from")).toBeDefined();
    expect(screen.getByText("org-a")).toBeDefined();
    expect(screen.getByText(/Ledger #12345/)).toBeDefined();
    expect(screen.getByText("ABCDEF12...567890")).toBeDefined();
  });
});
