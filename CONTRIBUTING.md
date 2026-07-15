# Contributing to Very-prince

Thank you for your interest in contributing! Very-prince is an open-source infrastructure project built on Stellar Soroban. We welcome contributions of all kinds — from fixing typos to implementing new contract features.

---

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Getting Started](#getting-started)
3. [Branching & Commits](#branching--commits)
4. [How to Add a New Contract Function (end-to-end)](#how-to-add-a-new-contract-function-end-to-end)
5. [How to Add a New API Endpoint](#how-to-add-a-new-api-endpoint)
6. [How to Add a New Frontend Page or Component](#how-to-add-a-new-frontend-page-or-component)
7. [Running Tests](#running-tests)
8. [Pull Request Process](#pull-request-process)
9. [Security Disclosures](#security-disclosures)

---

## Code of Conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) Code of Conduct. By participating you agree to uphold a welcoming, harassment-free environment.

---

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/Very-prince.git
   cd Very-prince
   ```
3. **Install dependencies** (see README Prerequisites section first):
   ```bash
   npm install
   ```
4. **Copy the environment template:**
   ```bash
   cp .env.example .env
   # Fill in CONTRACT_ID after running deploy.sh
   ```
5. **Verify setup:**
   ```bash
   # Test the contract (Rust)
   cd packages/contracts && cargo test

   # Build all TypeScript packages
   npm run build
   ```

---

## Branching & Commits

| Branch | Purpose |
|---|---|
| `main` | Stable, released code. Direct pushes prohibited. |
| `develop` | Integration branch. All PRs target this. |
| `feature/<name>` | New features or enhancements. |
| `fix/<issue-number>-<short-desc>` | Bug fixes linked to a GitHub Issue. |
| `docs/<name>` | Documentation-only changes. |

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer: Closes #<issue>]
```

**Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`
**Scopes:** `contracts`, `backend`, `frontend`, `root`

**Examples:**
```
feat(contracts): add remove_maintainer function
fix(backend): handle missing CONTRACT_ID gracefully
docs(readme): update deploy instructions for CLI v21
```

---

## How to Add a New Contract Function (end-to-end)

This is the most impactful type of contribution. Follow all four steps.

### Step 1 — Contract (`packages/contracts/src/lib.rs`)

1. If you need a new data structure, add it as a `#[contracttype]` enum or struct *before* the `PayoutRegistry` struct.
2. Add the new function to the `#[contractimpl]` block. Follow the existing patterns:
   - Gate access with `address.require_auth()` wherever a specific Stellar address must authorise the call.
   - Use `env.storage().persistent()` for data that must survive ledger expiry.
   - Emit an event via `env.events().publish(...)` so off-chain indexers can react.
   - Add inline doc comments explaining each parameter and panic condition.
3. Add unit tests in the `#[cfg(test)]` block — at minimum, one happy path and one test per panic condition.

```rust
// Example skeleton:
pub fn remove_maintainer(env: Env, org_id: Symbol, maintainer: Address) {
    let admin: Address = env.storage().persistent()
        .get(&DataKey::OrgAdmin(org_id.clone()))
        .expect("organization not found");
    admin.require_auth();
    // ... implementation ...
    env.events().publish(
        (symbol_short!("registry"), symbol_short!("mnt_rmvd")),
        (org_id, maintainer),
    );
}
```

4. Run tests: `cargo test`
5. Run clippy: `cargo clippy --target wasm32-unknown-unknown -- -D warnings`

### Step 2 — Backend Service (`packages/backend/src/services/stellarService.ts`)

Add a corresponding method to `StellarService`:

- For **read-only** operations: use `_simulateContractCall`.
- For **state-changing** operations: use `_submitContractCall`.

```typescript
async removeMaintainer(orgId: string, maintainer: string, signerSecret: string) {
  return this._submitContractCall("remove_maintainer", [
    nativeToScVal(orgId, { type: "symbol" }),
    nativeToScVal(maintainer, { type: "address" }),
  ], signerSecret);
}
```

### Step 3 — Backend Controller & Route

Add a method to `contractController.ts`, then a new route in `routes/contract.ts`:

```typescript
// routes/contract.ts
fastify.delete<{ Params: { orgId: string; address: string } }>(
  "/orgs/:orgId/maintainers/:address",
  // ...schema, handler
);
```

### Step 4 — Frontend

If the new operation needs UI:

1. Add a new call in `sorobanClient.ts` (for reads) or call the backend via `fetch()` (for writes).
2. Add a new component in `src/components/` or extend an existing page.

---

## How to Add a New API Endpoint

1. **Define a Zod schema** for request validation in `routes/contract.ts`.
2. **Add the Fastify route** with an OpenAPI-compatible `schema` object (for future Swagger docs).
3. **Add a controller method** in `contractController.ts` that calls the service.
4. **Write a test** in `vitest` that mocks `stellarService` and asserts the correct response shape.

---

## How to Add a New Frontend Page or Component

### New Component

1. Create the file in `packages/frontend/src/components/<ComponentName>.tsx`.
2. Mark as `"use client"` only if the component uses browser APIs, React hooks, or event handlers.
3. Export a single named function component.
4. Use Tailwind utility classes — prefer the `glass-card` and `gradient-text` utilities from `globals.css`.

### New Page

1. Create `packages/frontend/src/app/<route>/page.tsx`.
2. Export a default function component.
3. Export a `metadata` object for SEO.
4. Use the `WalletButton` in the nav if the page requires wallet access — gate content with the `isConnected` state from `useFreighter`.

---

## Running Tests

```bash
# All tests (via Turborepo)
npm test

# Contract tests only
cd packages/contracts && cargo test

# Backend tests only
cd packages/backend && npm test

# Frontend tests only
cd packages/frontend && npm test
```

---

## Pull Request Process

1. **Open a GitHub Issue first** (use the provided templates) to discuss the change before spending time implementing it.
2. **Branch** off `develop` using the naming convention above.
3. **Keep PRs focused** — one feature or fix per PR. Large PRs are hard to review and harder to revert.
4. **Update documentation:** If you add a contract function, update the Contract Reference table in `README.md`.
5. **Ensure CI passes** — the CI pipeline must be green before a PR can be merged.
6. **Request a review** from a maintainer. PRs require at least one approval.
7. Maintainers squash-merge to `develop` to keep a clean history.

### PR Checklist

Before opening your PR, make sure:

- [ ] `cargo test` passes locally.
- [ ] `cargo clippy -- -D warnings` emits no warnings.
- [ ] `npm run build` succeeds.
- [ ] `npm run lint` passes.
- [ ] New public contract functions have doc comments.
- [ ] New unit tests are added for all new behaviour.
- [ ] `README.md` Contract Reference table is updated (if applicable).
- [ ] Wallet interactions are manually tested according to the [QA Checklist](docs/QA_WALLET_INTERACTIONS.md) (if applicable).

---

## Security Disclosures

Please **do not** open public GitHub Issues for security vulnerabilities. Instead, use GitHub's [private Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) feature so we can coordinate a fix before public disclosure.
