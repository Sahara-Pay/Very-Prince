import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi } from "vitest";
import { SignInButton } from "../SignInButton";

const mockConnectWallet = vi.fn();
const mockSignIn = vi.fn();
const mockSignOut = vi.fn();

vi.mock("@/hooks/useAuth", () => ({
  useAuthWithWallet: vi.fn(),
}));

vi.mock("@/contexts/WalletContext", () => ({
  useWallet: () => ({
    connectWallet: mockConnectWallet,
    publicKey: "GABCDEFGHIJK1234567890123456789012345678901234",
  }),
}));

import { useAuthWithWallet } from "@/hooks/useAuth";
const mockUseAuth = useAuthWithWallet as ReturnType<typeof vi.fn>;

describe("SignInButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("shows loading button with correct aria-label", () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isWalletConnected: false,
      signIn: mockSignIn,
      signOut: mockSignOut,
      isLoading: true,
      user: null,
    });

    render(<SignInButton />);

    const btn = screen.getByRole("button", { name: "Signing in with wallet" });
    expect(btn).toBeDisabled();
  });

  test("shows connect wallet button with correct aria-label when no wallet connected", () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isWalletConnected: false,
      signIn: mockSignIn,
      signOut: mockSignOut,
      isLoading: false,
      user: null,
    });

    render(<SignInButton />);

    const btn = screen.getByRole("button", { name: "Connect wallet to sign in" });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  test("shows sign in button with correct aria-label when wallet is connected but not authenticated", () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isWalletConnected: true,
      signIn: mockSignIn,
      signOut: mockSignOut,
      isLoading: false,
      user: null,
    });

    render(<SignInButton />);

    const btn = screen.getByRole("button", { name: "Sign in with Stellar wallet" });
    expect(btn).toBeInTheDocument();
  });

  test("shows sign out button with correct aria-label when authenticated", () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      isWalletConnected: true,
      signIn: mockSignIn,
      signOut: mockSignOut,
      isLoading: false,
      user: { publicKey: "GABCDEFGHIJK1234567890123456789012345678901234" },
    });

    render(<SignInButton />);

    const btn = screen.getByRole("button", { name: "Sign out of account" });
    expect(btn).toBeInTheDocument();
  });

  test("shows sign in button when wallet connected but no user (alternate state)", () => {
    mockUseAuth.mockReturnValue({
      isAuthenticated: false,
      isWalletConnected: true,
      signIn: mockSignIn,
      signOut: mockSignOut,
      isLoading: false,
      user: null,
    });

    render(<SignInButton />);

    const btn = screen.getByRole("button", { name: "Sign in with Stellar wallet" });
    expect(btn).toBeInTheDocument();
  });
});
