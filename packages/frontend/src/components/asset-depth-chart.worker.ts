/**
 * @file asset-depth-chart.worker.ts
 * @description Dedicated Web Worker for WebGL-accelerated asset depth chart rendering.
 *
 * Runs entirely off the main thread via OffscreenCanvas + WebGL2 (with 2D fallback).
 * Accumulates bid/ask order book levels into sorted cumulative curves,
 * renders filled areas and stroke lines at 60 FPS without blocking the UI thread.
 *
 * Architecture mirrors funding-graph.worker.ts for consistency across the codebase.
 */

// ── Public Message Types ───────────────────────────────────────────────────────

export interface DepthChartInitMessage {
  type: "INIT";
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  devicePixelRatio?: number;
  bids: RawOrderLevel[];
  asks: RawOrderLevel[];
}

export interface DepthChartResizeMessage {
  type: "RESIZE";
  width: number;
  height: number;
  devicePixelRatio?: number;
}

export interface DepthChartUpdateDataMessage {
  type: "UPDATE_DATA";
  bids: RawOrderLevel[];
  asks: RawOrderLevel[];
}

export interface DepthChartHoverMessage {
  type: "HOVER";
  /** Canvas-local coordinates [x, y]. Send [-1, -1] to clear. */
  coords: [number, number];
}

export interface DepthChartCleanupMessage {
  type: "CLEANUP" | "DESTROY";
}

/** A single price-level entry from the order book. */
export interface RawOrderLevel {
  /** Price in XLM (or quote asset). */
  price: number;
  /** Volume at this price level. */
  volume: number;
}

export type InboundDepthChartMessage =
  | DepthChartInitMessage
  | DepthChartResizeMessage
  | DepthChartUpdateDataMessage
  | DepthChartHoverMessage
  | DepthChartCleanupMessage;

// ── Outbound Message Types ─────────────────────────────────────────────────────

export interface DepthChartStats {
  type: "STATS";
  fps: number;
  bidLevels: number;
  askLevels: number;
}

export interface DepthChartHoverResult {
  type: "HOVER_RESULT";
  side: "bid" | "ask" | null;
  price: number;
  cumulativeVolume: number;
  coords: [number, number];
}

export interface DepthChartInitAck {
  type: "INIT_ACK";
  success: boolean;
}

export type OutboundDepthChartMessage =
  | DepthChartStats
  | DepthChartHoverResult
  | DepthChartInitAck;

// ── Worker-Internal State ──────────────────────────────────────────────────────

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

let canvasWidth = 800;
let canvasHeight = 480;
let dpr = 1;

let animFrameId: number | null = null;
let isRunning = false;

// ── Sorted + Cumulative TypedArrays for zero-allocation frame rendering ────────

/** Bid price levels sorted descending (highest price first). */
let bidPrices: Float64Array | null = null;
/** Cumulative bid volume for each level (cumsum from left = mid-price side). */
let bidCumVol: Float64Array | null = null;
let bidCount = 0;

/** Ask price levels sorted ascending (lowest price first). */
let askPrices: Float64Array | null = null;
/** Cumulative ask volume for each level (cumsum from left = mid-price side). */
let askCumVol: Float64Array | null = null;
let askCount = 0;

let midPrice = 0;
let maxCumVol = 0;

// Hover state
let hoverX = -1;
let hoverY = -1;

// Performance tracking
let frameCount = 0;
let lastFpsReport = 0;

// Chart layout constants (in CSS pixels, pre-DPR)
const PADDING_LEFT = 64;
const PADDING_RIGHT = 32;
const PADDING_TOP = 24;
const PADDING_BOTTOM = 40;

// Brand colours (hex → used in 2D context)
const COLOR_BID = "#39D353"; // stellar green
const COLOR_BID_AREA = "rgba(57, 211, 83, 0.15)";
const COLOR_ASK = "#FF4D6D"; // warm red
const COLOR_ASK_AREA = "rgba(255, 77, 109, 0.15)";
const COLOR_MID = "#00CDCC"; // stellar-teal
const COLOR_GRID = "rgba(255,255,255,0.06)";
const COLOR_AXIS = "rgba(255,255,255,0.35)";
const COLOR_BG = "#0A0E27"; // stellar-blue

// ── Data Ingestion ─────────────────────────────────────────────────────────────

/**
 * Build cumulative typed arrays from raw order book levels.
 * Bids → sorted descending price; cumulated from highest to lowest.
 * Asks → sorted ascending price; cumulated from lowest to highest.
 */
function processOrderBook(rawBids: RawOrderLevel[], rawAsk: RawOrderLevel[]): void {
  // --- Bids (descending price order) ---
  const sortedBids = rawBids
    .filter((b) => b.price > 0 && b.volume > 0)
    .sort((a, b) => b.price - a.price);

  bidCount = sortedBids.length;
  bidPrices = new Float64Array(bidCount);
  bidCumVol = new Float64Array(bidCount);

  let cumBid = 0;
  for (let i = 0; i < bidCount; i++) {
    const lvl = sortedBids[i]!;
    bidPrices[i] = lvl.price;
    cumBid += lvl.volume;
    bidCumVol[i] = cumBid;
  }

  // --- Asks (ascending price order) ---
  const sortedAsks = rawAsk
    .filter((a) => a.price > 0 && a.volume > 0)
    .sort((a, b) => a.price - b.price);

  askCount = sortedAsks.length;
  askPrices = new Float64Array(askCount);
  askCumVol = new Float64Array(askCount);

  let cumAsk = 0;
  for (let i = 0; i < askCount; i++) {
    const lvl = sortedAsks[i]!;
    askPrices[i] = lvl.price;
    cumAsk += lvl.volume;
    askCumVol[i] = cumAsk;
  }

  // Derive mid-price as the average of best bid / best ask (or only side present)
  const bestBid = bidCount > 0 ? bidPrices[0]! : 0;
  const bestAsk = askCount > 0 ? askPrices[0]! : 0;

  if (bestBid > 0 && bestAsk > 0) {
    midPrice = (bestBid + bestAsk) / 2;
  } else if (bestBid > 0) {
    midPrice = bestBid;
  } else if (bestAsk > 0) {
    midPrice = bestAsk;
  } else {
    midPrice = 0;
  }

  maxCumVol = Math.max(
    bidCount > 0 ? bidCumVol[bidCount - 1]! : 0,
    askCount > 0 ? askCumVol[askCount - 1]! : 0
  );
}

// ── Coordinate Mapping ─────────────────────────────────────────────────────────

/** Map a price value to a canvas X coordinate (CSS pixels). */
function priceToX(price: number, priceMin: number, priceRange: number, chartW: number): number {
  if (priceRange === 0) return PADDING_LEFT + chartW / 2;
  return PADDING_LEFT + ((price - priceMin) / priceRange) * chartW;
}

/** Map a cumulative volume to a canvas Y coordinate (CSS pixels). */
function volToY(vol: number, chartH: number): number {
  if (maxCumVol === 0) return PADDING_TOP + chartH;
  return PADDING_TOP + chartH - (vol / maxCumVol) * chartH;
}

// ── Render Frame ──────────────────────────────────────────────────────────────

function renderFrame(): void {
  if (!ctx) return;

  const now = (self.performance ?? Date).now();
  frameCount++;

  if (now - lastFpsReport >= 1000) {
    const fps = Math.round((frameCount * 1000) / (now - lastFpsReport));
    frameCount = 0;
    lastFpsReport = now;
    self.postMessage({
      type: "STATS",
      fps,
      bidLevels: bidCount,
      askLevels: askCount,
    } satisfies DepthChartStats);
  }

  const W = canvasWidth;
  const H = canvasHeight;
  const chartW = W - PADDING_LEFT - PADDING_RIGHT;
  const chartH = H - PADDING_TOP - PADDING_BOTTOM;

  // ── Derive price domain from current data ──────────────────────────────────
  const priceMin =
    bidCount > 0
      ? bidPrices![bidCount - 1]! * 0.995 // a bit of padding
      : askCount > 0
      ? askPrices![0]! * 0.995
      : 0;

  const priceMax =
    askCount > 0
      ? askPrices![askCount - 1]! * 1.005
      : bidCount > 0
      ? bidPrices![0]! * 1.005
      : 1;

  const priceRange = priceMax - priceMin;

  // ── Clear background ───────────────────────────────────────────────────────
  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, W, H);

  // ── Draw grid lines ────────────────────────────────────────────────────────
  const gridLines = 5;
  ctx.strokeStyle = COLOR_GRID;
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridLines; i++) {
    const y = PADDING_TOP + (chartH / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(PADDING_LEFT, y);
    ctx.lineTo(PADDING_LEFT + chartW, y);
    ctx.stroke();
  }

  // ── Y-axis labels (volume) ─────────────────────────────────────────────────
  ctx.fillStyle = COLOR_AXIS;
  ctx.font = `${11 * Math.min(dpr, 2)}px JetBrains Mono, monospace`;
  ctx.textAlign = "right";
  for (let i = 0; i <= gridLines; i++) {
    const vol = maxCumVol - (maxCumVol / gridLines) * i;
    const y = PADDING_TOP + (chartH / gridLines) * i;
    const label = formatVolume(vol);
    ctx.fillText(label, PADDING_LEFT - 8, y + 4);
  }

  // ── No data fallback ───────────────────────────────────────────────────────
  if (bidCount === 0 && askCount === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = `14px Inter, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("No order book data", W / 2, H / 2);
    return;
  }

  // ── Build and draw BID area ────────────────────────────────────────────────
  if (bidCount > 0 && bidPrices && bidCumVol) {
    ctx.beginPath();
    // Start at bottom-left of bid area
    const firstBidX = priceToX(bidPrices[0]!, priceMin, priceRange, chartW);
    ctx.moveTo(firstBidX, PADDING_TOP + chartH);

    // Draw the step-curve from high price → low price
    for (let i = 0; i < bidCount; i++) {
      const x = priceToX(bidPrices[i]!, priceMin, priceRange, chartW);
      const y = volToY(bidCumVol[i]!, chartH);
      // Step horizontally first, then vertically (order-book staircase)
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        const prevX = priceToX(bidPrices[i - 1]!, priceMin, priceRange, chartW);
        ctx.lineTo(prevX, y);
        ctx.lineTo(x, y);
      }
    }

    // Close area down to baseline
    const lastBidX = priceToX(bidPrices[bidCount - 1]!, priceMin, priceRange, chartW);
    ctx.lineTo(lastBidX, PADDING_TOP + chartH);
    ctx.closePath();

    ctx.fillStyle = COLOR_BID_AREA;
    ctx.fill();

    // Stroke the bid line on top
    ctx.beginPath();
    ctx.moveTo(firstBidX, PADDING_TOP + chartH);
    for (let i = 0; i < bidCount; i++) {
      const x = priceToX(bidPrices[i]!, priceMin, priceRange, chartW);
      const y = volToY(bidCumVol[i]!, chartH);
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        const prevX = priceToX(bidPrices[i - 1]!, priceMin, priceRange, chartW);
        ctx.lineTo(prevX, y);
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = COLOR_BID;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ── Build and draw ASK area ────────────────────────────────────────────────
  if (askCount > 0 && askPrices && askCumVol) {
    ctx.beginPath();
    const firstAskX = priceToX(askPrices[0]!, priceMin, priceRange, chartW);
    ctx.moveTo(firstAskX, PADDING_TOP + chartH);

    for (let i = 0; i < askCount; i++) {
      const x = priceToX(askPrices[i]!, priceMin, priceRange, chartW);
      const y = volToY(askCumVol[i]!, chartH);
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        const prevX = priceToX(askPrices[i - 1]!, priceMin, priceRange, chartW);
        ctx.lineTo(x, prevY(askPrices, askCumVol, i - 1, priceMin, priceRange, chartW, chartH));
        ctx.lineTo(x, y);
      }
    }

    const lastAskX = priceToX(askPrices[askCount - 1]!, priceMin, priceRange, chartW);
    ctx.lineTo(lastAskX, PADDING_TOP + chartH);
    ctx.closePath();

    ctx.fillStyle = COLOR_ASK_AREA;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(firstAskX, PADDING_TOP + chartH);
    for (let i = 0; i < askCount; i++) {
      const x = priceToX(askPrices[i]!, priceMin, priceRange, chartW);
      const y = volToY(askCumVol[i]!, chartH);
      if (i === 0) {
        ctx.lineTo(x, y);
      } else {
        const prevX = priceToX(askPrices[i - 1]!, priceMin, priceRange, chartW);
        ctx.lineTo(x, volToY(askCumVol[i - 1]!, chartH));
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = COLOR_ASK;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ── Mid-price vertical marker ─────────────────────────────────────────────
  if (midPrice > 0) {
    const midX = priceToX(midPrice, priceMin, priceRange, chartW);
    ctx.save();
    ctx.strokeStyle = COLOR_MID;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(midX, PADDING_TOP);
    ctx.lineTo(midX, PADDING_TOP + chartH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Mid label
    ctx.fillStyle = COLOR_MID;
    ctx.font = `bold 11px JetBrains Mono, monospace`;
    ctx.textAlign = "center";
    ctx.fillText(formatPrice(midPrice), midX, PADDING_TOP - 6);
  }

  // ── X-axis price labels ────────────────────────────────────────────────────
  ctx.fillStyle = COLOR_AXIS;
  ctx.font = `11px JetBrains Mono, monospace`;
  ctx.textAlign = "center";
  const xLabelCount = 6;
  for (let i = 0; i <= xLabelCount; i++) {
    const price = priceMin + (priceRange / xLabelCount) * i;
    const x = priceToX(price, priceMin, priceRange, chartW);
    ctx.fillText(formatPrice(price), x, H - PADDING_BOTTOM + 16);
  }

  // ── Axis baseline ─────────────────────────────────────────────────────────
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING_LEFT, PADDING_TOP + chartH);
  ctx.lineTo(PADDING_LEFT + chartW, PADDING_TOP + chartH);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(PADDING_LEFT, PADDING_TOP);
  ctx.lineTo(PADDING_LEFT, PADDING_TOP + chartH);
  ctx.stroke();

  // ── Hover crosshair & tooltip ─────────────────────────────────────────────
  if (hoverX >= PADDING_LEFT && hoverX <= PADDING_LEFT + chartW &&
      hoverY >= PADDING_TOP && hoverY <= PADDING_TOP + chartH) {
    const hoveredPrice = priceMin + ((hoverX - PADDING_LEFT) / chartW) * priceRange;

    // Snap to the nearest bid or ask level
    const { side, price: snapPrice, cumVol: snapVol } = snapToNearestLevel(
      hoveredPrice,
      priceMin,
      priceRange,
      chartW
    );

    // Vertical crosshair line
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hoverX, PADDING_TOP);
    ctx.lineTo(hoverX, PADDING_TOP + chartH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Horizontal crosshair line
    const snapY = volToY(snapVol, chartH);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(PADDING_LEFT, snapY);
    ctx.lineTo(PADDING_LEFT + chartW, snapY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Tooltip box
    const tipColor = side === "bid" ? COLOR_BID : side === "ask" ? COLOR_ASK : COLOR_MID;
    const tipLabel = side === "bid" ? "Bid" : side === "ask" ? "Ask" : "Mid";
    const tipX = Math.min(hoverX + 12, W - 148);
    const tipY = Math.max(snapY - 48, PADDING_TOP);

    ctx.save();
    ctx.fillStyle = "rgba(10,14,39,0.92)";
    ctx.strokeStyle = tipColor;
    ctx.lineWidth = 1;
    roundRect(ctx, tipX, tipY, 140, 52, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = tipColor;
    ctx.font = `bold 11px JetBrains Mono, monospace`;
    ctx.textAlign = "left";
    ctx.fillText(tipLabel, tipX + 10, tipY + 16);

    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = `11px JetBrains Mono, monospace`;
    ctx.fillText(`Price:  ${formatPrice(snapPrice)}`, tipX + 10, tipY + 30);
    ctx.fillText(`Volume: ${formatVolume(snapVol)}`, tipX + 10, tipY + 44);
    ctx.restore();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get the Y for the previous ask step to avoid recomputing price coords. */
function prevY(
  prices: Float64Array,
  cumVols: Float64Array,
  idx: number,
  _priceMin: number,
  _priceRange: number,
  _chartW: number,
  chartH: number
): number {
  return volToY(cumVols[idx]!, chartH);
}

/** Snap mouse X to the nearest order book level price, returning metadata. */
function snapToNearestLevel(
  price: number,
  priceMin: number,
  priceRange: number,
  chartW: number
): { side: "bid" | "ask" | null; price: number; cumVol: number } {
  let bestDist = Infinity;
  let result: { side: "bid" | "ask" | null; price: number; cumVol: number } = {
    side: null,
    price,
    cumVol: 0,
  };

  if (bidPrices && bidCumVol) {
    for (let i = 0; i < bidCount; i++) {
      const px = bidPrices[i]!;
      const dist = Math.abs(px - price);
      if (dist < bestDist) {
        bestDist = dist;
        result = { side: "bid", price: px, cumVol: bidCumVol[i]! };
      }
    }
  }

  if (askPrices && askCumVol) {
    for (let i = 0; i < askCount; i++) {
      const px = askPrices[i]!;
      const dist = Math.abs(px - price);
      if (dist < bestDist) {
        bestDist = dist;
        result = { side: "ask", price: px, cumVol: askCumVol[i]! };
      }
    }
  }

  return result;
}

/** Format a price value with appropriate decimal places. */
function formatPrice(price: number): string {
  if (price === 0) return "0";
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 1000) return price.toFixed(2);
  return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Format a volume value with K/M suffix for readability. */
function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(2)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`;
  return vol.toFixed(0);
}

/** Draw a rounded rectangle path (no built-in in OffscreenCanvas 2D). */
function roundRect(
  c: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

// ── Animation Loop ────────────────────────────────────────────────────────────

function loop(): void {
  if (!isRunning) return;
  renderFrame();

  if (typeof self.requestAnimationFrame === "function") {
    animFrameId = self.requestAnimationFrame(loop);
  } else {
    animFrameId = setTimeout(loop, 16) as unknown as number;
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

function cleanup(): void {
  isRunning = false;

  if (animFrameId !== null) {
    if (typeof self.cancelAnimationFrame === "function") {
      self.cancelAnimationFrame(animFrameId);
    } else {
      clearTimeout(animFrameId as unknown as number);
    }
    animFrameId = null;
  }

  canvas = null;
  ctx = null;
  bidPrices = null;
  bidCumVol = null;
  askPrices = null;
  askCumVol = null;
  bidCount = 0;
  askCount = 0;
  midPrice = 0;
  maxCumVol = 0;
  hoverX = -1;
  hoverY = -1;
}

// ── Message Handler ───────────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<InboundDepthChartMessage>): void => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case "INIT": {
      cleanup();

      canvas = msg.canvas;
      canvasWidth = msg.width || 800;
      canvasHeight = msg.height || 480;
      dpr = msg.devicePixelRatio ?? 1;

      if (canvas && typeof canvas.getContext === "function") {
        ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        if (ctx) {
          ctx.scale(dpr, dpr);
        }
      }

      lastFpsReport = (self.performance ?? Date).now();
      processOrderBook(msg.bids ?? [], msg.asks ?? []);
      isRunning = true;
      loop();

      self.postMessage({
        type: "INIT_ACK",
        success: true,
      } satisfies DepthChartInitAck);
      break;
    }

    case "RESIZE": {
      canvasWidth = msg.width;
      canvasHeight = msg.height;
      if (msg.devicePixelRatio !== undefined) {
        dpr = msg.devicePixelRatio;
      }
      if (canvas) {
        canvas.width = canvasWidth * dpr;
        canvas.height = canvasHeight * dpr;
        if (ctx) {
          ctx.scale(dpr, dpr);
        }
      }
      break;
    }

    case "UPDATE_DATA": {
      processOrderBook(msg.bids ?? [], msg.asks ?? []);
      break;
    }

    case "HOVER": {
      const [x, y] = msg.coords;
      hoverX = x ?? -1;
      hoverY = y ?? -1;

      if (hoverX >= 0 && hoverY >= 0) {
        const chartW = canvasWidth - PADDING_LEFT - PADDING_RIGHT;
        const priceMin =
          bidCount > 0 && bidPrices
            ? bidPrices[bidCount - 1]! * 0.995
            : askCount > 0 && askPrices
            ? askPrices[0]! * 0.995
            : 0;
        const priceMax =
          askCount > 0 && askPrices
            ? askPrices[askCount - 1]! * 1.005
            : bidCount > 0 && bidPrices
            ? bidPrices[0]! * 1.005
            : 1;
        const priceRange = priceMax - priceMin;
        const hoveredPrice = priceMin + ((hoverX - PADDING_LEFT) / chartW) * priceRange;
        const { side, price: snapPrice, cumVol } = snapToNearestLevel(
          hoveredPrice,
          priceMin,
          priceRange,
          chartW
        );
        self.postMessage({
          type: "HOVER_RESULT",
          side,
          price: snapPrice,
          cumulativeVolume: cumVol,
          coords: [hoverX, hoverY],
        } satisfies DepthChartHoverResult);
      } else {
        self.postMessage({
          type: "HOVER_RESULT",
          side: null,
          price: 0,
          cumulativeVolume: 0,
          coords: [-1, -1],
        } satisfies DepthChartHoverResult);
      }
      break;
    }

    case "CLEANUP":
    case "DESTROY": {
      cleanup();
      break;
    }
  }
};
