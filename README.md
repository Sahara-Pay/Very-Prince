<div align="center">
  <h1>✨ very-prince</h1>
  <p><strong>A Stellar-Native Multi-Organization Payout Registry</strong></p>

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
  [![Stellar](https://img.shields.io/badge/Stellar-Soroban-black?logo=stellar)](https://stellar.org/soroban)
  [![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js)](https://nextjs.org/)
</div>

<br />

## 📖 Project Overview

**very-prince** is a decentralized, on-chain payout registry built natively on the Stellar Soroban smart contract platform. It provides a transparent, secure, and highly efficient system for multi-organization maintenance payouts tailored for the open-source community.

By leveraging Stellar Asset Contracts (SAC), organizations can register, build a public budget through community funding, and allocate testnet tokens to open-source maintainers. Maintainers interact directly with the smart contract via their self-custody wallets to claim their accumulated payouts, completely eliminating intermediaries.

## 🏗️ Architecture & Security

This project is structured as a **Turborepo** monorepo consisting of three main packages:

1. **Soroban Smart Contract (`packages/contracts`)**: Written in Rust, it manages organization registration, public budget ESCROW, and maintainer payout allocations. It heavily utilizes Stellar's native auth framework.
2. **Fastify Backend (`packages/backend`)**: A robust Node.js backend used strictly for **read-only operations**. It indexes contract state directly from the Soroban RPC to serve data to the frontend rapidly and acts as a gateway for metadata.
3. **Next.js Frontend (`packages/frontend`)**: A highly polished, responsive Next.js web application equipped with dynamic Glassmorphism styling and seamless Freighter wallet integration.

### 🔐 Security Posture: Strict Client-Side Signing
Following standard Web3 best practices, **our localized Fastify Backend never handles, requests, or touches user private keys.** 
The backend serves strictly to deliver state. When a user executes a mutating transaction (such as funding an organization or claiming a payout), the Next.js Frontend asynchronously prepares the raw, unsigned Transaction XDR. The payload is then sent entirely to the **Freighter Browser Extension** which securely handles the transaction footprint and signature locally before broadcasting it natively to the Soroban RPC.

## ⚙️ Prerequisites

To run and evaluate the application locally, please ensure you have the following installed:

- **[Node.js](https://nodejs.org/)** (v20+ recommended)
- **[Rust Toolchain](https://rustup.rs/)** (with `wasm32-unknown-unknown` target installed)
- **[Soroban CLI](https://soroban.stellar.org/docs/getting-started/setup)** (for contract interactions)
- **[Freighter Wallet Extension](https://freighter.app/)** installed in your browser. Configure it to the **Testnet** network.

## 🚀 Quick Start Guide

The repository utilizes Turborepo to handle fast, concurrent package management. Follow these commands to spin up the entire application end-to-end.

1. **Clone and Install Dependencies**
   ```bash
   git clone https://github.com/your-org/very-prince.git
   cd very-prince
   npm install
   ```

2. **Build the Workspace**
   Compile both the Next.js frontend and Fastify backend safely.
   ```bash
   npm run build
   ```

3. **Spin Up the Local Environment**
   Launch both the Next.js client UI and Fastify API server concurrently.
   ```bash
   npm run dev
   ```

The dashboard will be available at **`http://localhost:3000`** while the backend securely serves read requests on `http://localhost:3001`.

## 🧪 Testing the Application (Reviewer Walkthrough)

To thoroughly evaluate the Wave 4 grant capabilities, follow this user journey:

1. **Fund Your Wallet:**
   Unlock your Freighter wallet, switch to the `Testnet` network, and ensure your account is funded. (You can acquire testnet XLM directly inside the Freighter extension or via the [Stellar Laboratory Friendbot](https://laboratory.stellar.org/#account-creator)).
2. **Access the Dashboard:**
   Navigate your browser to `http://localhost:3000` and click the **Connect Wallet** button in the header.
3. **Lookup an Organization:**
   In the Dashboard search bar, type in an existing organization ID (e.g., `stellar` if you deployed the testing seeds) to view its details, current balance, and maintainer roster.
4. **Fund the Organization:**
   Click the **Fund Org** button. A modal will prompt you. Enter an amount of XLM to donate to the organization's public budget. Confirm the request and approve the transaction payload securely inside the Freighter prompt.
5. **Claim a Due Payout:**
   If your current Freighter account has been allocated a payout, you will see a highlighted balance on your specific Maintainer Card. Click the **Claim Payout** button directly on your card, approve the transaction in Freighter, and instantly watch the smart contract transfer the XLM to your self-custody wallet!

---
## 🗄️ Operations: Database Backups

To prevent data loss, the PostgreSQL indexer database must be backed up daily. A script is provided at `scripts/backup.sh` that compresses the database to `.sql.gz` and securely transfers it to an AWS S3 bucket.

**Production Server Cron Setup:**
To execute this script automatically every day at 2:00 AM UTC, add the following to your production server's crontab (`crontab -e`):

```cron
# Run database backup daily at 02:00 AM
0 2 * * * source /path/to/.env && /path/to/very-prince/scripts/backup.sh >> /var/log/very-prince-backup.log 2>&1
```
Note: Ensure PGUSER, PGPASSWORD, PGDATABASE, and BACKUP_S3_BUCKET are set in the environment where the cron job executes, and that the AWS CLI is configured with the correct IAM roles.

## Multi-arch Docker builds

Backend and frontend images build for both `linux/amd64` and `linux/arm64` via Docker Buildx:

```bash
docker buildx bake
```

Requires a Buildx builder with QEMU emulation enabled for cross-platform builds:
```bash
docker buildx create --use --name very-prince-builder
docker run --privileged --rm tonistiigi/binfmt --install all
```