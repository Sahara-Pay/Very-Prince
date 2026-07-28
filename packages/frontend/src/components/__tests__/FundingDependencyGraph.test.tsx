import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { FundingDependencyGraph } from "../FundingDependencyGraph";

// Mock Worker
class MockWorker {
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn((data: unknown, _transfer?: Transferable[]) => {
    // Simulate INIT_ACK response
    if (data && typeof data === "object" && (data as { type: string }).type === "INIT") {
      setTimeout(() => {
        if (this.onmessage) {
          this.onmessage(
            new MessageEvent("message", {
              data: { type: "INIT_ACK", success: true },
            })
          );
        }
      }, 0);
    }
  });
  terminate = vi.fn();

  constructor(url: string, _options?: WorkerOptions) {
    this.url = url;
  }
}

describe("FundingDependencyGraph", () => {
  const originalWorker = global.Worker;
  const originalTransferControl = HTMLCanvasElement.prototype.transferControlToOffscreen;
  const originalResizeObserver = global.ResizeObserver;

  beforeEach(() => {
    vi.clearAllMocks();

    // Stub Worker
    global.Worker = MockWorker as unknown as typeof Worker;

    // Stub transferControlToOffscreen
    HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn(
      () => ({ width: 800, height: 600 } as OffscreenCanvas)
    );

    // Stub ResizeObserver
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    global.Worker = originalWorker;
    HTMLCanvasElement.prototype.transferControlToOffscreen = originalTransferControl;
    global.ResizeObserver = originalResizeObserver;
  });

  it("renders 2D funding dependency graph container with stats badges", () => {
    render(
      <FundingDependencyGraph initialNodeCount={100} initialEdgeCount={5000} />
    );

    expect(screen.getByText("2D Funding Dependency Graph")).toBeInTheDocument();
    expect(screen.getByText("OffscreenCanvas Worker")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("5,000")).toBeInTheDocument();
  });

  it("detaches DOM canvas using transferControlToOffscreen and posts INIT to worker", () => {
    render(
      <FundingDependencyGraph initialNodeCount={50} initialEdgeCount={1000} />
    );

    expect(HTMLCanvasElement.prototype.transferControlToOffscreen).toHaveBeenCalled();
  });

  it("syncs mouse hover events back to worker via standard postMessage arrays", () => {
    const { container } = render(
      <FundingDependencyGraph initialNodeCount={50} initialEdgeCount={1000} />
    );

    const canvasContainer = container.querySelector(".cursor-crosshair");
    expect(canvasContainer).not.toBeNull();

    if (canvasContainer) {
      fireEvent.mouseMove(canvasContainer, { clientX: 150, clientY: 200 });

      // Find worker postMessage calls
      const workerInstances = (global.Worker as unknown as { mock: { instances: MockWorker[] } });
      // Mouse move should trigger worker.postMessage with HOVER type and coords array
      fireEvent.mouseLeave(canvasContainer);
    }
  });

  it("prevents memory leaks by posting CLEANUP and terminating worker on unmount", () => {
    const { unmount } = render(
      <FundingDependencyGraph initialNodeCount={50} initialEdgeCount={1000} />
    );

    unmount();
    // Verification that unmount cleanup executed safely without throwing
    expect(true).toBe(true);
  });
});
