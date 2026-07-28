# Implement differential synchronization for tRPC payload minimization (#403)

## Overview
This PR implements client/server differential synchronization for tRPC procedures to minimize API payload size. Instead of transmitting full objects (e.g., organization profiles and registries) repeatedly, the system now computes JSON Patches (RFC 6902) against the client's last known state, transmitting only the mutated fields over the wire.

## What Changed
- **JSON Diff/Patch Engine**:
  - Implemented `compare` (generating RFC 6902 JSON Patches), deterministic stringification (`deterministicStringify`), and cyrb53 hashing (`cyrb53`) in `packages/backend/src/trpc/diff.ts`.
  - Implemented `applyPatch` (applying RFC 6902 JSON Patches) in `packages/frontend/src/trpc/diff.ts`.
- **Backend context & caching**:
  - Defined `TRPCContext` containing the optional `stateHash` in `packages/backend/src/trpc/router.ts`.
  - Updated Fastify server `/trpc/:path` handler in `packages/backend/src/trpc/server.ts` to:
    - Pass the client's `x-state-hash` header into the tRPC context.
    - Invoke procedures type-safely via `appRouter.createCaller(ctx)`.
    - Cache query states in Redis under `state_hash:${hash}` keys (1 hour TTL) using the safe Redis wrapper.
    - Return a wrapped envelope containing status: `no_change` (identical hashes), `diff` (JSON Patch list), or `full` (complete payload).
- **Frontend Link Interception**:
  - Added custom `diffSyncLink` in `packages/frontend/src/trpc/client.ts` to track state hashes, append the `x-state-hash` header, intercept query responses, and apply JSON Patches dynamically.
  - Aligned tRPC client by switching from `httpBatchLink` to `httpLink` for routing request headers specifically for each request.

## Verification
- Created comprehensive unit tests for hashing/patching in `packages/backend/src/tests/diffSync.test.ts`.
- Created integration tests in `packages/backend/src/tests/diffSyncServer.test.ts` to verify the Fastify request lifecycle routing (returning correct sync statuses and patch contents).
- Created client-side unit tests in `packages/frontend/src/trpc/__tests__/diffSyncClient.test.ts`.
- Ran unit & integration tests on both packages:
  - `npx vitest run src/tests/diffSync` in backend -> **6 tests passed**
  - `npx vitest run src/trpc/__tests__` in frontend -> **2 tests passed**
- Verified monorepo builds successfully with complete type-safety.
