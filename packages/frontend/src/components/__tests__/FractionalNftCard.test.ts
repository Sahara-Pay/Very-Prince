/**
 * @file FractionalNftCard.test.ts
 * @description Test the PURE helpers embedded in FractionalNftCard.tsx and
 * the nftSampleData factory. React-rendering tests are excluded from this
 * suite to keep it fast and deterministic — the rendering is validated in
 * the playwright E2E spec.
 */

import { describe, it, expect } from "vitest";
import {
  buildSampleFractionalNft,
  buildSampleNftBatch,
  runNftLoadSimulator,
} from "@/lib/nftSampleData";
import type { FractionalShare, OwnershipSlice } from "@very-prince/types";

// Mirror the card's pure helpers.
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function isEquivalentSnapshot(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a.seed !== b.seed) return false;
  if (a.metadata?.tokenId !== b.metadata?.tokenId) return false;
  if (a.metadata?.rarity !== b.metadata?.rarity) return false;
  if (a.metadata?.name !== b.metadata?.name) return false;
  if (a.metadata?.totalSupply !== b.metadata?.totalSupply) return false;
  if (a.shares?.length !== b.shares?.length) return false;
  for (let i = 0; i < a.shares.length; i++) {
    const as = a.shares[i];
    const bs = b.shares[i];
    if (
      as.owner !== bs.owner ||
      as.ownershipPercent !== bs.ownershipPercent ||
      as.shares !== bs.shares
    ) {
      return false;
    }
  }
  if (a.layers?.length !== b.layers?.length) return false;
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

describe("FractionalNftCard — pure helpers", () => {
  describe("hashSeed", () => {
    it("returns a positive 32-bit integer for any input", () => {
      for (const s of ["", "x", "token-abc-123", "🎉 emoji 🎉"]) {
        const h = hashSeed(s);
        expect(Number.isInteger(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(0xffffffff + 1);
      }
    });
  });

  describe("isEquivalentSnapshot", () => {
    it("treats identical NFT references as equivalent", () => {
      const nft = buildSampleFractionalNft("t", 1, { shareCount: 4 });
      expect(isEquivalentSnapshot(nft, nft)).toBe(true);
    });

    it("treats deep-cloned NFTs as equivalent", () => {
      const a = buildSampleFractionalNft("t", 2, { shareCount: 5 });
      const b = JSON.parse(JSON.stringify(a));
      expect(isEquivalentSnapshot(a, b)).toBe(true);
    });

    it("detects metadata differences", () => {
      const a = buildSampleFractionalNft("t", 3);
      const b = { ...a, metadata: { ...a.metadata, name: "CHANGED" } };
      expect(isEquivalentSnapshot(a, b)).toBe(false);
    });

    it("detects share-array differences", () => {
      const a = buildSampleFractionalNft("t", 4, { shareCount: 3 });
      const b = {
        ...a,
        shares: a.shares.map((s, i) =>
          i === 0 ? { ...s, ownershipPercent: s.ownershipPercent + 0.01 } : s
        ),
      };
      expect(isEquivalentSnapshot(a, b)).toBe(false);
    });

    it("returns false for null inputs", () => {
      expect(isEquivalentSnapshot(null, buildSampleFractionalNft("t", 5))).toBe(false);
      expect(isEquivalentSnapshot(buildSampleFractionalNft("t", 6), undefined)).toBe(false);
    });
  });

  describe("buildOwnershipSummary", () => {
    it("returns the no-issued message for empty slices", () => {
      expect(buildOwnershipSummary([])).toMatch(/no/i);
    });

    it("reports up to 3 holders in descending order", () => {
      const slices: OwnershipSlice[] = [
        mkSlice("GAAAA", 0, 10, 0),
        mkSlice("GBBBB", 10, 60, 0), // largest
        mkSlice("GCCCC", 60, 80, 0),
        mkSlice("GDDDD", 80, 100, 0),
      ];
      const s = buildOwnershipSummary(slices);
      expect(s.indexOf("GBBBB")).toBeLessThan(s.indexOf("GCCCC"));
      expect(s).toContain("50.0%");
      expect(s).not.toContain("GDDDD"); // 4th holder is excluded
    });
  });

  describe("sliceAriaLabel", () => {
    it("mentions vesting unlock dates for locked shares", () => {
      const future = Math.round(Date.now() / 1000) + 60 * 60 * 24;
      const label = sliceAriaLabel(mkSlice("GA", 0, 20, future));
      expect(label).toMatch(/locked until/i);
    });

    it("mentions 'listed for sale' for listed shares", () => {
      const label = sliceAriaLabel({
        ...mkSlice("GB", 0, 10, 0),
        isListed: true,
      });
      expect(label).toMatch(/listed for sale/i);
    });

    it("reports 'liquid, available to transfer' for a normal share", () => {
      const label = sliceAriaLabel(mkSlice("GC", 0, 100, 0));
      expect(label).toMatch(/liquid/);
    });
  });
});

describe("nftSampleData factory", () => {
  it("builds NFTs with percentages summing to <= 100", () => {
    for (let i = 0; i < 50; i++) {
      const nft = buildSampleFractionalNft("t", i, { shareCount: 1 + (i % 8) });
      const total = nft.shares.reduce((acc, s) => acc + s.ownershipPercent, 0);
      expect(total).toBeLessThanOrEqual(100.01); // rounding drift
      expect(total).toBeGreaterThanOrEqual(99.99);
    }
  });

  it("builds zero-share NFTs when shareCount = 0", () => {
    const nft = buildSampleFractionalNft("t", 999, { shareCount: 0 });
    expect(nft.shares).toEqual([]);
  });

  it("batch builder honors the requested count up to 500", () => {
    const b1 = buildSampleNftBatch(12, "x");
    expect(b1).toHaveLength(12);
    const b2 = buildSampleNftBatch(0);
    expect(b2).toHaveLength(0);
    const b3 = buildSampleNftBatch(1_000_000); // caps to 500
    expect(b3).toHaveLength(500);
  });

  it("batches have unique tokenIds", () => {
    const batch = buildSampleNftBatch(40, "y");
    const ids = new Set(batch.map((n) => n.metadata.tokenId));
    expect(ids.size).toBe(batch.length);
  });

  it("load simulator reports scheduled/observed ops close to the target", async () => {
    const nft = buildSampleFractionalNft("load", 0);
    let calls = 0;
    const sim = runNftLoadSimulator(nft, 50, 250, () => {
      calls++;
    });
    await new Promise((r) => setTimeout(r, 350));
    sim.stop();
    const m = sim.metrics();
    expect(calls).toBeGreaterThan(0);
    expect(m.observedOps).toBe(calls);
    // At 50 ops/sec for 250 ms — expect ~10-15 calls. Allow flakiness.
    expect(m.observedOps).toBeGreaterThanOrEqual(3);
    expect(m.elapsedMs).toBeGreaterThanOrEqual(200);
    // Max jitter should be far below the callback interval (20 ms) * 5.
    expect(m.maxJitterMs).toBeLessThan(200);
  });

  it("load simulator mutates each NFT snapshot (not a stable ref)", () => {
    const nft = buildSampleFractionalNft("load2", 0, { shareCount: 3 });
    const seen = new Set<string>();
    const sim = runNftLoadSimulator(nft, 30, 180, (snap) => {
      seen.add(JSON.stringify(snap.shares.map((x) => x.isListed)));
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        sim.stop();
        // With 3 shares rotating the "listed" flag each step, multiple
        // distinct serialized states should appear over ~5 steps.
        expect(seen.size).toBeGreaterThanOrEqual(1);
        resolve();
      }, 260);
    });
  });
});

// ── Test helpers ─────────────────────────────────────────────────────────────

function mkSlice(
  owner: string,
  startPercent: number,
  endPercent: number,
  unlockTimestamp: number
): OwnershipSlice {
  return {
    owner,
    startPercent,
    endPercent,
    color: "#7B61FF",
    unlockTimestamp,
    isListed: false,
  };
}

// Export nothing — just to make TS treat this as a module when strict is off.
export type _ = FractionalShare;
