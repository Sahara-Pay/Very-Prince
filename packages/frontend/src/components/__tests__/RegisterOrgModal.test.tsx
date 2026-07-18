import React from "react";
import { render, screen } from "@testing-library/react";
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected = true;
  });

  test("renders dialog with correct ARIA attributes", () => {
    render(<RegisterOrgModal onClose={mockOnClose} onSuccess={mockOnSuccess} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  test("close button has aria-label", () => {
    render(<RegisterOrgModal onClose={mockOnClose} onSuccess={mockOnSuccess} />);

    const closeBtn = screen.getByRole("button", { name: "Close registration modal" });
    expect(closeBtn).toBeInTheDocument();
  });

  test("submit button has correct aria-label", () => {
    render(<RegisterOrgModal onClose={mockOnClose} onSuccess={mockOnSuccess} />);

    const submitBtn = screen.getByRole("button", { name: "Register organization" });
    expect(submitBtn).toBeInTheDocument();
  });

  test("submit button is disabled when not connected", () => {
    mockIsConnected = false;

    render(<RegisterOrgModal onClose={mockOnClose} onSuccess={mockOnSuccess} />);

    const submitBtn = screen.getByRole("button", { name: "Register organization" });
    expect(submitBtn).toBeDisabled();
  });
});
