import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi, describe, test, expect } from "vitest";
import {
  SuspenseOrchestratorProvider,
  OrchestratedBoundary,
  useSuspenseOrchestrator,
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
});
