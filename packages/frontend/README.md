# Frontend Package

The frontend package is the user-facing web application for Very-Prince. It provides the dashboard experience for browsing organizations, viewing payout information, and initiating wallet-driven contract interactions.

## What this package does

- Renders the Next.js application shell and pages for the payout registry experience.
- Connects to Stellar wallets such as Freighter for signing and broadcasting transactions.
- Presents organization, maintainer, and payout data through a polished, responsive UI.
- Coordinates with the backend for read-only data and metadata delivery.

## Stack

- Next.js
- React
- Tailwind CSS
- tRPC client integration
- Stellar Freighter wallet support

## Prerequisites

- Node.js 20+
- npm 10+
- A browser with the Freighter wallet extension installed and configured for Stellar testnet

## Quick start

From the repository root:

```bash
npm install
npm run dev --workspace @very-prince/frontend
```

Or from the package directory:

```bash
cd packages/frontend
npm run dev
```

## Common scripts

```bash
npm run build
npm run test
npm run test:e2e
npm run lint
```

## Wallet flow

The frontend prepares unsigned transaction payloads and sends them to the wallet extension for signing. The backend does not request or store private keys.

## Testing

Use Vitest for unit and component-level tests and Playwright for browser-based end-to-end coverage.

## Image Optimization

Images are optimized and cached at Vercel's edge network via the `images` config
in `next.config.mjs`. When adding new remote image sources, add their hostname to
`images.remotePatterns` — otherwise Next.js will refuse to optimize them.

## Custom Date-Range Picker

The dashboard features a custom **Date-Range Picker** integrated into the `FundingHistoryChart` to filter cumulative organization funding events.

### Design Decisions
- **Client-Side Filtering**: Events are fetched in full, and date range filtering is processed client-side. This keeps updates instantaneous and, crucially, preserves the running cumulative sum values (`cumulativeXlm` and `cumulativeStroops` pre-calculated by the indexer backend) of each event dot on the chart.
- **Preset Ranges**: Supports fast-selection buttons: `All Time`, `Last 7 Days`, `Last 30 Days`, and `Last 90 Days`.
- **Custom Range Selection**: Offers styled HTML5 date picker inputs with validation (preventing start dates from being set after end dates).
- **Responsive Layout**: Designed with fluid Tailwind structures that adapt seamlessly between desktop and mobile devices.