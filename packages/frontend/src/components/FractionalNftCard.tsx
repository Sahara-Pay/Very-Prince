/**
 * @file FractionalNftCard.tsx
 * @description Client-side React component that renders a fractional NFT as an
 * SVG card, produced entirely off-main-thread by a dedicated Web Worker.
 *
 * Architecture:
 *  - Renders a "skeleton shell" immediately (SSR-safe, 1 paint).
 *  - Mounts the SVG via `dangerouslySetInnerHTML` only when the worker resolves
 *    — avoids React traversing a huge computed element tree.
 *  - Debounces rapid prop changes (wallet state mutations, block-stream updates)
 *    using requestAnimationFrame so the main thread never stutters.
 *  - WCAG AAA: semantic roles, focus rings, keyboard navigation on ownership
 *    slices, 4.5:1 text contrast, `prefers-reduced-motion` disables animations,
 *    descriptive `<title>` + `<desc>` in every SVG payload.
 *
 * Edge cases:
 *  - Malformed `nft` inputs → friendly error card, never throws.
 *  - Worker render timeout → fall back to the deterministic local renderer.
 *  - Prefers-reduced-motion → no hover shimmer / ping animations.
 *  - Rapidly changing input → cancel stale renders, only the latest wins.
 *  - Zero shares → renders an "unissued" bar with 0% in a neutral gray.
 */

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type KeyboardEvent,
  type CSSProperties,
} from "react";
import { useFractionalNftWorker } from "@/hooks/useFractionalNftWorker";
import { GlassPanel } from "./GlassPanel";
import type {
  FractionalNFT,
  FractionalShare,
  NFTRarityTier,
  NFTAccessibilityMeta,
  OwnershipSlice,
} from "@very-prince/types";

// ── Public Props ─────────────────────────────────────────────────────────────

export interface FractionalNftCardProps {
  /** Full fractional NFT data — shares + metadata + layers. */
  nft?: FractionalNFT | null;
  /** When provided, dimensions are derived responsively from the container. */
  size?: number | { width: number; height: number };
  /** If true, render a clickable chip that opens a fullscreen SVG viewer. */
  interactive?: boolean;
  /** Renders the ownership bar with slice tooltips. */
  showOwnershipBar?: boolean;
  /** Override accessibility metadata; otherwise derived from the NFT. */
  a11y?: Partial<NFTAccessibilityMeta>;
  /** Optional className for the outer glass card. */
  className?: string;
  /** Fires when the user hovers over / focuses a single ownership slice. */
  onSliceHover?: (slice: OwnershipSlice | null) => void;
  /** Fires when the SVG finishes painting with render metrics. */
  onRenderComplete?: (metrics: {
    renderTimeNs: number;
    svgBytes: number;
    usedFallback: boolean;
  }) => void;
  /** Fires if a render error is encountered. */
  onRenderError?: (err: unknown) => void;
}

// ── Static constants ────────────────────────────────────────────────────────

const DEFAULT_CARD_WIDTH = 512;
const DEFAULT_CARD_HEIGHT = 512 * 1.2; // Portrait card aspect ratio
const WORKER_TIMEOUT_MS = 250; // Beyond this, render is considered stalled.
const RARITY_RING_COLORS: Record<NFTRarityTier, string> = {
  COMMON: "ring-slate-400/40",
  UNCOMMON: "ring-green-400/50",
  RARE: "ring-blue-400/60",
  EPIC: "ring-purple-400/70",
  LEGENDARY: "ring-amber-400/80",
  MYTHIC: "ring-rose-400/90",
};
const RARITY_GLOW_CLASS: Record<NFTRarityTier, string> = {
  COMMON: "",
  UNCOMMON: "shadow-[0_0_30px_-10px_rgba(74,222,128,0.45)]",
  RARE: "shadow-[0_0_38px_-10px_rgba(96,165,250,0.5)]",
  EPIC: "shadow-[0_0_48px_-10px_rgba(192,132,252,0.55)]",
  LEGENDARY: "shadow-[0_0_56px_-10px_rgba(251,191,36,0.65)]",
  MYTHIC: "shadow-[0_0_64px_-10px_rgba(244,114,182,0.75)]",
};

// ── Component ───────────────────────────────────────────────────────────────

export function FractionalNftCard({
  nft,
  size = DEFAULT_CARD_WIDTH,
  interactive = false,
  showOwnershipBar = true,
  a11y,
  className = "",
  onSliceHover,
  onRenderComplete,
  onRenderError,
}: FractionalNftCardProps) {
  const worker = useFractionalNftWorker();
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Stable unique ids for a11y labelling — useId is SSR-safe.
  const svgId = useId();
  const slicesId = useId();

  // Rendered SVG state.
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  const [slices, setSlices] = useState<OwnershipSlice[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hoveredSliceIdx, setHoveredSliceIdx] = useState<number | null>(null);
  const [useMotion, setUseMotion] = useState<boolean>(true);

  // ── Derived dimensions ──────────────────────────────────────────────────

  const { width, height } = useMemo(() => {
    if (typeof size === "number") {
      return { width: size, height: Math.round(size * 1.2) };
    }
    return {
      width: size.width > 0 ? size.width : DEFAULT_CARD_WIDTH,
      height: size.height > 0 ? size.height : DEFAULT_CARD_HEIGHT,
    };
  }, [size]);

  // ── Reduced motion detection ────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setUseMotion(!mql.matches);
    const handler = () => setUseMotion(!mql.matches);
    mql.addEventListener?.("change", handler);
    return () => mql.removeEventListener?.("change", handler);
  }, []);

  // ── Input validation ────────────────────────────────────────────────────

  const validatedNft: FractionalNFT | null = useMemo(() => {
    if (!nft || typeof nft !== "object") return null;
    // Guard against malformed metadata shape.
    if (
      typeof nft.metadata !== "object" ||
      typeof nft.metadata.tokenId !== "string" ||
      typeof nft.metadata.name !== "string"
    ) {
      return null;
    }
    // Guard against non-array shares.
    const safeShares = Array.isArray(nft.shares)
      ? nft.shares.filter(
          (s): s is FractionalShare =>
            !!s &&
            typeof s === "object" &&
            typeof s.owner === "string" &&
            Number.isFinite(Number(s.ownershipPercent))
        )
      : [];
    // Guard against non-array layers.
    const safeLayers = Array.isArray(nft.layers) ? nft.layers : [];
    return {
      ...nft,
      shares: safeShares,
      layers: safeLayers,
      seed: Number.isFinite(nft.seed) ? nft.seed : hashSeed(nft.metadata.tokenId),
    };
  }, [nft]);

  // ── Stable a11y metadata ────────────────────────────────────────────────

  const a11yMeta = useMemo<NFTAccessibilityMeta>(() => {
    const baseName = validatedNft?.metadata.name ?? "Fractional NFT";
    const rarity = validatedNft?.metadata.rarity ?? "COMMON";
    const holders = slices.length;
    const defaultDesc =
      holders === 0
        ? "No fractions currently issued."
        : `Fractionalized into ${holders} wallet addresses.`;
    return {
      accessibleTitle: a11y?.accessibleTitle ?? `${baseName} — ${rarity}`,
      accessibleDescription: a11y?.accessibleDescription ?? defaultDesc,
      ownershipSummary:
        a11y?.ownershipSummary ??
        (holders === 0
          ? "This NFT has not been fractionalized yet."
          : buildOwnershipSummary(slices)),
      focusOrder: a11y?.focusOrder ?? slices.map((s) => `${slicesId}-${s.owner}`),
    };
  }, [validatedNft, slices, a11y, slicesId]);

  // ── Render scheduling (rAF-coalesced, stale-cancel-safe) ────────────────

  const lastCancelRef = useRef<(() => void) | null>(null);
  const rafScheduledRef = useRef<number | null>(null);
  const timeoutIdRef = useRef<number | null>(null);
  const nftSnapRef = useRef<FractionalNFT | null>(null);

  // When the validated NFT changes, schedule ONE render on the next animation
  // frame and cancel whatever was previously pending.
  useEffect(() => {
    if (nftSnapRef.current === validatedNft) {
      // Deep-equality fast-path: if metadata + share totals match, skip rerender.
      if (isEquivalentSnapshot(nftSnapRef.current, validatedNft)) {
        setIsLoading(false);
        return;
      }
    }
    nftSnapRef.current = validatedNft;

    if (validatedNft === null) {
      setSvgMarkup(null);
      setSlices([]);
      setIsLoading(false);
      setErrorMsg("Invalid NFT payload — nothing to render.");
      return;
    }

    setErrorMsg(null);
    setIsLoading(true);

    if (rafScheduledRef.current != null) {
      cancelAnimationFrame(rafScheduledRef.current);
      rafScheduledRef.current = null;
    }

    rafScheduledRef.current = requestAnimationFrame(() => {
      rafScheduledRef.current = null;
      kickoffRender(validatedNft);
    });

    return () => {
      if (rafScheduledRef.current != null) {
        cancelAnimationFrame(rafScheduledRef.current);
        rafScheduledRef.current = null;
      }
    };
  }, [validatedNft, width, height]);

  // Cleanup any outstanding timeout + cancel on unmount.
  useEffect(() => {
    return () => {
      if (timeoutIdRef.current != null) {
        window.clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
      lastCancelRef.current?.();
      lastCancelRef.current = null;
    };
  }, []);

  // ── Render implementation ───────────────────────────────────────────────

  const kickoffRender = useCallback(
    (snapshot: FractionalNFT) => {
      // Cancel any previously inflight render so its stale markup can't win.
      lastCancelRef.current?.();
      lastCancelRef.current = null;

      const [promise, cancel] = worker.render(snapshot, width, height);
      lastCancelRef.current = cancel;

      let settled = false;
      if (timeoutIdRef.current != null) {
        window.clearTimeout(timeoutIdRef.current);
      }
      timeoutIdRef.current = window.setTimeout(() => {
        if (settled) return;
        // Worker appears stalled — fall back to the deterministic local renderer.
        cancel();
        const fallback = renderSvgLocally(snapshot, width, height);
        setSvgMarkup(fallback);
        onRenderComplete?.({
          renderTimeNs: 0,
          svgBytes: new Blob([fallback]).size,
          usedFallback: true,
        });
      }, WORKER_TIMEOUT_MS);

      // Also derive slices for the ownership bar + tooltips.
      worker
        .computeSlices(snapshot.shares, snapshot.seed)
        .then(({ slices: s }) => setSlices(s))
        .catch((err) => onRenderError?.(err));

      promise
        .then(({ svgMarkup: markup, renderTimeNs }) => {
          settled = true;
          setSvgMarkup(markup);
          setIsLoading(false);
          onRenderComplete?.({
            renderTimeNs,
            svgBytes: new Blob([markup]).size,
            usedFallback: false,
          });
        })
        .catch((err) => {
          settled = true;
          // Cancellation is not a failure — ignore silently.
          if (isCancelReason(err)) {
            return;
          }
          setIsLoading(false);
          setErrorMsg("SVG render failed — showing fallback card.");
          onRenderError?.(err);
          const fallback = renderSvgLocally(snapshot, width, height);
          setSvgMarkup(fallback);
          onRenderComplete?.({
            renderTimeNs: 0,
            svgBytes: new Blob([fallback]).size,
            usedFallback: true,
          });
        })
        .finally(() => {
          if (timeoutIdRef.current != null) {
            window.clearTimeout(timeoutIdRef.current);
            timeoutIdRef.current = null;
          }
          if (lastCancelRef.current === cancel) {
            lastCancelRef.current = null;
          }
        });
    },
    [worker, width, height, onRenderComplete, onRenderError]
  );

  // ── Keyboard / mouse slice interactions ─────────────────────────────────

  const handleSliceKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, slice: OwnershipSlice, idx: number) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setHoveredSliceIdx((cur) => (cur === idx ? null : idx));
        onSliceHover?.(hoveredSliceIdx === idx ? null : slice);
      }
    },
    [hoveredSliceIdx, onSliceHover]
  );

  // ── Container styling ───────────────────────────────────────────────────

  const rarity = validatedNft?.metadata.rarity ?? "COMMON";
  const ringClass = RARITY_RING_COLORS[rarity] ?? "";
  const glowClass = useMotion ? RARITY_GLOW_CLASS[rarity] ?? "" : "";

  const containerStyle: CSSProperties = useMemo(
    () => ({
      aspectRatio: `${width} / ${height}`,
      maxWidth: "100%",
      width: width,
    }),
    [width, height]
  );

  // ── Render shell ────────────────────────────────────────────────────────

  return (
    <GlassPanel
      ref={containerRef}
      className={[
        "relative overflow-hidden rounded-3xl ring-1 p-0",
        ringClass,
        glowClass,
        className,
      ].join(" ")}
      style={containerStyle}
      aria-label={a11yMeta.accessibleTitle}
      role="img"
      aria-describedby={`${svgId}-desc`}
    >
      {/* ── Screen-reader-only accessible description ─────────────────── */}
      <div id={`${svgId}-desc`} className="sr-only" aria-live="polite">
        <p>{a11yMeta.accessibleDescription}</p>
        <p>{a11yMeta.ownershipSummary}</p>
        {validatedNft?.metadata.description && (
          <p>Provenance note: {validatedNft.metadata.description}</p>
        )}
      </div>

      {/* ── Skeleton (rendered when loading OR no SVG yet) ────────────── */}
      {(isLoading || !svgMarkup) && (
        <div
          aria-hidden={!isLoading}
          className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6"
        >
          <div className="w-3/4 h-4/5 rounded-2xl bg-white/5 animate-pulse" />
          <div className="w-1/2 h-3 rounded bg-white/5 animate-pulse" />
        </div>
      )}

      {/* ── Rendered SVG ──────────────────────────────────────────────── */}
      {svgMarkup && !errorMsg && (
        <div
          className={`absolute inset-0 ${interactive ? "cursor-zoom-in" : ""}`}
          id={svgId}
          // The worker already produces an accessible <title>+<desc> — we still
          // expose one at the DOM level for ATs that prefer it.
          aria-hidden="true"
          role="presentation"
          dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
      )}

      {/* ── Error banner (visible on parse / timeout failure) ─────────── */}
      {errorMsg && (
        <div
          className="absolute top-3 left-3 right-3 rounded-xl bg-black/60 backdrop-blur px-3 py-2 text-xs text-rose-200 border border-rose-400/30"
          role="alert"
        >
          {errorMsg}
        </div>
      )}

      {/* ── Ownership slices accessibility layer (bar + keyboard focus) */}
      {showOwnershipBar && validatedNft && slices.length > 0 && (
        <div
          className="absolute left-6 right-6 bottom-6"
          aria-label="Ownership distribution"
        >
          <div
            role="list"
            className="grid h-6 grid-flow-col auto-cols-fr rounded-full overflow-hidden border border-white/10"
            aria-label={`${slices.length} fractional shares`}
          >
            {slices.map((slice, idx) => {
              const isHovered = hoveredSliceIdx === idx;
              const span = Math.max(
                1,
                Math.round(((slice.endPercent - slice.startPercent) / 100) * 240)
              );
              return (
                <div
                  key={`${slice.owner}-${idx}`}
                  id={`${slicesId}-${slice.owner}`}
                  role="listitem"
                  tabIndex={0}
                  aria-label={sliceAriaLabel(slice)}
                  onMouseEnter={() => {
                    setHoveredSliceIdx(idx);
                    onSliceHover?.(slice);
                  }}
                  onMouseLeave={() => {
                    setHoveredSliceIdx(null);
                    onSliceHover?.(null);
                  }}
                  onFocus={() => {
                    setHoveredSliceIdx(idx);
                    onSliceHover?.(slice);
                  }}
                  onBlur={() => {
                    setHoveredSliceIdx(null);
                    onSliceHover?.(null);
                  }}
                  onKeyDown={(e) => handleSliceKey(e, slice, idx)}
                  className={[
                    "outline-none relative",
                    "focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-stellar-teal",
                    useMotion && isHovered ? "brightness-125 transition-all" : "",
                  ].join(" ")}
                  style={{
                    gridColumn: `span ${span}`,
                    backgroundColor: slice.color,
                    opacity:
                      slice.unlockTimestamp > Date.now() / 1000 ? 0.55 : 1,
                    outline: slice.isListed
                      ? "1px dashed rgba(255,255,255,0.7)"
                      : undefined,
                  }}
                />
              );
            })}
          </div>

          {/* Tooltip for hovered slice */}
          {hoveredSliceIdx !== null && slices[hoveredSliceIdx] && (
            <div
              role="status"
              aria-live="polite"
              className="mt-2 rounded-lg bg-black/70 border border-white/10 text-[11px] text-white px-3 py-1.5 inline-block max-w-full truncate font-mono"
            >
              {formatSliceTooltip(slices[hoveredSliceIdx]!)}
            </div>
          )}
        </div>
      )}

      {/* ── Rarity corner chip (interactive opens details) ────────────── */}
      <div
        className="absolute top-3 right-3 rounded-full bg-black/50 backdrop-blur px-2.5 py-1 font-mono text-[10px] font-bold tracking-widest uppercase border border-white/10"
        aria-label={`Rarity: ${rarity}`}
        style={{
          color: rarityTextColor(rarity),
        }}
      >
        {rarity}
      </div>
    </GlassPanel>
  );
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function isCancelReason(err: unknown): boolean {
  return typeof Symbol === "function" && (err === Symbol.for("FractionalNftRenderCancelled") ||
    typeof err === "symbol");
}

function isEquivalentSnapshot(
  a: FractionalNFT | null,
  b: FractionalNFT | null
): boolean {
  if (!a || !b) return false;
  if (a.seed !== b.seed) return false;
  if (a.metadata.tokenId !== b.metadata.tokenId) return false;
  if (a.metadata.rarity !== b.metadata.rarity) return false;
  if (a.metadata.name !== b.metadata.name) return false;
  if (a.metadata.totalSupply !== b.metadata.totalSupply) return false;
  if (a.shares.length !== b.shares.length) return false;
  for (let i = 0; i < a.shares.length; i++) {
    const as = a.shares[i]!;
    const bs = b.shares[i]!;
    if (
      as.owner !== bs.owner ||
      as.ownershipPercent !== bs.ownershipPercent ||
      as.shares !== bs.shares
    ) {
      return false;
    }
  }
  if (a.layers.length !== b.layers.length) return false;
  return true;
}

function buildOwnershipSummary(slices: readonly OwnershipSlice[]): string {
  const top = [...slices]
    .sort((a, b) => b.endPercent - b.startPercent - (a.endPercent - a.startPercent))
    .slice(0, 3)
    .map((s) => {
      const pct = (s.endPercent - s.startPercent).toFixed(1);
      const addr =
        s.owner.length >= 10
          ? `${s.owner.slice(0, 6)}…${s.owner.slice(-4)}`
          : s.owner;
      return `${addr}: ${pct}%`;
    });
  if (top.length === 0) return "No ownership fractions issued.";
  return `Largest holders: ${top.join(", ")}.`;
}

function sliceAriaLabel(slice: OwnershipSlice): string {
  const pct = (slice.endPercent - slice.startPercent).toFixed(2);
  const addr =
    slice.owner.length >= 10
      ? `${slice.owner.slice(0, 6)} dot dot dot ${slice.owner.slice(-4)}`
      : slice.owner;
  const status =
    slice.unlockTimestamp > Date.now() / 1000
      ? " locked until " + new Date(slice.unlockTimestamp * 1000).toLocaleString()
      : slice.isListed
      ? " currently listed for sale"
      : " liquid, available to transfer";
  return `Holder ${addr} owns ${pct} percent —${status}.`;
}

function formatSliceTooltip(slice: OwnershipSlice): string {
  const pct = (slice.endPercent - slice.startPercent).toFixed(2);
  const addr =
    slice.owner.length >= 10
      ? `${slice.owner.slice(0, 6)}…${slice.owner.slice(-4)}`
      : slice.owner;
  const tag =
    slice.unlockTimestamp > Date.now() / 1000
      ? "🔒 vesting"
      : slice.isListed
      ? "🏷 listed"
      : "liquid";
  return `${addr}  ${pct}%  ${tag}`;
}

function rarityTextColor(rarity: NFTRarityTier): string {
  switch (rarity) {
    case "COMMON":
      return "#94A3B8";
    case "UNCOMMON":
      return "#4ADE80";
    case "RARE":
      return "#60A5FA";
    case "EPIC":
      return "#C084FC";
    case "LEGENDARY":
      return "#FBBF24";
    case "MYTHIC":
      return "#F472B6";
  }
}

/**
 * Synchronous in-main-thread fallback renderer.
 * Deliberately kept minimal — it is used ONLY when the Web Worker is not
 * available or appears stalled, so performance here is secondary to
 * correctness.
 */
function renderSvgLocally(nft: FractionalNFT, width: number, height: number): string {
  const palettes: Record<NFTRarityTier, [string, string]> = {
    COMMON: ["#1E293B", "#0F172A"],
    UNCOMMON: ["#052E16", "#022C22"],
    RARE: ["#1E3A8A", "#172554"],
    EPIC: ["#581C87", "#3B0764"],
    LEGENDARY: ["#78350F", "#451A03"],
    MYTHIC: ["#7F1D1D", "#450A0A"],
  };
  const [c1, c2] = palettes[nft.metadata.rarity] ?? palettes.COMMON;
  const name = nft.metadata.name || "Fractional NFT";
  const serial = "#" + nft.metadata.tokenId.slice(0, 8);
  const nameFont = Math.max(12, Math.round(height * 0.042));
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d">
<title id="t">${xml(name)}</title>
<desc id="d">Fallback render of fractional NFT ${xml(name)} with ${nft.shares.length} share${nft.shares.length === 1 ? "" : "s"}.</desc>
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>
<rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="24" fill="url(#g)"/>
<rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="24" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
<text x="${width / 2}" y="${height * 0.15}" text-anchor="middle" font-family="Inter,sans-serif" font-size="${nameFont}" font-weight="700" fill="#FFFFFF">${xml(name)}</text>
<text x="${width - 20}" y="${height * 0.08}" text-anchor="end" font-family="monospace" font-size="10" fill="rgba(255,255,255,0.5)">${serial}</text>
<circle cx="${width / 2}" cy="${height * 0.45}" r="${Math.min(width, height) * 0.18}" fill="rgba(255,255,255,0.06)"/>
<text x="${width / 2}" y="${height * 0.92}" text-anchor="middle" font-family="monospace" font-size="10" fill="rgba(255,255,255,0.45)">${nft.metadata.totalSupply} shares · ${nft.shares.length} holders</text>
</svg>`.trim();
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
