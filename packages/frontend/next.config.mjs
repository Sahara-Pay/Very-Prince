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

/** @type {import('next').NextConfig} */
const nextConfig = {
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
    return config;
  },
};

export default pwaConfig(nextConfig);
