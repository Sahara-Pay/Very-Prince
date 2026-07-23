/**
 * Next.js configuration for the Very-prince frontend.
 *
 * Key notes:
 * - `NEXT_PUBLIC_*` variables are inlined at build time and safe for the browser.
 * - The Soroban RPC and contract ID are public — secrets never go here.
 * - PWA is enabled via next-pwa. Service worker is generated at build time.
 *   POST endpoints and wallet interactions are excluded from the cache strategy.
 */
import withPWA from "next-pwa";

const pwaConfig = withPWA({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  skipWaiting: true,
  // Serve a branded offline page when the network is unavailable.
  fallbacks: {
    document: "/offline.html",
  },
  // Only cache GET requests — never cache POST/wallet/webhook endpoints.
  runtimeCaching: [
    {
      urlPattern: /^https:\/\/api\.tradeflow\.app\/orgs/,
      handler: "NetworkFirst",
      options: {
        cacheName: "api-orgs",
        expiration: { maxEntries: 50, maxAgeSeconds: 60 },
      },
    },
    {
      urlPattern: /\/_next\/static\/.*/,
      handler: "CacheFirst",
      options: {
        cacheName: "next-static",
        expiration: { maxEntries: 200, maxAgeSeconds: 86400 },
      },
    },
    {
      urlPattern: /\/_next\/image\?.*/,
      handler: "CacheFirst",
      options: {
        cacheName: "next-image",
        expiration: { maxEntries: 50, maxAgeSeconds: 86400 },
      },
    },
  ],
});

/**
 * Cross-origin isolation headers (COOP / COEP) required for `SharedArrayBuffer`
 * support. They are applied project-wide so any page that mounts the
 * off-main-thread crypto-signing sandbox (#381) can construct the
 * `SharedArrayBuffer` it uses for IP C with the dedicated signing worker.
 *
 * - `Cross-Origin-Opener-Policy: same-origin` puts the page in a fresh
 *   browsing-context group, isolated from other origins.
 * - `Cross-Origin-Embedder-Policy: require-corp` requires any subresource
 *   to opt-in via CORP / CORS before being loaded.
 *
 * Without both, `self.crossOriginIsolated` is `false` and the sandbox
 * will refuse to boot.
 */
const CROSS_ORIGIN_ISOLATION_HEADERS = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Cross-origin isolation — required for the off-main-thread
  // SharedArrayBuffer/Atomics crypto-signing sandbox
  // (see `src/crypto-sandbox/`). Applied to every route via `headers()`
  // below so dev mode AND production get the same isolation guarantees.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: CROSS_ORIGIN_ISOLATION_HEADERS,
      },
    ];
  },
  // Vercel's edge network optimizes and caches images automatically once
  // `images` is configured — this keeps optimization off the Node server.
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.veryprince.com",
      },
      {
        protocol: "https",
        hostname: "res.cloudinary.com",
      },
    ],
    formats: ["image/avif", "image/webp"],
  },

  // Expose network config to the browser bundle.
  env: {
    NEXT_PUBLIC_HORIZON_URL:
      process.env["NEXT_PUBLIC_HORIZON_URL"] ??
      "https://horizon-testnet.stellar.org",
    NEXT_PUBLIC_RPC_URL:
      process.env["NEXT_PUBLIC_RPC_URL"] ??
      "https://soroban-testnet.stellar.org",
    NEXT_PUBLIC_NETWORK_PASSPHRASE:
      process.env["NEXT_PUBLIC_NETWORK_PASSPHRASE"] ??
      "Test SDF Network ; September 2015",
    NEXT_PUBLIC_CONTRACT_ID: process.env["NEXT_PUBLIC_CONTRACT_ID"] ?? "",
    NEXT_PUBLIC_API_URL:
      process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001",
  },

  // Webpack — required so modules that use Node.js built-ins (like `stellar-sdk`)
  // degrade gracefully in the browser bundle.
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".js", ".ts", ".tsx"],
    };
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      crypto: false,
    };
    // Allow ESM-style .js imports to resolve to .ts files
    // (needed for @very-prince/types which uses "type": "module").
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    return config;
  },
};

export default pwaConfig(nextConfig);
