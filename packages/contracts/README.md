# Contracts Package

The contracts package contains the Soroban smart contract implementation for the Very-Prince payout registry. It manages multi-organization funding, escrow-style public budgets, and maintainer payout allocation logic.

## What this package does

- Defines the on-chain registry for organizations and maintainers.
- Tracks public funding and payout balances for each organization.
- Runs an on-chain quadratic funding vault with integer-only matching math.
- Enforces payout claims through Stellar-native authorization flows.
- Provides contract tests for the grant and payout lifecycle.

## Quadratic funding vault

The contract exposes a quadratic funding flow that stays fully deterministic on-chain:

- `verify_humanity` and `revoke_humanity` let the protocol admin issue non-transferable proof-of-humanity verification records with issuer and timestamp metadata.
- `qf_deposit_matching_pool` transfers tokens into the shared matching pool.
- `qf_contribute` accepts verified-human project contributions, stores each human's cumulative contribution, and updates project `sqrt_sum` incrementally.
- `qf_preview_distribution` computes `pool * project_weight / total_weight`, where `project_weight = sum(isqrt(cumulative_human_contribution))^2`.
- `qf_distribute` moves the computed matching amounts into existing organization budgets so normal payout allocation can continue.

All quadratic calculations use integer arithmetic. The exported `isqrt` method mirrors Python's `math.isqrt` semantics and avoids floating-point operations in WASM.

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
