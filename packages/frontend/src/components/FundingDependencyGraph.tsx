"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { generateFundingGraphData, GraphNode, GraphData } from "@/utils/fundingGraphData";
import type { OutboundWorkerMessage, OutboundHoverResult, OutboundStats } from "./funding-graph.worker";

interface FundingDependencyGraphProps {
  initialNodeCount?: number;
  initialEdgeCount?: number;
  customData?: GraphData;
  className?: string;
  onNodeHover?: (node: GraphNode | null) => void;
}

export function FundingDependencyGraph({
  initialNodeCount = 500,
  initialEdgeCount = 10000,
  customData,
  className = "",
  onNodeHover,
}: FundingDependencyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);

  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<[number, number] | null>(null);
  const [fps, setFps] = useState<number>(60);
  const [nodeCount, setNodeCount] = useState<number>(initialNodeCount);
  const [edgeCount, setEdgeCount] = useState<number>(initialEdgeCount);
  const [isOffscreenSupported, setIsOffscreenSupported] = useState<boolean>(true);
  const [isInitialized, setIsInitialized] = useState<boolean>(false);

  // Initialize Worker & OffscreenCanvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;

    if (!canvas || !container) return;

    // Check OffscreenCanvas support
    if (typeof canvas.transferControlToOffscreen !== "function") {
      setIsOffscreenSupported(false);
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = Math.max(300, Math.floor(rect.width));
    const height = Math.max(300, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    // Detach canvas context to offscreen
    let offscreen: OffscreenCanvas;
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch {
      // In case canvas context was already detached or unsupported
      setIsOffscreenSupported(false);
      return;
    }

    // Generate graph dataset
    const graphData = customData ?? generateFundingGraphData(initialNodeCount, initialEdgeCount);
    setNodeCount(graphData.nodes.length);
    setEdgeCount(graphData.edges.length);

    // Spawn dedicated Web Worker
    const worker = new Worker(
      new URL("./funding-graph.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;

    // Handle messages from Worker
    worker.onmessage = (event: MessageEvent<OutboundWorkerMessage>) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === "HOVER_RESULT") {
        const hoverMsg = msg as OutboundHoverResult;
        setHoveredNode(hoverMsg.node as GraphNode | null);
        setTooltipPos(hoverMsg.node ? hoverMsg.coords : null);
        if (onNodeHover) {
          onNodeHover(hoverMsg.node as GraphNode | null);
        }
      } else if (msg.type === "STATS") {
        const statsMsg = msg as OutboundStats;
        setFps(statsMsg.fps);
      } else if (msg.type === "INIT_ACK") {
        setIsInitialized(true);
      }
    };

    // Transfer control & data to Worker
    worker.postMessage(
      {
        type: "INIT",
        canvas: offscreen,
        width,
        height,
        devicePixelRatio: dpr,
        nodes: graphData.nodes,
        edges: graphData.edges,
      },
      [offscreen] // Transfer array detaches offscreen canvas from main thread
    );

    // Setup ResizeObserver for responsive layout
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: newW, height: newH } = entry.contentRect;
        if (newW > 0 && newH > 0 && workerRef.current) {
          workerRef.current.postMessage({
            type: "RESIZE",
            width: Math.floor(newW),
            height: Math.floor(newH),
            devicePixelRatio: window.devicePixelRatio || 1,
          });
        }
      }
    });

    resizeObserver.observe(container);

    // Aggressive Garbage Collection & Cleanup on unmount
    return () => {
      resizeObserver.disconnect();

      if (workerRef.current) {
        workerRef.current.postMessage({ type: "CLEANUP" });
        workerRef.current.terminate();
        workerRef.current = null;
      }
      setIsInitialized(false);
    };
  }, [initialNodeCount, initialEdgeCount, customData, onNodeHover]);

  // Sync mouse hover events back to worker via standard postMessage arrays
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || !workerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Send array [mouseX, mouseY] to worker
    workerRef.current.postMessage({
      type: "HOVER",
      coords: [mouseX, mouseY],
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({
        type: "HOVER",
        coords: [-1, -1],
      });
    }
    setHoveredNode(null);
    setTooltipPos(null);
  }, []);

  const formatShortAddress = (name: string) => {
    if (name.length > 20) {
      return `${name.slice(0, 10)}...${name.slice(-6)}`;
    }
    return name;
  };

  return (
    <div
      className={`glass-card p-6 relative overflow-hidden flex flex-col gap-4 border border-white/10 ${className}`}
    >
      {/* Header & FPS Stats */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 z-10 select-none">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-white text-base tracking-wide flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-stellar-teal shadow-[0_0_8px_#00CDCC]" />
              2D Funding Dependency Graph
            </h3>
            <span className="badge border border-stellar-purple/30 bg-stellar-purple/10 text-stellar-purple text-xs px-2 py-0.5 rounded-full">
              OffscreenCanvas Worker
            </span>
          </div>
          <p className="text-white/40 text-xs mt-1">
            Background Web Worker layout physics and pixel rendering off-main-thread
          </p>
        </div>

        {/* Status badges */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs">
            <span className="text-white/50">Nodes:</span>
            <span className="font-mono font-semibold text-white">{nodeCount}</span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-xs">
            <span className="text-white/50">Edges:</span>
            <span className="font-mono font-semibold text-stellar-teal">
              {edgeCount.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-500/10 border border-green-500/30 text-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
            <span className="font-mono font-bold text-green-400">{fps} FPS</span>
          </div>
        </div>
      </div>

      {/* Main Canvas Container */}
      <div
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="relative w-full h-[480px] rounded-xl overflow-hidden bg-[#0A0E27] border border-white/5 cursor-crosshair group"
      >
        <canvas
          ref={canvasRef}
          className="w-full h-full block"
        />

        {!isOffscreenSupported && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-stellar-blue/90 p-6 text-center z-20">
            <p className="text-amber-400 font-semibold mb-2">OffscreenCanvas Not Supported</p>
            <p className="text-white/60 text-sm max-w-md">
              Your browser environment does not support transferring canvas control to Web Workers.
            </p>
          </div>
        )}

        {/* Hover Tooltip Overlay */}
        {hoveredNode && tooltipPos && (
          <div
            className="absolute z-30 glass-panel p-3 text-xs pointer-events-none shadow-2xl transition-all duration-75 -translate-x-1/2 -translate-y-full flex flex-col gap-1 border border-stellar-teal/30 bg-stellar-blue/95"
            style={{
              left: `${tooltipPos[0]}px`,
              top: `${tooltipPos[1] - 12}px`,
              minWidth: "180px",
            }}
          >
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-1">
              <span className="font-semibold text-white truncate">
                {formatShortAddress(hoveredNode.name)}
              </span>
              <span
                className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                  hoveredNode.type === "org"
                    ? "bg-purple-500/20 text-purple-300"
                    : hoveredNode.type === "pool"
                    ? "bg-teal-500/20 text-teal-300"
                    : hoveredNode.type === "donor"
                    ? "bg-amber-500/20 text-amber-300"
                    : "bg-green-500/20 text-green-300"
                }`}
              >
                {hoveredNode.type}
              </span>
            </div>

            <div className="flex justify-between items-baseline gap-4 pt-1">
              <span className="text-white/60">Total Payout Volume</span>
              <span className="font-bold text-stellar-teal font-mono">
                {hoveredNode.amountXlm.toLocaleString()} XLM
              </span>
            </div>

            <div className="flex justify-between items-baseline gap-4">
              <span className="text-white/60">Payout Transfers</span>
              <span className="font-bold text-white font-mono">
                {hoveredNode.payoutCount}
              </span>
            </div>
          </div>
        )}

        {/* Legend Overlay */}
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-3 px-3 py-1.5 rounded-lg bg-stellar-blue/80 border border-white/10 backdrop-blur-md text-[11px] text-white/70 select-none">
          <div className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-[#7B61FF]" /> Orgs
          </div>
          <div className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-[#00CDCC]" /> Pools
          </div>
          <div className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-[#FFB800]" /> Donors
          </div>
          <div className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-[#39D353]" /> Maintainers
          </div>
        </div>
      </div>
    </div>
  );
}
