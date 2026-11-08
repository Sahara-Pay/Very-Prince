# very-prince

**A Stellar-native multi-organization payout registry for open-source maintainers.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-black?logo=stellar)](https://stellar.org/soroban)
[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)](https://nextjs.org/)

> **Status: testnet only, unaudited.** Do not deploy to mainnet or use real funds
> until the contract has had an independent security review.

## Overview

**very-prince** is an on-chain payout registry built on the Stellar Soroban smart
contract platform. Organizations register on-chain, the community funds a public
budget, and organization admins allocate payouts (optionally on a vesting schedule)
to maintainers. Maintainers claim what has vested directly from the contract with
their own wallet, with no intermediary.

## How it works

1. An organization registers and becomes a budget with one or more admins.
2. Anyone can fund an organization's public budget with the configured Stellar
   Asset Contract (SAC) token.
3. Org admins add maintainers and allocate payouts from the budget, either as a
   single time-locked amount or as a multi-tranche vesting schedule.
4. A maintainer calls `claim_payout`; the contract releases whatever has vested.
5. A protocol admin can pause the protocol in an emergency and upgrade the contract.

The contract also includes a quadratic-funding matching pool; see
[`packages/contracts/README.md`](packages/contracts/README.md) for details.

## Repository layout

This is a [Turborepo](https://turbo.build/) monorepo (npm workspaces).

| Package | Path | Description |
| --- | --- | --- |
| Contracts | `packages/contracts` | Soroban smart contract in Rust (`PayoutRegistry`) |
| Backend | `packages/backend` | Fastify + tRPC API that indexes contract state into PostgreSQL. **Read-only**, never handles keys |
| Frontend | `packages/frontend` | Next.js app with Freighter wallet integration |
| Types | `packages/types` | Shared TypeScript types |
| Docs | `packages/docs` | Docusaurus documentation site |
| AMM math | `packages/amm-math` | Rust math library |

Deeper documentation lives in [`docs/`](docs/) (start with
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).

## Security model: client-side signing only

The backend never requests, stores, or touches private keys. It only serves
indexed state. When a user funds an organization or claims a payout, the frontend
builds the unsigned transaction XDR, the **Freighter** browser extension signs it
locally, and the signed transaction is broadcast directly to the Soroban RPC.

## Prerequisites

| Tool | Version / notes |
| --- | --- |
| [Node.js](https://nodejs.org/) | 20 or newer (npm 10+) |
| [Docker](https://docs.docker.com/get-docker/) | Runs local PostgreSQL 15 and **Redis 7** |
| [Rust](https://rustup.rs/) | With the `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown` |
| [Stellar / Soroban CLI](https://developers.stellar.org/docs/tools/cli) | For building, deploying and invoking the contract |
| [Freighter](https://freighter.app/) | Browser wallet, set to **Testnet** |

> **Redis is required.** The backend uses it for its token-bucket rate limiter.
> If Redis is unavailable the limiter fails open (requests are allowed), so do not
> rely on it as your only protection in production.

## Quick start

```bash
# 1. Clone and install (postinstall runs `prisma generate` for the backend)
git clone https://github.com/Sahara-Pay/Very-Prince.git
cd Very-Prince
npm install

# 2. Configure the environment
cp .env.example .env
# Defaults point at Stellar Testnet and the local Docker services.
# CONTRACT_ID is filled in after you deploy the contract (step 4).

# 3. Start PostgreSQL and Redis
npm run dev:infra

# 4. Build, deploy and initialize the contract (see "Contract" below),
#    then set CONTRACT_ID in .env and NEXT_PUBLIC_CONTRACT_ID in packages/frontend/.env

# 5. Apply database migrations
cd packages/backend && npx prisma migrate deploy && cd ../..

# 6. Run the backend and frontend together
npm run dev
```

- Frontend: <http://localhost:3000>
- Backend API: <http://localhost:3001>
- Stop local services with `npm run stop:infra`.

### Environment variables

Copy `.env.example` to `.env`. The most important values:

| Variable | Purpose | Default in `.env.example` |
| --- | --- | --- |
| `RPC_URL` | Soroban RPC endpoint | Testnet |
| `HORIZON_URL` | Horizon endpoint | Testnet |
| `NETWORK_PASSPHRASE` | Used when signing transactions | `Test SDF Network ; September 2015` |
| `CONTRACT_ID` | Deployed `PayoutRegistry` contract | empty, set after deploy |
| `DATABASE_URL` | PostgreSQL connection string | local Docker database |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `PORT` / `WS_PORT` | Backend HTTP / WebSocket ports | `3001` / `3002` |

The frontend has its own `packages/frontend/.env.example` (all `NEXT_PUBLIC_*`).

## Contract

```bash
cd packages/contracts
cargo test                                   # run the contract tests
cargo build --target wasm32-unknown-unknown --release
./scripts/deploy.sh                          # deploy to testnet; writes CONTRACT_ID to your env files
```

`deploy.sh` only deploys the contract. **You must then call `init`** with the token
(SAC) address, a single protocol admin address, and a threshold of `1`. Do this in
the same step as deployment so nobody else can initialize your instance first.

## Testing

```bash
npm test                 # all packages via Turborepo
npm run lint             # lint all packages
npm run test:readmes     # checks each package has a README
cd packages/contracts && cargo test
```

Frontend end-to-end tests use Playwright (`packages/frontend/e2e`).

## Reviewer walkthrough

1. **Fund your wallet.** In Freighter, switch to **Testnet** and fund the account
   with the Freighter button or the
   [Stellar Laboratory Friendbot](https://laboratory.stellar.org/#account-creator).
2. **Open the dashboard** at <http://localhost:3000> and click **Connect Wallet**.
3. **Look up an organization** by ID in the search bar to see its balance and
   maintainer roster.
4. **Fund the organization.** Click **Fund Org**, enter an amount, and approve the
   transaction in Freighter.
5. **Claim a payout.** If your account has a vested allocation, a highlighted
   balance appears on your maintainer card. Click **Claim Payout** and approve it
   in Freighter.

## Operations

### Database backups

The indexer database should be backed up daily. `scripts/backup.sh` compresses the
database to `.sql.gz` and uploads it to S3. To run it every day at 02:00 UTC, add to
your production crontab (`crontab -e`):

```cron
0 2 * * * source /path/to/.env && /path/to/Very-Prince/scripts/backup.sh >> /var/log/very-prince-backup.log 2>&1
```

`PGUSER`, `PGPASSWORD`, `PGDATABASE` and `BACKUP_S3_BUCKET` must be set, and the AWS
CLI must be configured with suitable IAM permissions. See also
`scripts/verify-backup.sh` and `scripts/pitr-restore.sh`.

### Multi-arch Docker builds

Backend and frontend images build for `linux/amd64` and `linux/arm64` with Buildx:

```bash
docker buildx create --use --name very-prince-builder
docker run --privileged --rm tonistiigi/binfmt --install all
docker buildx bake
```

### Staging, Kubernetes and Terraform

Infrastructure for staging and production lives in `docker-compose.staging.yml`,
`k8s/`, `terraform/` and the `Jenkinsfile`. See [`docs/STAGING.md`](docs/STAGING.md).

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
branching model, how to add a contract function, API endpoint or frontend page, and
the pull request process. Report security issues privately, following the
"Security Disclosures" section of `CONTRIBUTING.md`, **not** in public issues.

## License

[MIT](https://opensource.org/licenses/MIT)