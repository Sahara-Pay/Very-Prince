import React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom";
import { vi } from "vitest";
import { RegisterOrgModal } from "../RegisterOrgModal";

const mockOnClose = vi.fn();
const mockOnSuccess = vi.fn();

let mockIsConnected = true;
vi.mock("@/hooks/useFreighter", () => ({
  useFreighter: () => ({
    isConnected: mockIsConnected,
    publicKey: mockIsConnected ? "GABCDEFGHIJK1234567890123456789012345678901234" : null,
  }),
}));

vi.mock("@/lib/api", () => ({
  registerOrganization: vi.fn(),
}));

vi.mock("@/components/GlassPanel", () => ({
  GlassPanel: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

describe("RegisterOrgModal", () => {
  const queryClient = new QueryClient();

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected = true;
  });

  const renderWithClient = (ui: React.ReactElement) => {
    return render(
      <QueryClientProvider client={queryClient}>
        {ui}
      </QueryClientProvider>
    );
  };

  test("renders dialog with correct ARIA attributes", () => {
    renderWithClient(<RegisterOrgModal onClose={mockOnClose} onSuccess={mockOnSuccess} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  test("close button has aria-label", () => {
    renderWithClient(<RegisterOrgModal onClose={mockOnClose} onSuccess={mockOnSuccess} />);

    const closeBtn = screen.getByRole("button", { name: "Close registration modal" });
    expect(closeBtn).toBeInTheDocument();
  });

  test("submit button has correct aria-label", () => {
    renderWithClient(<RegisterOrgModal onClose={mockOnClose} onSuccess={mockOnSuccess} />);

    const submitBtn = screen.getByRole("button", { name: "Register organization" });
    expect(submitBtn).toBeInTheDocument();
  });

  test("submit button is disabled when not connected", () => {
    mockIsConnected = false;

    renderWithClient(<RegisterOrgModal onClose={mockOnClose} onSuccess={mockOnSuccess} />);

    const submitBtn = screen.getByRole("button", { name: "Register organization" });
    expect(submitBtn).toBeDisabled();
  });
});
