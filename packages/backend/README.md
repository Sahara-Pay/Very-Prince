# Backend Package

The backend package provides the read-oriented API and metadata services for the Very-Prince platform. It connects the frontend to Soroban contract state without handling user private keys or signing transactions on the server.

## What this package does

- Exposes Fastify-based endpoints for organization, maintainer, and payout data.
- Reads contract state from the Soroban RPC and normalizes it for UI consumption.
- Stores supporting metadata and indexing data for fast queries.
- Acts as a thin, secure gateway for frontend read traffic.

## Architecture highlights

- Built with Fastify and TypeScript.
- Uses Prisma for persisted metadata and indexing data.
- Uses tRPC-style server wiring for structured API access.
- Keeps wallet signing entirely client-side.

## Prerequisites

- Node.js 20+
- npm 10+
- Access to the local infrastructure used by the workspace (database and supporting services)

## Quick start

From the repository root:

```bash
npm install
npm run dev --workspace @very-prince/backend
```

From the package directory, the equivalent commands are:

```bash
cd packages/backend
npm run dev
```

## Common scripts

```bash
npm run build
npm run test
npm run lint
```

## Development notes

- The backend is intended for read-heavy and metadata workflows rather than transaction execution.
- Keep wallet interaction and signing in the frontend or browser extension.
- Prefer small, typed API responses so the frontend can render data reliably.

## Testing

The package uses Vitest for automated tests. Add coverage for route handlers, serializers, and contract-state adapters when changing API behavior.
