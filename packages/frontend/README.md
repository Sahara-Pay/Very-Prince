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
