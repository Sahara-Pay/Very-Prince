/**
 * @file page.tsx — /dashboard/nft-gallery
 * @description Client-side gallery showing every NFTRarityTier's card rendering
 * the new fractional NFT SVG pipeline. Also exposes the load-simulator so
 * teams can verify 60 FPS behavior during rapid prop mutations.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { FractionalNftCard } from "@/components/FractionalNftCard";
import type { FractionalNFT, OwnershipSlice } from "@very-prince/types";
import {
  buildSampleNftBatch,
  runNftLoadSimulator,
  type LoadSimulatorHandle,
  type LoadSimulatorMetrics,
} from "@/lib/nftSampleData";

const GlassPanel = dynamic(() =>
  import("@/components/GlassPanel").then((mod) => mod.GlassPanel)
);

export default function NftGalleryPage() {
  const [count, setCount] = useState<number>(12);
  const [shareCount, setShareCount] = useState<number>(4);
  const [loadOpsPerSec, setLoadOpsPerSec] = useState<number>(60);
  const [loadRunning, setLoadRunning] = useState<boolean>(false);
  const [loadMetrics, setLoadMetrics] = useState<LoadSimulatorMetrics | null>(null);
  const [hovered, setHovered] = useState<OwnershipSlice | null>(null);
  const [perfStats, setPerfStats] = useState<{
    avgRenderNs: number;
    framesSampled: number;
    p95RenderNs: number;
  } | null>(null);

  const nfts = useMemo<FractionalNFT[]>(
    () =>
      buildSampleNftBatch(count, "gal", {
        shareCount,
      }),
    [count, shareCount]
  );

  const simRef = useRef<LoadSimulatorHandle | null>(null);
  const [stressNft, setStressNft] = useState<FractionalNFT>(() => nfts[0] ?? buildSampleNftBatch(1, "s")[0]!);
  const renderSamples = useRef<number[]>([]);

  // Sample render timings for the gallery-perf panel.
  const handleRenderComplete = useCallback(
    (m: { renderTimeNs: number }) => {
      renderSamples.current.push(m.renderTimeNs);
      if (renderSamples.current.length > 1000) {
        renderSamples.current.splice(0, renderSamples.current.length - 1000);
      }
      const arr = renderSamples.current.slice().sort((a, b) => a - b);
      const avg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const p95 = arr.length ? arr[Math.floor(arr.length * 0.95)] ?? 0 : 0;
      setPerfStats({ avgRenderNs: avg, framesSampled: arr.length, p95RenderNs: p95 });
    },
    []
  );

  const startLoad = useCallback(() => {
    if (simRef.current) return;
    simRef.current = runNftLoadSimulator(stressNft, loadOpsPerSec, 10_000, (nft) => {
      setStressNft(nft);
    });
    setLoadRunning(true);
    setTimeout(() => {
      if (simRef.current) {
        setLoadMetrics(simRef.current.metrics());
        simRef.current.stop();
        simRef.current = null;
        setLoadRunning(false);
      }
    }, 10_200);
  }, [stressNft, loadOpsPerSec]);

  const stopLoad = useCallback(() => {
    simRef.current?.stop();
    simRef.current = null;
    setLoadRunning(false);
    if (simRef.current) {
      setLoadMetrics(simRef.current.metrics());
    }
  }, []);

  useEffect(() => stopLoad, [stopLoad]);

  return (
    <div className="min-h-screen bg-[#0A0E27] text-white p-6 md:p-10">
      <header className="max-w-7xl mx-auto mb-8">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          Fractional NFT SVG Gallery
        </h1>
        <p className="text-white/50 text-sm mt-2 max-w-2xl">
          60 FPS SVG rendering pipeline. All artwork and ownership-bar
          composition runs off the main thread in a dedicated Web Worker —
          wallet state mutations and block-stream updates never block the UI.
        </p>
      </header>

      {/* Controls */}
      <section className="max-w-7xl mx-auto mb-8 grid grid-cols-1 md:grid-cols-3 gap-4">
        <GlassPanel className="p-4 flex flex-col gap-3">
          <label className="text-xs uppercase tracking-widest text-white/50">
            Cards rendered
          </label>
          <input
            type="range"
            min={1}
            max={60}
            step={1}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="accent-stellar-teal"
          />
          <div className="flex justify-between text-xs font-mono">
            <span className="text-white/40">1</span>
            <span className="text-stellar-teal font-bold">{count} cards</span>
            <span className="text-white/40">60</span>
          </div>
        </GlassPanel>

        <GlassPanel className="p-4 flex flex-col gap-3">
          <label className="text-xs uppercase tracking-widest text-white/50">
            Shares per NFT
          </label>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={shareCount}
            onChange={(e) => setShareCount(Number(e.target.value))}
            className="accent-stellar-teal"
          />
          <div className="flex justify-between text-xs font-mono">
            <span className="text-white/40">0 (unissued)</span>
            <span className="text-stellar-teal font-bold">{shareCount} holders</span>
            <span className="text-white/40">10</span>
          </div>
        </GlassPanel>

        <GlassPanel className="p-4 flex flex-col gap-3">
          <label className="text-xs uppercase tracking-widest text-white/50">
            Load simulator target (ops/sec)
          </label>
          <input
            type="range"
            min={1}
            max={240}
            step={1}
            value={loadOpsPerSec}
            onChange={(e) => setLoadOpsPerSec(Number(e.target.value))}
            disabled={loadRunning}
            className="accent-stellar-teal"
          />
          <div className="flex gap-2">
            <button
              onClick={startLoad}
              disabled={loadRunning}
              className="flex-1 bg-stellar-purple hover:bg-stellar-purple/80 disabled:opacity-40 text-white text-xs font-bold uppercase tracking-widest rounded-xl py-2 transition"
            >
              {loadRunning ? "Running…" : "Start 10 s stress"}
            </button>
            <button
              onClick={stopLoad}
              disabled={!loadRunning}
              className="px-4 bg-rose-500/80 hover:bg-rose-500 disabled:opacity-30 text-white text-xs font-bold rounded-xl"
            >
              Stop
            </button>
          </div>
        </GlassPanel>
      </section>

      {/* Perf summary */}
      <section className="max-w-7xl mx-auto mb-8 grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricTile label="Avg. render" value={perfStats ? formatNs(perfStats.avgRenderNs) : "—"} />
        <MetricTile label="p95 render" value={perfStats ? formatNs(perfStats.p95RenderNs) : "—"} />
        <MetricTile label="Samples" value={perfStats ? String(perfStats.framesSampled) : "0"} />
        <MetricTile
          label={loadRunning ? "Live ops/sec" : "Last stress ops/sec"}
          value={loadMetrics ? loadMetrics.opsPerSecond.toFixed(0) : "0"}
        />
      </section>

      {/* Single stress-test card */}
      {loadMetrics || loadRunning ? (
        <section className="max-w-7xl mx-auto mb-10 grid grid-cols-1 md:grid-cols-2 gap-4">
          <FractionalNftCard
            key={stressNft.metadata.tokenId + "-stress"}
            nft={stressNft}
            size={420}
            interactive
            onRenderComplete={handleRenderComplete}
            onSliceHover={setHovered}
            className="mx-auto"
          />
          <GlassPanel className="p-5 text-sm flex flex-col gap-3">
            <h3 className="text-lg font-semibold">Load simulator metrics</h3>
            <p className="text-white/50 text-xs">
              Updates were driven at <code className="font-mono">{loadOpsPerSec}/s</code> for
              the duration of the test. Values below reflect real wall-clock performance.
            </p>
            {loadMetrics ? (
              <dl className="grid grid-cols-2 gap-y-2 gap-x-4 font-mono text-xs mt-2">
                <dt className="text-white/40">Elapsed</dt>
                <dd>{loadMetrics.elapsedMs.toFixed(0)} ms</dd>
                <dt className="text-white/40">Scheduled</dt>
                <dd>{loadMetrics.scheduledOps}</dd>
                <dt className="text-white/40">Observed</dt>
                <dd>{loadMetrics.observedOps}</dd>
                <dt className="text-white/40">Effective ops/s</dt>
                <dd className="text-stellar-teal">{loadMetrics.opsPerSecond.toFixed(1)}</dd>
                <dt className="text-white/40">Max jitter</dt>
                <dd
                  className={
                    loadMetrics.maxJitterMs < 20 ? "text-green-400" : "text-amber-400"
                  }
                >
                  {loadMetrics.maxJitterMs.toFixed(2)} ms
                </dd>
                <dt className="text-white/40">Avg jitter</dt>
                <dd>{loadMetrics.avgJitterMs.toFixed(2)} ms</dd>
              </dl>
            ) : (
              <p className="text-white/30 text-xs">
                Stress run in progress — metrics update on completion.
              </p>
            )}
            <div className="mt-auto text-[11px] text-white/40 pt-4 border-t border-white/5">
              Hovered slice:{" "}
              <span className="font-mono">
                {hovered
                  ? `${shortAddr(hovered.owner)} owns ${(hovered.endPercent - hovered.startPercent).toFixed(2)}%`
                  : "—"}
              </span>
            </div>
          </GlassPanel>
        </section>
      ) : null}

      {/* Gallery */}
      <section className="max-w-7xl mx-auto">
        <h2 className="text-sm uppercase tracking-widest text-white/40 mb-4">
          {nfts.length} sample cards
        </h2>
        <div
          className="grid gap-5"
          style={{
            gridTemplateColumns:
              "repeat(auto-fill, minmax(min(260px, 100%), 1fr))",
          }}
        >
          {nfts.map((nft, i) => (
            <FractionalNftCard
              key={nft.metadata.tokenId}
              nft={nft}
              size={280}
              interactive
              onSliceHover={(i === 0 || i === count - 1) ? setHovered : undefined}
              onRenderComplete={handleRenderComplete}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

// ── Small UI helpers ─────────────────────────────────────────────────────────

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <GlassPanel className="p-4">
      <div className="text-[10px] uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div className="text-xl font-bold font-mono text-stellar-teal mt-1">{value}</div>
    </GlassPanel>
  );
}

function formatNs(ns: number): string {
  if (!Number.isFinite(ns) || ns <= 0) return "—";
  if (ns < 1_000) return `${ns.toFixed(0)} ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)} µs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
