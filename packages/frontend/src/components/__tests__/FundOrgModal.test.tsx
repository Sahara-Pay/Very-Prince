import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi } from "vitest";
import { FundOrgModal } from "../FundOrgModal";

const mockFundOrg = vi.fn();
const mockUseFundOrg = vi.fn();
vi.mock("@/hooks/useFundOrg", () => ({
  useFundOrg: (options?: { onProgress?: (step: string) => void }) => mockUseFundOrg(options),
}));

vi.mock("@/hooks/useUnifiedWallet", () => ({
  useUnifiedWallet: () => ({
    isConnected: true,
    publicKey: "GDTESTINGPUBLICKEY1234567890",
  }),
}));

vi.mock("@/lib/sorobanClient", () => ({
  readAccountXlmBalance: vi.fn().mockResolvedValue(100),
}));

describe("FundOrgModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFundOrg.mockReturnValue({
      fundOrg: mockFundOrg,
      isSubmitting: false,
      error: null,
    });
  });

  test("shows a step-by-step progress bar while funding", async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    mockFundOrg.mockImplementationOnce(async () => {
      return undefined;
    });

    render(<FundOrgModal orgId="testorg" onSuccess={onSuccess} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Confirm Funding/i })).not.toBeDisabled();
    });

    const input = screen.getByPlaceholderText("0.00");
    fireEvent.change(input, { target: { value: "10" } });

    fireEvent.click(screen.getByRole("button", { name: /Confirm Funding/i }));

    expect(await screen.findByText("Building XDR")).toBeInTheDocument();
    expect(screen.getByText("Requesting Signature")).toBeInTheDocument();
    expect(screen.getByText("Submitting")).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
  });

  test("shows success screen and share to Twitter button after successful funding", async () => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    mockFundOrg.mockResolvedValueOnce(undefined);

    render(<FundOrgModal orgId="testorg" onSuccess={onSuccess} onClose={onClose} />);

    // Wait for balance to load and modal to be ready
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Confirm Funding/i })).not.toBeDisabled();
    });

    // Enter amount
    const input = screen.getByPlaceholderText("0.00");
    fireEvent.change(input, { target: { value: "10" } });

    // Click fund
    const submitBtn = screen.getByRole("button", { name: /Confirm Funding/i });
    fireEvent.click(submitBtn);

    // Verify fundOrg was called
    await waitFor(() => {
      expect(mockFundOrg).toHaveBeenCalledWith("testorg", 10);
    });

    // Verify success screen is shown
    expect(await screen.findByText(/Funding Successful/i)).toBeInTheDocument();
    
    // Verify Share to Twitter button is present
    const twitterShareBtn = screen.getByText("Share to Twitter/X");
    expect(twitterShareBtn).toBeInTheDocument();
    expect(twitterShareBtn.closest('a')).toHaveAttribute('href', expect.stringContaining('twitter.com/intent/tweet'));

    // Verify Close button
    const closeBtn = screen.getByRole("button", { name: "Close" });
    fireEvent.click(closeBtn);

    // Verify onSuccess is called
    expect(onSuccess).toHaveBeenCalled();
  });
});
