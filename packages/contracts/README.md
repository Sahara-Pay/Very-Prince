# Contracts Package

The contracts package contains the Soroban smart contract implementation for the Very-Prince payout registry. It manages multi-organization funding, escrow-style public budgets, and maintainer payout allocation logic.

## What this package does

- Defines the on-chain registry for organizations and maintainers.
- Tracks public funding and payout balances for each organization.
- Enforces payout claims through Stellar-native authorization flows.
- Provides contract tests for the grant and payout lifecycle.

## Prerequisites

- Rust toolchain
- The wasm32 target for Soroban contracts
- The Soroban CLI for building and interacting with contracts

## Build and test

From the package directory:

```bash
cd packages/contracts
cargo test
cargo build --target wasm32-unknown-unknown
```

## Development notes

- Keep contract logic deterministic and gas-efficient.
- Validate authorization paths carefully because payout claims are security-sensitive.
- Prefer small, focused tests around funding, payout allocation, and claim behavior.

## Deployment considerations

Deployment and contract interaction should be handled with the Soroban CLI and the appropriate network configuration. Review the workspace documentation before deploying to a shared environment.
