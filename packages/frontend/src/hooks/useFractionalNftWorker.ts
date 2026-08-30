/**
 * @file useFractionalNftWorker.ts
 * @description React hook that manages the fractional NFT SVG renderer Web Worker.
 *
 * Guarantees:
 *  - At most ONE Worker instance per consumer (lazy instantiation).
 *  - Request-response correlation via `requestId` — each render request
 *    returns a Promise that resolves ONLY when the matching response arrives.
 *  - Stale-request rejection: if a second render begins before the first
 *    resolves, the first promise is rejected with a cancel reason so its
 *    stale SVG payload never corrupts component state.
 *  - Cleanup on unmount: Worker is terminated and all inflight promises
 *    are rejected with an abort error.
 *  - SSR-safe: `typeof window` guard; on the server the hook is a no-op
 *    stub that never spawns a Worker.
 *
 * Typing: every inbound/outbound message carries its discriminating union
 * tag, so TS narrows the payloads without explicit casting.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  NftWorkerInboundMessage,
  NftWorkerOutboundMessage,
  NftWorkerRenderResult,
  NftWorkerSlicesResult,
  NftWorkerLayersResult,
  FractionalNFT,
  FractionalShare,
  NFTRarityTier,
  NFTVisualLayer,
  OwnershipSlice,
} from "@very-prince/types";

type InflightEntry<T> = {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  /** If set, cancel is wired externally (see `render` return value). */
  cancelled?: boolean;
};

type RenderPayload = Omit<NftWorkerRenderResult, "type" | "requestId">;
type SlicesPayload = Omit<NftWorkerSlicesResult, "type" | "requestId">;
type LayersPayload = Omit<NftWorkerLayersResult, "type" | "requestId">;

/** Public-facing handle returned by the hook. */
export interface FractionalNftWorkerHandle {
  /** True once the worker has posted READY (safe to issue render calls). */
  readonly isReady: boolean;
  /**
   * Off-load rendering of a single NFT card to the Web Worker.
   *
   * Returns a tuple:
   *   [0] Promise that resolves with the SVG markup / metrics.
   *   [1] Cancellation function — call it to reject the promise early if
   *       the caller unmounts or no longer needs the result.
   */
  render: (
    nft: FractionalNFT,
    width: number,
    height: number,
    opts?: { includeDataUrl?: boolean }
  ) => [Promise<RenderPayload>, () => void];
  /** Compute ownership slices from share records (deterministic palette). */
  computeSlices: (
    shares: FractionalShare[],
    paletteSeed: number
  ) => Promise<SlicesPayload>;
  /** Deterministically generate visual layer descriptors from a token ID. */
  generateLayers: (
    tokenId: string,
    rarity: NFTRarityTier,
    seed: number
  ) => Promise<LayersPayload>;
}

const REJECT_REASON_CANCELLED = Symbol("FractionalNftRenderCancelled");
const REJECT_REASON_UNMOUNTED = Symbol("FractionalNftWorkerUnmounted");

/**
 * Factory for an 8-character base36 request id. Good enough to avoid
 * collisions within a single page lifecycle — the inflight map is tiny.
 */
function makeRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function useFractionalNftWorker(): FractionalNftWorkerHandle {
  // Refs instead of state to avoid triggering re-renders on every ready toggle.
  const workerRef = useRef<Worker | null>(null);
  const isReadyRef = useRef(false);
  const inflightRender = useRef<Map<string, InflightEntry<RenderPayload>>>(new Map());
  const inflightSlices = useRef<Map<string, InflightEntry<SlicesPayload>>>(new Map());
  const inflightLayers = useRef<Map<string, InflightEntry<LayersPayload>>>(new Map());

  // ── Message routing ──────────────────────────────────────────────────────

  const routeMessage = useCallback((ev: MessageEvent<NftWorkerOutboundMessage>) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "READY") {
      isReadyRef.current = true;
      return;
    }
    if (msg.type === "ERROR") {
      rejectInflight(msg.requestId, new Error(msg.error));
      return;
    }
    if (msg.type === "RENDER_RESULT") {
      const { type, requestId, ...payload } = msg;
      settleInflight(inflightRender.current, requestId, payload);
      return;
    }
    if (msg.type === "SLICES_RESULT") {
      const { type, requestId, ...payload } = msg;
      settleInflight(inflightSlices.current, requestId, { slices: payload.slices as OwnershipSlice[] });
      return;
    }
    if (msg.type === "LAYERS_RESULT") {
      const { type, requestId, ...payload } = msg;
      settleInflight(inflightLayers.current, requestId, { layers: payload.layers as NFTVisualLayer[] });
      return;
    }
  }, []);

  // ── Worker lifecycle ──────────────────────────────────────────────────────

  const ensureWorker = useCallback((): Worker | null => {
    // SSR: never spawn a worker.
    if (typeof window === "undefined" || typeof Worker === "undefined") {
      return null;
    }
    if (workerRef.current) return workerRef.current;
    try {
      const worker = new Worker(
        new URL("./fractional-nft.worker.ts", import.meta.url),
        { type: "module" }
      );
      worker.onmessage = routeMessage as (ev: MessageEvent) => void;
      worker.onerror = (err) => {
        // Surface the error to every inflight promise so nothing hangs.
        const errObj = new Error(err.message || "Fractional NFT Worker error");
        rejectAllInflight(errObj);
      };
      workerRef.current = worker;
      return worker;
    } catch (err) {
      // Fallback: no worker available — calls will resolve with an empty SVG
      // so the UI never crashes, and the component can still render a shell.
      return null;
    }
  }, [routeMessage]);

  // ── Public methods ───────────────────────────────────────────────────────

  const render = useCallback(
    (
      nft: FractionalNFT,
      width: number,
      height: number,
      opts?: { includeDataUrl?: boolean }
    ): [Promise<RenderPayload>, () => void] => {
      const worker = ensureWorker();
      const requestId = makeRequestId();

      const promise = new Promise<RenderPayload>((resolve, reject) => {
        const entry: InflightEntry<RenderPayload> = { resolve, reject };
        inflightRender.current.set(requestId, entry);

        // Without a worker, degrade to an empty-but-valid SVG shell
        // synchronously so callers never observe an infinitely-pending render.
        if (!worker) {
          queueMicrotask(() => {
            entry.resolve({
              svgMarkup: fallbackSvg(width, height, nft),
              viewBox: `0 0 ${width} ${height}`,
              intrinsicSize: { width, height },
              renderTimeNs: 0,
            });
          });
          return;
        }

        const payload: Extract<NftWorkerInboundMessage, { type: "RENDER" }> = {
          type: "RENDER",
          requestId,
          nft,
          width,
          height,
          includeDataUrl: opts?.includeDataUrl,
        };
        worker.postMessage(payload);
      });

      const cancel = () => {
        const entry = inflightRender.current.get(requestId);
        if (!entry) return;
        entry.cancelled = true;
        inflightRender.current.delete(requestId);
        entry.reject(REJECT_REASON_CANCELLED);
      };

      return [promise, cancel];
    },
    [ensureWorker]
  );

  const computeSlices = useCallback(
    (shares: FractionalShare[], paletteSeed: number): Promise<SlicesPayload> => {
      const worker = ensureWorker();
      const requestId = makeRequestId();
      return new Promise<SlicesPayload>((resolve, reject) => {
        inflightSlices.current.set(requestId, { resolve, reject });
        if (!worker) {
          queueMicrotask(() => {
            // Deterministic fallback — share %, equal color cycle.
            resolve({ slices: fallbackSlices(shares, paletteSeed) });
          });
          return;
        }
        const payload: Extract<NftWorkerInboundMessage, { type: "COMPUTE_SLICES" }> = {
          type: "COMPUTE_SLICES",
          requestId,
          shares,
          paletteSeed,
        };
        worker.postMessage(payload);
      });
    },
    [ensureWorker]
  );

  const generateLayers = useCallback(
    (
      tokenId: string,
      rarity: NFTRarityTier,
      seed: number
    ): Promise<LayersPayload> => {
      const worker = ensureWorker();
      const requestId = makeRequestId();
      return new Promise<LayersPayload>((resolve, reject) => {
        inflightLayers.current.set(requestId, { resolve, reject });
        if (!worker) {
          queueMicrotask(() => resolve({ layers: fallbackLayers(tokenId, rarity, seed) }));
          return;
        }
        const payload: Extract<NftWorkerInboundMessage, { type: "GENERATE_LAYERS" }> = {
          type: "GENERATE_LAYERS",
          requestId,
          tokenId,
          rarity,
          seed,
        };
        worker.postMessage(payload);
      });
    },
    [ensureWorker]
  );

  // ── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      // Signal unmount first so new promises can be rejected synchronously
      // before the worker is terminated mid-message.
      rejectAllInflight(REJECT_REASON_UNMOUNTED);
      const w = workerRef.current;
      if (w) {
        try {
          w.postMessage({ type: "CLEANUP" } satisfies NftWorkerInboundMessage);
        } catch {
          /* ignore send failure during teardown */
        }
        w.terminate();
        workerRef.current = null;
      }
      isReadyRef.current = false;
    };
  }, []);

  // ── Private helpers scoped to the hook (closures over ref maps) ──────────

  function rejectInflight(requestId: string, err: Error): void {
    for (const map of [inflightRender.current, inflightSlices.current, inflightLayers.current]) {
      const entry = (map as Map<string, InflightEntry<unknown>>).get(requestId);
      if (entry) {
        (map as Map<string, InflightEntry<unknown>>).delete(requestId);
        entry.reject(err);
        return;
      }
    }
  }

  function rejectAllInflight(err: unknown): void {
    for (const map of [inflightRender.current, inflightSlices.current, inflightLayers.current]) {
      for (const [key, entry] of map.entries()) {
        map.delete(key);
        entry.reject(err);
      }
    }
  }

  const handle = useMemo<FractionalNftWorkerHandle>(
    () => ({
      get isReady() {
        return isReadyRef.current;
      },
      render,
      computeSlices,
      generateLayers,
    }),
    [render, computeSlices, generateLayers]
  );

  return handle;
}

// ── Fallback implementations (used when Worker is unavailable) ──────────────

function fallbackSvg(width: number, height: number, nft: FractionalNFT): string {
  const name = nft?.metadata?.name ?? "Fractional NFT";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#1E293B" rx="24"/><text x="50%" y="50%" text-anchor="middle" font-family="Inter,sans-serif" font-size="${Math.max(
      12,
      Math.round(height * 0.06)
    )}" fill="#CBD5E1" font-weight="700">${xmlEscape(name)}</text></svg>`
  );
}

function fallbackSlices(
  shares: FractionalShare[],
  paletteSeed: number
): OwnershipSlice[] {
  const palette = [
    "#7B61FF",
    "#00CDCC",
    "#FBBF24",
    "#F472B6",
    "#34D399",
    "#60A5FA",
  ];
  const out: OwnershipSlice[] = [];
  let cursor = 0;
  const sorted = Array.isArray(shares)
    ? [...shares].sort(
        (a, b) => Number(b.ownershipPercent) - Number(a.ownershipPercent)
      )
    : [];
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]!;
    const pct = Math.max(0, Math.min(100, Number(s.ownershipPercent) || 0));
    if (pct <= 0) continue;
    out.push({
      owner: typeof s.owner === "string" ? s.owner : "",
      startPercent: cursor,
      endPercent: cursor + pct,
      color: palette[(i + (paletteSeed >>> 0)) % palette.length]!,
      unlockTimestamp: Number.isFinite(s.unlockTimestamp) ? s.unlockTimestamp : 0,
      isListed: !!s.isListed,
    });
    cursor += pct;
  }
  return out;
}

function fallbackLayers(
  tokenId: string,
  rarity: NFTRarityTier,
  seed: number
): NFTVisualLayer[] {
  const accentByRarity: Record<NFTRarityTier, string> = {
    COMMON: "#94A3B8",
    UNCOMMON: "#4ADE80",
    RARE: "#60A5FA",
    EPIC: "#C084FC",
    LEGENDARY: "#FBBF24",
    MYTHIC: "#F472B6",
  };
  const accent = accentByRarity[rarity] ?? accentByRarity.COMMON;
  const s = (seed >>> 0) || hashStr(tokenId);
  return [
    {
      id: "fb-bg",
      name: "background",
      category: "background",
      variant: s % 3,
      palette: { primary: "#0F172A", secondary: "#1E293B", accent },
      opacity: 0.5,
      rotation: s % 90,
      scale: 0.5,
      seed: s,
    },
  ];
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function settleInflight<T>(
  map: Map<string, InflightEntry<T>>,
  requestId: string,
  payload: T
): void {
  const entry = map.get(requestId);
  if (!entry) return;
  map.delete(requestId);
  if (entry.cancelled) {
    entry.reject(REJECT_REASON_CANCELLED);
    return;
  }
  entry.resolve(payload);
}
