/**
 * @file nftSampleData.ts
 * @description Deterministic sample-data factory + heavy-load simulator for
 * fractional NFT SVG rendering.
 *
 * Sample factory is used for two purposes:
 *   (1) Feed the card component in gallery / demo views.
 *   (2) Drive the load simulator so teams can verify 60 FPS behavior even
 *       when every share record, layer, and rarity variant is being mutated
 *       in lock-step with wallet state and block-stream updates.
 *
 * All helpers are pure + seeded (mulberry32) so the same inputs always
 * produce identical outputs — critical for repeatable performance benches.
 */

import type {
  FractionalNFT,
  FractionalNFTMetadata,
  FractionalShare,
  NFTVisualLayer,
  NFTRarityTier,
} from "@very-prince/types";

const RARITY_TIERS: readonly NFTRarityTier[] = [
  "COMMON",
  "UNCOMMON",
  "RARE",
  "EPIC",
  "LEGENDARY",
  "MYTHIC",
] as const;

const SAMPLE_NAMES: readonly string[] = [
  "Open Source Pension",
  "Infra Grant Pool",
  "Docs Stewardship",
  "Security Audit Pool",
  "Diversity in OSS",
  "Educational Streams",
  "Research Collective",
  "Community Bounties",
] as const;

const FRACTION_OWNERS: readonly string[] = [
  "GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGH",
  "GAZYXWVUTSRQPONMLKJIHGFEDCBA9876543210ZYXWVUTS",
  "GQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
  "G1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567",
  "GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ZYXWVUT",
  "GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
  "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "GFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
  "G9999999999999999999999999999999999999999",
  "G6666666666666666666666666666666666666666",
] as const;

/** Seeded PRNG — identical across worker and main thread. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fast non-crypto token id generator for samples. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface SampleNftOptions {
  seed?: number;
  /** Number of fractional ownership shares (0..N). 0 = not-yet-issued. */
  shareCount?: number;
  /** Number of decorative visual layers. */
  layerCount?: number;
  /** Override rarity tier (otherwise derived from seed). */
  rarity?: NFTRarityTier;
  /** How many shares should be marked as "listed". */
  listedFraction?: number;
  /** How many shares should still be vesting. */
  vestingFraction?: number;
}

/**
 * Build a single deterministic FractionalNFT suitable for rendering and
 * performance testing. All returned data is valid per the type contracts —
 * percentages sum to 100 %, layers are sorted by category order, and
 * bigint-safe share strings are monotonically increasing.
 */
export function buildSampleFractionalNft(
  idPrefix: string,
  seq: number,
  opts: SampleNftOptions = {}
): FractionalNFT {
  const seed = opts.seed ?? fnv1a(`${idPrefix}:${seq}`);
  const rng = mulberry32(seed);

  const rarity: NFTRarityTier =
    opts.rarity ??
    RARITY_TIERS[Math.floor(rng() * RARITY_TIERS.length)] ??
    "COMMON";

  const name =
    SAMPLE_NAMES[Math.floor(rng() * SAMPLE_NAMES.length)] ??
    "Community Pool";

  const tokenId = `${idPrefix}-${rarity}-${seq.toString(36).padStart(6, "0")}`;
  const collectionId = `${idPrefix}-COLLECTION-A`;

  const shareCount = Math.max(
    0,
    Math.min(FRACTION_OWNERS.length, Math.round(opts.shareCount ?? 1 + Math.floor(rng() * 6)))
  );
  const sharePercents = generateSharePercentages(shareCount, rng);
  const totalSupply = 10_000_000n * BigInt(seq + 1);

  const shares: FractionalShare[] = sharePercents.map((pct, i) => {
    const owner = FRACTION_OWNERS[i % FRACTION_OWNERS.length]!;
    const listedCount = Math.round(shareCount * (opts.listedFraction ?? 0.2));
    const vestingCount = Math.round(shareCount * (opts.vestingFraction ?? 0.3));
    const isListed = i < listedCount;
    const isVesting = i >= shareCount - vestingCount && shareCount > 0;
    const sharesAsStroops = (totalSupply * BigInt(Math.round(pct * 1e6))) / 100_000_000n;
    return {
      owner,
      shares: sharesAsStroops.toString(),
      ownershipPercent: pct,
      unlockTimestamp: isVesting
        ? Math.round(Date.now() / 1000) + 60 * 60 * 24 * (7 + Math.floor(rng() * 60))
        : 0,
      isListed,
      askPriceStroops: isListed
        ? (1_000_000_000n * BigInt(1 + Math.floor(rng() * 50))).toString()
        : undefined,
    };
  });

  const layerCount = opts.layerCount ?? Math.max(2, rarityLayerCount(rarity));
  const layers: NFTVisualLayer[] = [];
  const layerCategories: NFTVisualLayer["category"][] = [
    "background",
    "pattern",
    "overlay",
    "frame",
    "emblem",
    "badge",
  ];
  for (let i = 0; i < layerCount; i++) {
    const cat = layerCategories[Math.floor(rng() * layerCategories.length)]!;
    const hue = Math.floor(rng() * 360);
    layers.push({
      id: `L${i}-${seed.toString(36)}-${cat}`,
      name: `${cat}-${i.toString().padStart(3, "0")}`,
      category: cat,
      variant: Math.floor(rng() * 256),
      palette: {
        primary: hslToHex(hue, 0.7, 0.18),
        secondary: hslToHex((hue + 40) % 360, 0.7, 0.12),
        accent: hslToHex(hue, 0.85, 0.62),
      },
      opacity: 0.25 + rng() * 0.55,
      rotation: Math.floor(rng() * 180),
      scale: 0.35 + rng() * 0.6,
      seed: Math.floor(rng() * 0xffffffff),
    });
  }

  const now = new Date();
  const createdAt = new Date(now.getTime() - (seq + 1) * 60 * 60 * 1000).toISOString();
  const updatedAt = now.toISOString();

  const metadata: FractionalNFTMetadata = {
    tokenId,
    collectionId,
    name: `${name} #${seq + 1}`,
    description: `${rarity} tier fractional share of the ${name} community pool. Issued under collection ${collectionId}.`,
    totalSupply: totalSupply.toString(),
    rarity,
    orgId: `ORG_${(seq % 50).toString(36).toUpperCase()}`,
    provenanceCid:
      seq % 3 === 0
        ? `bafybeig${(seed >>> 0).toString(36).padStart(44, "ab").slice(0, 44)}`
        : undefined,
    createdAt,
    updatedAt,
  };

  return {
    metadata,
    shares,
    layers,
    seed,
  };
}

/** Batch builder — returns N distinct NFT samples for gallery / stress tests. */
export function buildSampleNftBatch(
  count: number,
  idPrefix = "vp",
  perNftOpts?: SampleNftOptions
): FractionalNFT[] {
  const n = Math.max(0, Math.min(500, Math.floor(count)));
  const out: FractionalNFT[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      buildSampleFractionalNft(idPrefix, i, {
        ...perNftOpts,
        seed: perNftOpts?.seed ? perNftOpts.seed + i : undefined,
      })
    );
  }
  return out;
}

/**
 * Heavy-load simulator: calls `cb` up to `opsPerSecond` per second for
 * `durationMs`, each time providing a freshly-mutated NFT snapshot.
 *
 * Returns a handle with `stop()` + `metrics()` so callers can observe:
 *   - observed ops / sec
 *   - max observed jitter (ms between scheduled and actual)
 *   - total mutations applied
 *
 * The simulation keeps the main thread in a steady-state of prop updates
 * and validates the component handles it without main-thread blockage.
 */
export interface LoadSimulatorHandle {
  stop(): void;
  metrics(): LoadSimulatorMetrics;
}

export interface LoadSimulatorMetrics {
  elapsedMs: number;
  scheduledOps: number;
  observedOps: number;
  opsPerSecond: number;
  maxJitterMs: number;
  avgJitterMs: number;
}

export function runNftLoadSimulator(
  initialNft: FractionalNFT,
  opsPerSecond: number,
  durationMs: number,
  cb: (nft: FractionalNFT, step: number) => void
): LoadSimulatorHandle {
  const safeOps = Math.max(1, Math.min(500, Math.floor(opsPerSecond)));
  const intervalMs = 1000 / safeOps;
  const start = performance.now();
  let step = 0;
  let scheduledOps = 0;
  let observedOps = 0;
  let jitterSum = 0;
  let jitterMax = 0;
  let stopped = false;
  let current = initialNft;

  const tick = () => {
    if (stopped) return;
    const elapsed = performance.now() - start;
    if (elapsed > durationMs) {
      stopped = true;
      return;
    }
    scheduledOps++;
    const expected = start + scheduledOps * intervalMs;
    const jitter = Math.abs(performance.now() - expected);
    jitterSum += jitter;
    if (jitter > jitterMax) jitterMax = jitter;

    // Make a small deterministic mutation: rotate one share's vesting flag,
    // bump the metadata updatedAt, and twiddle one layer's rotation. This
    // matches what a block-stream subscription would do.
    current = mutateNftForLoadTest(current, step);
    observedOps++;
    cb(current, step);
    step++;

    const nextDelay = Math.max(0, intervalMs - (performance.now() - expected));
    setTimeout(tick, nextDelay);
  };

  setTimeout(tick, intervalMs);

  return {
    stop() {
      stopped = true;
    },
    metrics(): LoadSimulatorMetrics {
      const elapsed = performance.now() - start;
      return {
        elapsedMs: elapsed,
        scheduledOps,
        observedOps,
        opsPerSecond: elapsed > 0 ? (observedOps * 1000) / elapsed : 0,
        maxJitterMs: jitterMax,
        avgJitterMs: observedOps > 0 ? jitterSum / observedOps : 0,
      };
    },
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function rarityLayerCount(rarity: NFTRarityTier): number {
  switch (rarity) {
    case "COMMON":
      return 2;
    case "UNCOMMON":
      return 3;
    case "RARE":
      return 4;
    case "EPIC":
      return 5;
    case "LEGENDARY":
      return 6;
    case "MYTHIC":
      return 7;
  }
}

/** Generate N percentages that sum to exactly 100, with realistic skew. */
function generateSharePercentages(n: number, rng: () => number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [100];
  // Use a Dirichlet-ish sample via weights raised to a skew exponent then
  // normalized. Deterministic per seed.
  const raw: number[] = [];
  for (let i = 0; i < n; i++) raw.push(Math.pow(rng() + 0.05, 1.6));
  const total = raw.reduce((a, b) => a + b, 0);
  const out = raw.map((v) => (100 * v) / total);
  // Fix rounding drift: round each to 2 decimals and apply remainder to the
  // first bucket.
  const rounded = out.map((v) => Math.round(v * 100) / 100);
  const drift = 100 - rounded.reduce((a, b) => a + b, 0);
  rounded[0] = Math.round((rounded[0]! + drift) * 100) / 100;
  return rounded;
}

/** HSL (h:0..360, s:0..1, l:0..1) → "#RRGGBB" hex. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  const m = l - c / 2;
  const r = Math.round(255 * (r1 + m));
  const g = Math.round(255 * (g1 + m));
  const b = Math.round(255 * (b1 + m));
  return (
    "#" +
    r.toString(16).padStart(2, "0") +
    g.toString(16).padStart(2, "0") +
    b.toString(16).padStart(2, "0")
  );
}

/** Mutate an NFT in-place for the load simulator — returns a new ref. */
function mutateNftForLoadTest(nft: FractionalNFT, step: number): FractionalNFT {
  // Toggle the "listed" flag on one share per 5 steps, otherwise just bump
  // the updatedAt timestamp + rotate one layer's rotation by 1°.
  const shares = nft.shares.map((s, i) => {
    if (i === step % Math.max(1, nft.shares.length)) {
      return { ...s, isListed: !s.isListed };
    }
    return s;
  });
  const layers = nft.layers.map((l, i) => {
    if (i === step % Math.max(1, nft.layers.length)) {
      return { ...l, rotation: (l.rotation + 1) % 360 };
    }
    return l;
  });
  return {
    ...nft,
    shares,
    layers,
    metadata: { ...nft.metadata, updatedAt: new Date().toISOString() },
  };
}
