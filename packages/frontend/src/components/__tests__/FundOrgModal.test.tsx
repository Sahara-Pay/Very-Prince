import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi } from "vitest";
import { FundOrgModal } from "../FundOrgModal";

const { mockFundOrg } = vi.hoisted(() => ({ mockFundOrg: vi.fn() }));

vi.mock("@/hooks/useFundOrg", () => ({
  useFundOrg: () => ({
    fundOrg: mockFundOrg,
    isSubmitting: false,
    error: null,
  }),
}));

let mockWalletIsConnected = true;
vi.mock("@/hooks/useUnifiedWallet", () => ({
  useUnifiedWallet: () => ({
    isConnected: mockWalletIsConnected,
    publicKey: mockWalletIsConnected ? "GDTESTINGPUBLICKEY1234567890" : null,
  }),
}));

vi.mock("@/lib/sorobanClient", () => ({
  readAccountXlmBalance: vi.fn().mockResolvedValue(100),
}));

describe("FundOrgModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWalletIsConnected = true;
  });

  test("renders dialog with correct ARIA attributes", () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(<FundOrgModal orgId="testorg" onSuccess={onSuccess} onClose={onClose} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "fund-modal-title");
  });

  test("header close button has correct aria-label", () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(<FundOrgModal orgId="testorg" onSuccess={onSuccess} onClose={onClose} />);

    const closeBtn = screen.getByRole("button", { name: "Close modal" });
    expect(closeBtn).toBeInTheDocument();
  });

  test("submit button has correct aria-label when requesting connection", () => {
    mockWalletIsConnected = false;

    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(<FundOrgModal orgId="testorg" onSuccess={onSuccess} onClose={onClose} />);

    const submitBtn = screen.getByRole("button", { name: "Please connect Freighter" });
    expect(submitBtn).toBeInTheDocument();
  });

  test("submit button has correct aria-label for funding", async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    mockFundOrg.mockResolvedValueOnce(undefined);

    render(<FundOrgModal orgId="testorg" onSuccess={onSuccess} onClose={onClose} />);

    // Enter amount to enable the submit button
    const input = screen.getByPlaceholderText("0.00");
    fireEvent.change(input, { target: { value: "10" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Confirm funding" })).not.toBeDisabled();
    });

    const submitBtn = screen.getByRole("button", { name: "Confirm funding" });
    expect(submitBtn).toBeInTheDocument();
  });

  test("shows success screen and share to Twitter button after successful funding", async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    mockFundOrg.mockResolvedValueOnce(undefined);

    render(<FundOrgModal orgId="testorg" onSuccess={onSuccess} onClose={onClose} />);

    // Enter amount to enable the submit button
    const input = screen.getByPlaceholderText("0.00");
    fireEvent.change(input, { target: { value: "10" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Confirm funding" })).not.toBeDisabled();
    });

    // Click fund
    const submitBtn = screen.getByRole("button", { name: "Confirm funding" });
    fireEvent.click(submitBtn);

    // Verify fundOrg was called
    await waitFor(() => {
      expect(mockFundOrg).toHaveBeenCalledWith("testorg", 10);
    });

    // Verify success screen is shown
    expect(await screen.findByText(/Funding Successful/i)).toBeInTheDocument();
    
    // Verify Share to Twitter button is present
    const twitterShareLink = screen.getByRole("link", { name: "Share funding on Twitter" });
    expect(twitterShareLink).toHaveAttribute('href', expect.stringContaining('twitter.com/intent/tweet'));

    // Verify success Close button has aria-label
    const closeBtn = screen.getByRole("button", { name: "Close success message" });
    fireEvent.click(closeBtn);

    // Verify onSuccess is called
    expect(onSuccess).toHaveBeenCalled();
  });
});
