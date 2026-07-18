"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

interface FundingHistoryPoint {
  id: string;
  orgId: string;
  from: string;
  amountStroops: string;
  amountXlm: string;
  cumulativeStroops: string;
  cumulativeXlm: string;
  txHash: string;
  createdAt: string;
}

interface FundingHistoryChartProps {
  orgId: string;
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:3001/api";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Failed to fetch funding history");
  }
  return res.json() as Promise<FundingHistoryPoint[]>;
};

export function FundingHistoryChart({ orgId }: FundingHistoryChartProps) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["funding-history", orgId],
    queryFn: () => fetcher(`${BACKEND_URL}/stats/funding-history/${orgId}`),
    enabled: Boolean(orgId),
    staleTime: 5000,
  });

  const [hoveredPoint, setHoveredPoint] = useState<FundingHistoryPoint | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  if (isLoading) {
    return (
      <div className="glass-card p-6 animate-pulse space-y-4">
        <div className="h-6 w-48 bg-white/10 rounded" />
        <div className="h-48 bg-white/5 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="glass-card p-6 border-red-500/30 bg-red-500/5 text-center">
        <p className="text-red-400 text-sm">Failed to load funding history</p>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="glass-card p-8 text-center flex flex-col items-center justify-center min-h-[220px]">
        <div className="h-12 w-12 rounded-full bg-stellar-purple/10 flex items-center justify-center mb-3">
          <svg className="h-6 w-6 text-stellar-purple" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        </div>
        <h4 className="text-white font-medium mb-1">No Funding History Yet</h4>
        <p className="text-white/40 text-xs max-w-sm">
          There are no indexed on-chain funding transactions for this organization yet.
        </p>
      </div>
    );
  }

  // Dimension setup for SVG
  const width = 600;
  const height = 240;
  const paddingX = 60;
  const paddingY = 40;
  const chartWidth = width - 2 * paddingX;
  const chartHeight = height - 2 * paddingY;

  // Process data points and map to coordinates
  const parsedPoints = data.map((pt) => ({
    ...pt,
    valXlm: Number(pt.cumulativeXlm),
    amountValXlm: Number(pt.amountXlm),
    time: new Date(pt.createdAt).getTime(),
  }));

  const tMin = parsedPoints[0]!.time;
  const tMax = parsedPoints[parsedPoints.length - 1]!.time;
  const yMax = Math.max(...parsedPoints.map((p) => p.valXlm));
  const yLimit = yMax === 0 ? 10 : yMax * 1.15; // 15% top padding

  const pointsWithCoords = parsedPoints.map((pt) => {
    // X calculation
    let ratioX = 0;
    if (parsedPoints.length > 1 && tMax !== tMin) {
      ratioX = (pt.time - tMin) / (tMax - tMin);
    } else {
      ratioX = 0.5; // Single point in center
    }
    const cx = paddingX + ratioX * chartWidth;

    // Y calculation
    const ratioY = pt.valXlm / yLimit;
    const cy = height - paddingY - ratioY * chartHeight;

    return { ...pt, cx, cy };
  });

  // Construct SVG Path definitions
  let linePath = "";
  let areaPath = "";

  if (pointsWithCoords.length > 0) {
    if (pointsWithCoords.length === 1) {
      const p = pointsWithCoords[0]!;
      linePath = `M ${p.cx - 20} ${p.cy} L ${p.cx + 20} ${p.cy}`;
      areaPath = `M ${p.cx - 20} ${p.cy} L ${p.cx + 20} ${p.cy} L ${p.cx + 20} ${height - paddingY} L ${p.cx - 20} ${height - paddingY} Z`;
    } else {
      const pathSegments = pointsWithCoords.map((p, i) => `${i === 0 ? "M" : "L"} ${p.cx} ${p.cy}`);
      linePath = pathSegments.join(" ");

      const first = pointsWithCoords[0]!;
      const last = pointsWithCoords[pointsWithCoords.length - 1]!;
      areaPath = `${linePath} L ${last.cx} ${height - paddingY} L ${first.cx} ${height - paddingY} Z`;
    }
  }

  // Format dates helper
  const formatDateLabel = (isoStr: string) => {
    const d = new Date(isoStr);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const formatFullDate = (isoStr: string) => {
    return new Date(isoStr).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatShortAddress = (addr: string) => {
    if (!addr) return "";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  return (
    <div className="glass-card p-6 relative">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-white text-sm uppercase tracking-wider">
            Funding History
          </h3>
          <p className="text-white/40 text-xs mt-0.5">
            Cumulative budget contributions over time (in XLM)
          </p>
        </div>
        <div className="flex items-baseline gap-1 text-right">
          <span className="text-lg font-bold text-stellar-teal">{yMax.toFixed(2)}</span>
          <span className="text-xs text-stellar-teal font-medium">XLM Total</span>
        </div>
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none overflow-visible">
          <defs>
            <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#7B61FF" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#00CDCC" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Grid Lines */}
          <line
            x1={paddingX}
            y1={paddingY}
            x2={width - paddingX}
            y2={paddingY}
            stroke="rgba(255,255,255,0.05)"
            strokeDasharray="4"
          />
          <line
            x1={paddingX}
            y1={paddingY + chartHeight / 2}
            x2={width - paddingX}
            y2={paddingY + chartHeight / 2}
            stroke="rgba(255,255,255,0.05)"
            strokeDasharray="4"
          />
          <line
            x1={paddingX}
            y1={height - paddingY}
            x2={width - paddingX}
            y2={height - paddingY}
            stroke="rgba(255,255,255,0.1)"
          />

          {/* Y Axis Labels */}
          <text
            x={paddingX - 10}
            y={paddingY + 4}
            textAnchor="end"
            className="text-[10px] fill-white/40 font-mono"
          >
            {yLimit.toFixed(1)}
          </text>
          <text
            x={paddingX - 10}
            y={paddingY + chartHeight / 2 + 4}
            textAnchor="end"
            className="text-[10px] fill-white/40 font-mono"
          >
            {(yLimit / 2).toFixed(1)}
          </text>
          <text
            x={paddingX - 10}
            y={height - paddingY + 4}
            textAnchor="end"
            className="text-[10px] fill-white/40 font-mono"
          >
            0.0
          </text>

          {/* X Axis Labels */}
          {pointsWithCoords.length > 0 && (
            <>
              <text
                x={pointsWithCoords[0]!.cx}
                y={height - paddingY + 18}
                textAnchor="middle"
                className="text-[10px] fill-white/40 font-mono"
              >
                {formatDateLabel(pointsWithCoords[0]!.createdAt)}
              </text>
              {pointsWithCoords.length > 1 && (
                <text
                  x={pointsWithCoords[pointsWithCoords.length - 1]!.cx}
                  y={height - paddingY + 18}
                  textAnchor="middle"
                  className="text-[10px] fill-white/40 font-mono"
                >
                  {formatDateLabel(pointsWithCoords[pointsWithCoords.length - 1]!.createdAt)}
                </text>
              )}
            </>
          )}

          {/* Paths */}
          {areaPath && <path d={areaPath} fill="url(#areaGradient)" />}
          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke="url(#lineGradient)"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          )}

          <linearGradient id="lineGradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#7B61FF" />
            <stop offset="100%" stopColor="#00CDCC" />
          </linearGradient>

          {/* Interactive Dots */}
          {pointsWithCoords.map((pt) => {
            const isHovered = hoveredPoint?.id === pt.id;
            return (
              <g key={pt.id}>
                {/* Glow ring on hover */}
                {isHovered && (
                  <circle
                    cx={pt.cx}
                    cy={pt.cy}
                    r="10"
                    fill="none"
                    stroke="#7B61FF"
                    strokeWidth="1.5"
                    opacity="0.5"
                    className="animate-ping"
                  />
                )}
                {/* Outer interactive hit target */}
                <circle
                  cx={pt.cx}
                  cy={pt.cy}
                  r="14"
                  fill="transparent"
                  className="cursor-pointer"
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const containerRect = e.currentTarget.ownerDocument.documentElement.getBoundingClientRect();
                    setHoveredPoint(pt);
                    setTooltipPos({
                      x: rect.left - containerRect.left + rect.width / 2,
                      y: rect.top - containerRect.top - 10,
                    });
                  }}
                  onMouseLeave={() => {
                    setHoveredPoint(null);
                    setTooltipPos(null);
                  }}
                />
                {/* Core dot visual */}
                <circle
                  cx={pt.cx}
                  cy={pt.cy}
                  r={isHovered ? "5" : "3.5"}
                  fill={isHovered ? "#00CDCC" : "#7B61FF"}
                  stroke="#0A0E27"
                  strokeWidth="1.5"
                  className="transition-all duration-150 pointer-events-none"
                />
              </g>
            );
          })}
        </svg>
      </div>

      {/* Floating Tooltip */}
      {hoveredPoint && tooltipPos && (
        <div
          className="absolute z-10 glass-panel p-3 text-xs pointer-events-none shadow-2xl transition-all duration-150 -translate-x-1/2 -translate-y-full flex flex-col gap-1 border border-white/10"
          style={{
            left: `${tooltipPos.x}px`,
            top: `${tooltipPos.y}px`,
            minWidth: "160px",
          }}
        >
          <div className="text-[10px] text-white/40 font-mono">
            {formatFullDate(hoveredPoint.createdAt)}
          </div>
          <div className="flex justify-between items-baseline gap-4">
            <span className="text-white/60">Funding Amount</span>
            <span className="font-bold text-green-400 font-mono">
              +{Number(hoveredPoint.amountXlm).toFixed(2)} XLM
            </span>
          </div>
          <div className="flex justify-between items-baseline gap-4 pt-1 border-t border-white/5">
            <span className="text-white/60">Cumulative Total</span>
            <span className="font-bold text-stellar-teal font-mono">
              {Number(hoveredPoint.cumulativeXlm).toFixed(2)} XLM
            </span>
          </div>
          <div className="text-[10px] text-white/30 truncate mt-1 pt-1 border-t border-white/5">
            from: {formatShortAddress(hoveredPoint.from)}
          </div>
        </div>
      )}
    </div>
  );
}
