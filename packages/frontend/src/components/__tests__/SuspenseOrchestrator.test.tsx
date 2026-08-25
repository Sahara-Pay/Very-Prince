import React from "react";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi, describe, test, expect } from "vitest";
import {
  SuspenseOrchestratorProvider,
  OrchestratedBoundary,
  useSuspenseOrchestrator,
  useZeroLayoutShiftMutation,
} from "../SuspenseOrchestrator";

function ContextConsumer() {
  const { isFullyResolved, isPending, registeredBoundaries } = useSuspenseOrchestrator();
  return (
    <div>
      <span data-testid="resolved">{isFullyResolved ? "yes" : "no"}</span>
      <span data-testid="pending">{isPending ? "yes" : "no"}</span>
      <span data-testid="count">{Object.keys(registeredBoundaries).length}</span>
    </div>
  );
}

function ThrowsOutsideProvider() {
  useSuspenseOrchestrator();
  return <div>Component</div>;
}

function MutationComponent({ mutationFn }: { mutationFn: (arg: string) => Promise<string> }) {
  const { executeMutation, isPending, error } = useZeroLayoutShiftMutation(mutationFn);
  const [result, setResult] = React.useState<string>("");

  return (
    <div>
      <button
        data-testid="mutate-btn"
        onClick={async () => {
          try {
            const res = await executeMutation("payload");
            if (res) setResult(res);
          } catch {}
        }}
      >
        Mutate
      </button>
      <span data-testid="mutation-pending">{isPending ? "pending" : "idle"}</span>
      <span data-testid="mutation-result">{result}</span>
      <span data-testid="mutation-error">{error?.message || ""}</span>
    </div>
  );
}

describe("SuspenseOrchestrator", () => {
  test("throws error if useSuspenseOrchestrator is used outside provider", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<ThrowsOutsideProvider />)).toThrow(
      "useSuspenseOrchestrator must be used within a SuspenseOrchestratorProvider"
    );
    consoleSpy.mockRestore();
  });

  test("renders fallback overlay until all critical boundaries are ready", async () => {
    render(
      <SuspenseOrchestratorProvider fallback={<div data-testid="fallback">Loading...</div>}>
        <ContextConsumer />
        <OrchestratedBoundary id="b1" isCritical={true} isReady={false}>
          <div data-testid="content-b1">Boundary 1</div>
        </OrchestratedBoundary>
        <OrchestratedBoundary id="b2" isCritical={true} isReady={true}>
          <div data-testid="content-b2">Boundary 2</div>
        </OrchestratedBoundary>
      </SuspenseOrchestratorProvider>
    );

    expect(screen.getByTestId("fallback")).toBeInTheDocument();
    expect(screen.getByTestId("resolved").textContent).toBe("no");
    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  test("resolves when all critical boundaries report isReady={true}", async () => {
    const { rerender } = render(
      <SuspenseOrchestratorProvider fallback={<div data-testid="fallback">Loading...</div>}>
        <ContextConsumer />
        <OrchestratedBoundary id="b1" isCritical={true} isReady={false}>
          <div>Boundary 1</div>
        </OrchestratedBoundary>
      </SuspenseOrchestratorProvider>
    );

    expect(screen.getByTestId("resolved").textContent).toBe("no");

    rerender(
      <SuspenseOrchestratorProvider fallback={<div data-testid="fallback">Loading...</div>}>
        <ContextConsumer />
        <OrchestratedBoundary id="b1" isCritical={true} isReady={true}>
          <div>Boundary 1</div>
        </OrchestratedBoundary>
      </SuspenseOrchestratorProvider>
    );

    expect(screen.getByTestId("resolved").textContent).toBe("yes");
  });

  test("non-critical boundary does not block resolution", () => {
    const { rerender } = render(
      <SuspenseOrchestratorProvider fallback={<div data-testid="fallback">Loading...</div>}>
        <ContextConsumer />
        <OrchestratedBoundary id="critical-1" isCritical={true} isReady={false}>
          <div>Critical</div>
        </OrchestratedBoundary>
        <OrchestratedBoundary id="non-critical-1" isCritical={false} isReady={false}>
          <div>Non Critical</div>
        </OrchestratedBoundary>
      </SuspenseOrchestratorProvider>
    );

    expect(screen.getByTestId("resolved").textContent).toBe("no");

    rerender(
      <SuspenseOrchestratorProvider fallback={<div data-testid="fallback">Loading...</div>}>
        <ContextConsumer />
        <OrchestratedBoundary id="critical-1" isCritical={true} isReady={true}>
          <div>Critical</div>
        </OrchestratedBoundary>
        <OrchestratedBoundary id="non-critical-1" isCritical={false} isReady={false}>
          <div>Non Critical</div>
        </OrchestratedBoundary>
      </SuspenseOrchestratorProvider>
    );

    expect(screen.getByTestId("resolved").textContent).toBe("yes");
  });

  test("handles unmounting of boundaries gracefully via unregisterBoundary", () => {
    const { rerender } = render(
      <SuspenseOrchestratorProvider fallback={<div data-testid="fallback">Loading...</div>}>
        <ContextConsumer />
        <OrchestratedBoundary id="dynamic-b" isCritical={true} isReady={false}>
          <div>Dynamic Component</div>
        </OrchestratedBoundary>
      </SuspenseOrchestratorProvider>
    );

    expect(screen.getByTestId("count").textContent).toBe("1");

    // Unmount boundary
    rerender(
      <SuspenseOrchestratorProvider fallback={<div data-testid="fallback">Loading...</div>}>
        <ContextConsumer />
      </SuspenseOrchestratorProvider>
    );

    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(screen.getByTestId("resolved").textContent).toBe("yes");
  });

  test("rejects malformed boundary IDs cleanly", () => {
    render(
      <SuspenseOrchestratorProvider fallback={<div data-testid="fallback">Loading...</div>}>
        <ContextConsumer />
        <OrchestratedBoundary id="" isCritical={true} isReady={true}>
          <div>Malformed 1</div>
        </OrchestratedBoundary>
        <OrchestratedBoundary id="   " isCritical={true} isReady={true}>
          <div>Malformed 2</div>
        </OrchestratedBoundary>
      </SuspenseOrchestratorProvider>
    );

    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  test("maintains WCAG AAA accessible attributes on fallback loader overlay", () => {
    render(
      <SuspenseOrchestratorProvider fallback={<div data-testid="fallback">Loading...</div>}>
        <ContextConsumer />
        <OrchestratedBoundary id="a11y-check" isCritical={true} isReady={false}>
          <div>A11y</div>
        </OrchestratedBoundary>
      </SuspenseOrchestratorProvider>
    );

    const statusOverlay = screen.getByRole("status");
    expect(statusOverlay).toHaveAttribute("aria-live", "polite");
    expect(statusOverlay).toHaveAttribute("aria-busy", "true");
    expect(statusOverlay).toHaveAttribute("aria-label", "Loading content");
  });

  test("useZeroLayoutShiftMutation executes mutation and handles errors without main-thread jank", async () => {
    const successMutation = vi.fn().mockResolvedValue("success_output");
    render(<MutationComponent mutationFn={successMutation} />);

    await act(async () => {
      screen.getByTestId("mutate-btn").click();
    });

    expect(successMutation).toHaveBeenCalledWith("payload");
    expect(screen.getByTestId("mutation-result").textContent).toBe("success_output");

    const failureMutation = vi.fn().mockRejectedValue(new Error("mutation_error_msg"));
    const { rerender } = render(<MutationComponent mutationFn={failureMutation} />);

    await act(async () => {
      screen.getByTestId("mutate-btn").click();
    });

    expect(screen.getByTestId("mutation-error").textContent).toBe("mutation_error_msg");
  });
});

