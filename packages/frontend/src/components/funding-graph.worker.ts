/**
 * @file funding-graph.worker.ts
 * @description Dedicated Web Worker for OffscreenCanvas 2D dependency graph rendering.
 * Runs layout physics and pixel rendering off-main-thread for 10,000+ graph edges.
 */

export interface WorkerInitMessage {
  type: "INIT";
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  devicePixelRatio?: number;
  nodes: Array<{
    id: string;
    name: string;
    type: 'org' | 'maintainer' | 'pool' | 'donor';
    amountXlm: number;
    payoutCount: number;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    amountXlm: number;
    timestamp: number;
  }>;
}

export interface WorkerResizeMessage {
  type: "RESIZE";
  width: number;
  height: number;
  devicePixelRatio?: number;
}

export interface WorkerHoverMessage {
  type: "HOVER";
  coords: [number, number]; // Standard mouse hover coordinate array [x, y]
}

export interface WorkerCleanupMessage {
  type: "CLEANUP" | "DESTROY";
}

export type InboundWorkerMessage =
  | WorkerInitMessage
  | WorkerResizeMessage
  | WorkerHoverMessage
  | WorkerCleanupMessage;

export interface OutboundHoverResult {
  type: "HOVER_RESULT";
  node: {
    id: string;
    name: string;
    type: 'org' | 'maintainer' | 'pool' | 'donor';
    amountXlm: number;
    payoutCount: number;
  } | null;
  coords: [number, number];
}

export interface OutboundStats {
  type: "STATS";
  fps: number;
  nodeCount: number;
  edgeCount: number;
}

export type OutboundWorkerMessage = OutboundHoverResult | OutboundStats | { type: "INIT_ACK"; success: boolean };

// ── In-Worker State & TypedArrays for High Performance ─────────────────────────

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let width = 800;
let height = 600;
let dpr = 1;
let animFrameId: number | null = null;
let isRunning = false;

// Nodes data
let rawNodes: WorkerInitMessage["nodes"] = [];
let rawEdges: WorkerInitMessage["edges"] = [];
let nodeMap = new Map<string, number>(); // ID -> Index mapping

// TypedArrays for 0-allocation frame rendering
let nodeX: Float32Array | null = null;
let nodeY: Float32Array | null = null;
let nodeVx: Float32Array | null = null;
let nodeVy: Float32Array | null = null;
let nodeRadius: Float32Array | null = null;
let nodeTypes: Uint8Array | null = null; // 0: org, 1: pool, 2: donor, 3: maintainer

let edgeSources: Int32Array | null = null;
let edgeTargets: Int32Array | null = null;

let hoveredNodeIndex: number = -1;
let hoverCoords: [number, number] = [-1, -1];

// Performance tracking
let lastFrameTime = self.performance ? self.performance.now() : Date.now();
let frameCount = 0;
let lastFpsReport = lastFrameTime;

// ── Helper Initialization ──────────────────────────────────────────────────

function initGraphState(
  inputNodes: WorkerInitMessage["nodes"],
  inputEdges: WorkerInitMessage["edges"]
) {
  rawNodes = inputNodes;
  rawEdges = inputEdges;
  nodeMap.clear();

  const count = rawNodes.length;
  nodeX = new Float32Array(count);
  nodeY = new Float32Array(count);
  nodeVx = new Float32Array(count);
  nodeVy = new Float32Array(count);
  nodeRadius = new Float32Array(count);
  nodeTypes = new Uint8Array(count);

  const centerX = width / 2;
  const centerY = height / 2;

  // Initialize node layout in rings based on node type
  for (let i = 0; i < count; i++) {
    const node = rawNodes[i]!;
    nodeMap.set(node.id, i);

    let typeCode = 3;
    let radius = 6;
    let ringRadius = Math.min(width, height) * 0.35;

    if (node.type === "org") {
      typeCode = 0;
      radius = 16;
      ringRadius = Math.min(width, height) * 0.1;
    } else if (node.type === "pool") {
      typeCode = 1;
      radius = 11;
      ringRadius = Math.min(width, height) * 0.22;
    } else if (node.type === "donor") {
      typeCode = 2;
      radius = 8;
      ringRadius = Math.min(width, height) * 0.38;
    }

    nodeTypes[i] = typeCode;
    nodeRadius[i] = radius;

    const angle = Math.random() * Math.PI * 2;
    const dist = ringRadius + (Math.random() - 0.5) * 40;
    nodeX[i] = centerX + Math.cos(angle) * dist;
    nodeY[i] = centerY + Math.sin(angle) * dist;
    nodeVx[i] = (Math.random() - 0.5) * 0.5;
    nodeVy[i] = (Math.random() - 0.5) * 0.5;
  }

  // Build edge index arrays
  const validEdges: Array<[number, number]> = [];
  for (let i = 0; i < inputEdges.length; i++) {
    const e = inputEdges[i]!;
    const sIdx = nodeMap.get(e.source);
    const tIdx = nodeMap.get(e.target);
    if (sIdx !== undefined && tIdx !== undefined) {
      validEdges.push([sIdx, tIdx]);
    }
  }

  edgeSources = new Int32Array(validEdges.length);
  edgeTargets = new Int32Array(validEdges.length);

  for (let i = 0; i < validEdges.length; i++) {
    const pair = validEdges[i]!;
    edgeSources[i] = pair[0];
    edgeTargets[i] = pair[1];
  }
}

// ── Physics Simulation Step ─────────────────────────────────────────────────

function updatePhysics() {
  if (!nodeX || !nodeY || !nodeVx || !nodeVy || !edgeSources || !edgeTargets) return;

  const count = nodeX.length;
  const padding = 30;

  // 1. Boundary & Damping
  for (let i = 0; i < count; i++) {
    nodeX[i] += nodeVx[i]!;
    nodeY[i] += nodeVy[i]!;

    nodeVx[i] *= 0.92;
    nodeVy[i] *= 0.92;

    if (nodeX[i]! < padding) {
      nodeX[i] = padding;
      nodeVx[i] *= -0.5;
    } else if (nodeX[i]! > width - padding) {
      nodeX[i] = width - padding;
      nodeVx[i] *= -0.5;
    }

    if (nodeY[i]! < padding) {
      nodeY[i] = padding;
      nodeVy[i] *= -0.5;
    } else if (nodeY[i]! > height - padding) {
      nodeY[i] = height - padding;
      nodeVy[i] *= -0.5;
    }
  }

  // 2. Edge attraction forces (sampled for performance with 10,000+ edges)
  const edgeCount = edgeSources.length;
  const step = edgeCount > 5000 ? Math.ceil(edgeCount / 3000) : 1;

  for (let i = 0; i < edgeCount; i += step) {
    const s = edgeSources[i]!;
    const t = edgeTargets[i]!;

    const dx = nodeX[t]! - nodeX[s]!;
    const dy = nodeY[t]! - nodeY[s]!;
    const dist = Math.hypot(dx, dy) || 1;
    const force = (dist - 120) * 0.0003;

    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;

    nodeVx[s]! += fx;
    nodeVy[s]! += fy;
    nodeVx[t]! -= fx;
    nodeVy[t]! -= fy;
  }
}

// ── Rendering Loop ─────────────────────────────────────────────────────────

function renderFrame() {
  if (!ctx || !nodeX || !nodeY || !edgeSources || !edgeTargets) return;

  const now = self.performance ? self.performance.now() : Date.now();
  frameCount++;

  if (now - lastFpsReport >= 1000) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsReport));
    frameCount = 0;
    lastFpsReport = now;

    self.postMessage({
      type: "STATS",
      fps,
      nodeCount: rawNodes.length,
      edgeCount: edgeSources.length,
    } as OutboundStats);
  }

  updatePhysics();

  ctx.clearRect(0, 0, width, height);

  // Background style
  ctx.fillStyle = "#0A0E27";
  ctx.fillRect(0, 0, width, height);

  // 1. Draw 10,000+ edges in batched strokes for 60 FPS
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = "rgba(123, 97, 255, 0.12)";
  ctx.beginPath();

  const edgeCount = edgeSources.length;
  for (let i = 0; i < edgeCount; i++) {
    const s = edgeSources[i]!;
    const t = edgeTargets[i]!;
    ctx.moveTo(nodeX[s]!, nodeY[s]!);
    ctx.lineTo(nodeX[t]!, nodeY[t]!);
  }
  ctx.stroke();

  // If a node is hovered, draw connected edges in bright color
  if (hoveredNodeIndex !== -1) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#00CDCC";
    ctx.beginPath();
    for (let i = 0; i < edgeCount; i++) {
      const s = edgeSources[i]!;
      const t = edgeTargets[i]!;
      if (s === hoveredNodeIndex || t === hoveredNodeIndex) {
        ctx.moveTo(nodeX[s]!, nodeY[s]!);
        ctx.lineTo(nodeX[t]!, nodeY[t]!);
      }
    }
    ctx.stroke();
  }

  // 2. Draw nodes
  const count = nodeX.length;
  for (let i = 0; i < count; i++) {
    const nx = nodeX[i]!;
    const ny = nodeY[i]!;
    const r = nodeRadius![i]!;
    const typeCode = nodeTypes![i]!;
    const isHovered = i === hoveredNodeIndex;

    ctx.beginPath();
    ctx.arc(nx, ny, isHovered ? r + 4 : r, 0, Math.PI * 2);

    if (typeCode === 0) {
      ctx.fillStyle = isHovered ? "#9E8BFF" : "#7B61FF"; // Org
    } else if (typeCode === 1) {
      ctx.fillStyle = isHovered ? "#33E0DF" : "#00CDCC"; // Pool
    } else if (typeCode === 2) {
      ctx.fillStyle = isHovered ? "#FFC833" : "#FFB800"; // Donor
    } else {
      ctx.fillStyle = isHovered ? "#5BE375" : "#39D353"; // Maintainer
    }
    ctx.fill();

    // Node outer border ring
    ctx.lineWidth = isHovered ? 2.5 : 1;
    ctx.strokeStyle = isHovered ? "#FFFFFF" : "rgba(255, 255, 255, 0.3)";
    ctx.stroke();
  }
}

function loop() {
  if (!isRunning) return;
  renderFrame();

  if (typeof self.requestAnimationFrame === "function") {
    animFrameId = self.requestAnimationFrame(loop);
  } else {
    // Fallback for non-rAF worker environments
    animFrameId = (setTimeout(loop, 16) as unknown) as number;
  }
}

// ── Hover Collision Detection ──────────────────────────────────────────────

function checkHoverCollision(coords: [number, number]) {
  hoverCoords = coords;

  if (coords[0] < 0 || coords[1] < 0 || !nodeX || !nodeY || !nodeRadius) {
    if (hoveredNodeIndex !== -1) {
      hoveredNodeIndex = -1;
      self.postMessage({
        type: "HOVER_RESULT",
        node: null,
        coords: hoverCoords,
      } as OutboundHoverResult);
    }
    return;
  }

  const [mx, my] = coords;
  let foundIdx = -1;
  const count = nodeX.length;

  for (let i = 0; i < count; i++) {
    const dx = nodeX[i]! - mx;
    const dy = nodeY[i]! - my;
    const distSq = dx * dx + dy * dy;
    const hitR = nodeRadius[i]! + 6;

    if (distSq <= hitR * hitR) {
      foundIdx = i;
      break;
    }
  }

  if (foundIdx !== hoveredNodeIndex) {
    hoveredNodeIndex = foundIdx;
    const hoveredNodeData = foundIdx !== -1 ? rawNodes[foundIdx]! : null;

    self.postMessage({
      type: "HOVER_RESULT",
      node: hoveredNodeData,
      coords: hoverCoords,
    } as OutboundHoverResult);
  }
}

// ── Clean Up / Memory Release ─────────────────────────────────────────────

function cleanup() {
  isRunning = false;
  if (animFrameId !== null) {
    if (typeof self.cancelAnimationFrame === "function") {
      self.cancelAnimationFrame(animFrameId);
    } else {
      clearTimeout(animFrameId);
    }
    animFrameId = null;
  }

  canvas = null;
  ctx = null;
  nodeX = null;
  nodeY = null;
  nodeVx = null;
  nodeVy = null;
  nodeRadius = null;
  nodeTypes = null;
  edgeSources = null;
  edgeTargets = null;
  rawNodes = [];
  rawEdges = [];
  nodeMap.clear();
  hoveredNodeIndex = -1;
}

// ── Worker Message Listener ────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<InboundWorkerMessage>) => {
  const msg = event.data;

  if (!msg) return;

  switch (msg.type) {
    case "INIT": {
      cleanup();

      canvas = msg.canvas;
      width = msg.width || 800;
      height = msg.height || 600;
      dpr = msg.devicePixelRatio || 1;

      if (canvas && typeof canvas.getContext === "function") {
        ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      }

      initGraphState(msg.nodes || [], msg.edges || []);
      isRunning = true;
      loop();

      self.postMessage({ type: "INIT_ACK", success: true } as OutboundWorkerMessage);
      break;
    }

    case "RESIZE": {
      width = msg.width;
      height = msg.height;
      if (msg.devicePixelRatio) {
        dpr = msg.devicePixelRatio;
      }

      if (canvas) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        if (ctx && typeof ctx.scale === "function") {
          ctx.scale(dpr, dpr);
        }
      }
      break;
    }

    case "HOVER": {
      checkHoverCollision(msg.coords || [-1, -1]);
      break;
    }

    case "CLEANUP":
    case "DESTROY": {
      cleanup();
      break;
    }
  }
};
