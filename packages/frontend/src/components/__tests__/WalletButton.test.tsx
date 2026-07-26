import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi } from "vitest";
import { WalletButton } from "../WalletButton";

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

function createMockState(overrides: Record<string, unknown> = {}) {
  return {
    isInitialized: true,
    isInstalled: true,
    isConnected: false,
    publicKey: null,
    isLoading: false,
    connect: mockConnect,
    disconnect: mockDisconnect,
    error: null,
    ...overrides,
  };
}

vi.mock("@/hooks/useUnifiedWallet", () => ({
  useUnifiedWallet: vi.fn(),
}));

import { useUnifiedWallet } from "@/hooks/useUnifiedWallet";
const mockUseUnifiedWallet = useUnifiedWallet as ReturnType<typeof vi.fn>;

describe("WalletButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("shows loading placeholder when not initialized", () => {
    mockUseUnifiedWallet.mockReturnValue(createMockState({ isInitialized: false }));
    const { container } = render(<WalletButton />);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  test("shows install link when Freighter is not installed", () => {
    mockUseUnifiedWallet.mockReturnValue(createMockState({ isInstalled: false }));
    render(<WalletButton />);

    const link = screen.getByRole("link", { name: /install freighter/i });
    expect(link).toHaveAttribute("href", "https://freighter.app");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("shows connect button with correct aria-label when not connected", () => {
    mockUseUnifiedWallet.mockReturnValue(createMockState());
    render(<WalletButton />);

    const btn = screen.getByRole("button", { name: "Connect Freighter wallet" });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  test("disables connect button while loading", () => {
    mockUseUnifiedWallet.mockReturnValue(createMockState({ isLoading: true }));
    render(<WalletButton />);

    const btn = screen.getByRole("button", { name: "Connect Freighter wallet" });
    expect(btn).toBeDisabled();
  });

  test("shows disconnect button with correct aria-label when connected", () => {
    mockUseUnifiedWallet.mockReturnValue(
      createMockState({ isConnected: true, publicKey: "GABCDEFGHIJK1234567890123456789012345678901234" })
    );
    render(<WalletButton />);

    const btn = screen.getByRole("button", { name: "Disconnect wallet" });
    expect(btn).toBeInTheDocument();
  });

  test("shows truncated address when connected", () => {
    mockUseUnifiedWallet.mockReturnValue(
      createMockState({ isConnected: true, publicKey: "GABCDEFGHIJK1234567890123456789012345678901234" })
    );
    render(<WalletButton />);

    expect(screen.getByText(/GABC\.\.\.1234/)).toBeInTheDocument();
  });

  test("shows error message when error is present", () => {
    mockUseUnifiedWallet.mockReturnValue(
      createMockState({ error: "Something went wrong" })
    );
    render(<WalletButton />);

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });
});
