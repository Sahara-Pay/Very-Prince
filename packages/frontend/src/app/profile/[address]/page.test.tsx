import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import ProfilePage from "./page";

// Stub fetch used inside fetchProfileStats so the async server component renders
vi.stubGlobal(
  "fetch",
  vi.fn(async () => ({
    ok: true,
    json: async () => ({
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
    }),
  }))
);

describe("ProfilePage responsive layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the responsive stats grid", async () => {
    const el = await ProfilePage({ params: { address: "GTEST" } });
    render(el as React.ReactElement);
    // Stat labels present
    expect(screen.getByText("Total Earned")).toBeDefined();
    expect(screen.getByText("Payouts Received")).toBeDefined();
    expect(screen.getByText("Contributing Orgs")).toBeDefined();
  });

  it("renders the share CTA and org chips", async () => {
    const el = await ProfilePage({ params: { address: "GTEST" } });
    render(el as React.ReactElement);
    expect(screen.getAllByText("org-a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("org-b").length).toBeGreaterThan(0);
    expect(screen.getByText(/Share profile/i)).toBeDefined();
  });

  it("handles missing profile gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => null }))
    );
    const el = await ProfilePage({ params: { address: "GMISSING" } });
    render(el as React.ReactElement);
    expect(screen.getByText(/No profile found/i)).toBeDefined();
  });
});
