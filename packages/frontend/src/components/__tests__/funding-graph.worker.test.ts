/**
 * @file funding-graph.worker.test.ts
 * @description Unit tests for OffscreenCanvas funding graph rendering worker.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OutboundWorkerMessage, OutboundHoverResult } from "../funding-graph.worker";
import { generateFundingGraphData } from "@/utils/fundingGraphData";

const postedMessages: OutboundWorkerMessage[] = [];

// Stub self global scope for worker execution
vi.stubGlobal("self", {
  onmessage: null as ((event: MessageEvent) => void) | null,
  postMessage: (msg: unknown) => {
    postedMessages.push(msg as OutboundWorkerMessage);
  },
  performance: {
    now: () => 1000,
  },
  requestAnimationFrame: (cb: FrameRequestCallback) => {
    return 1;
  },
  cancelAnimationFrame: (id: number) => {},
});

// Helper mock canvas context
function makeMockContext() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    scale: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
  };
}

function makeMockOffscreenCanvas() {
  const ctx = makeMockContext();
  return {
    width: 800,
    height: 600,
    getContext: vi.fn(() => ctx),
    ctx,
  };
}

async function loadWorkerModule() {
  vi.resetModules();
  await import("../funding-graph.worker");
}

function dispatchMessage(data: unknown) {
  const event = new MessageEvent("message", { data });
  (self as unknown as { onmessage: (e: MessageEvent) => void }).onmessage(event);
}

describe("funding-graph.worker message handler", () => {
  beforeEach(async () => {
    postedMessages.length = 0;
    await loadWorkerModule();
  });

  it("handles INIT message with 10,000+ graph edges and posts INIT_ACK", async () => {
    const mockCanvas = makeMockOffscreenCanvas();
    const data = generateFundingGraphData(100, 10000);

    dispatchMessage({
      type: "INIT",
      canvas: mockCanvas as unknown as OffscreenCanvas,
      width: 800,
      height: 600,
      devicePixelRatio: 1,
      nodes: data.nodes,
      edges: data.edges,
    });

    await Promise.resolve();

    const ack = postedMessages.find((m) => m.type === "INIT_ACK");
    expect(ack).toBeDefined();
    expect((ack as { success: boolean }).success).toBe(true);
    expect(mockCanvas.getContext).toHaveBeenCalledWith("2d");
  });

  it("handles RESIZE message and updates canvas dimensions", async () => {
    const mockCanvas = makeMockOffscreenCanvas();
    const data = generateFundingGraphData(20, 50);

    dispatchMessage({
      type: "INIT",
      canvas: mockCanvas as unknown as OffscreenCanvas,
      width: 800,
      height: 600,
      nodes: data.nodes,
      edges: data.edges,
    });

    dispatchMessage({
      type: "RESIZE",
      width: 1024,
      height: 768,
      devicePixelRatio: 2,
    });

    await Promise.resolve();

    expect(mockCanvas.width).toBe(2048);
    expect(mockCanvas.height).toBe(1536);
    expect(mockCanvas.ctx.scale).toHaveBeenCalledWith(2, 2);
  });

  it("handles HOVER message and posts HOVER_RESULT", async () => {
    const mockCanvas = makeMockOffscreenCanvas();
    const data = generateFundingGraphData(10, 20);

    dispatchMessage({
      type: "INIT",
      canvas: mockCanvas as unknown as OffscreenCanvas,
      width: 800,
      height: 600,
      nodes: data.nodes,
      edges: data.edges,
    });

    dispatchMessage({
      type: "HOVER",
      coords: [400, 300], // hover in center
    });

    await Promise.resolve();

    const hoverResult = postedMessages.find(
      (m) => m.type === "HOVER_RESULT"
    ) as OutboundHoverResult | undefined;

    expect(hoverResult).toBeDefined();
    expect(hoverResult?.coords).toEqual([400, 300]);
  });

  it("clears memory and stops loop on CLEANUP / DESTROY", async () => {
    const mockCanvas = makeMockOffscreenCanvas();
    const data = generateFundingGraphData(10, 20);

    dispatchMessage({
      type: "INIT",
      canvas: mockCanvas as unknown as OffscreenCanvas,
      width: 800,
      height: 600,
      nodes: data.nodes,
      edges: data.edges,
    });

    dispatchMessage({ type: "CLEANUP" });

    await Promise.resolve();

    // Verify hover after cleanup returns null node
    postedMessages.length = 0;
    dispatchMessage({ type: "HOVER", coords: [100, 100] });

    const hoverResult = postedMessages.find(
      (m) => m.type === "HOVER_RESULT"
    ) as OutboundHoverResult | undefined;

    expect(hoverResult?.node).toBeNull();
  });
});
