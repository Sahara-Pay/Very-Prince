# React Query Response Hashing

## Description
Calculate cryptographic hashes of tRPC responses on the client side to conditionally skip expensive React re‑renders if the fetched blockchain state hasn't genuinely mutated.

## Architecture & Context
React Query frequently triggers component re‑renders during background refetches, even if the resulting JSON is identical. Hashing the payload allows the frontend to definitively abort the React reconciliation phase if the data is unchanged.

## Technical Requirements
- Implement a lightweight hashing function tied to React Query's `select` or `isDataEqual` callbacks.
- Store hashes efficiently in memory.
- Ensure deep equality checks are bypassed in favor of the fast O(1) hash comparison.

## Acceptance Criteria
- Unchanged background data fetches trigger absolutely zero React renders.
- Client CPU consumption drops during aggressive polling intervals.
- Hash calculations are extremely fast and do not introduce overhead.

## Implementation Details
- Added `src/utils/hash.ts` exposing `hashObject(value): string` – a fast deterministic hash based on `JSON.stringify`.
- Updated all `useQuery` hooks in `src/hooks/useTRPCQuery.ts` to include:
  ```ts
  isDataEqual: (oldData, newData) => hashObject(oldData) === hashObject(newData)
  ```
- Updated the frontend test script to `"test": "npx vitest run"` for reliable execution.

## How to Verify
1. Run the test suite: `npm run test --workspace packages/frontend` – all tests should pass.
2. In the UI, enable background polling; observe that components do **not** re‑render when the fetched data remains unchanged (use React DevTools to confirm).
3. Measure CPU usage during aggressive polling – it should be noticeably lower.

## Impact
- Improves performance with zero breaking changes.
- No new runtime dependencies; the hash utility is lightweight.
- Future tRPC queries should follow the same `isDataEqual` pattern for optimal rendering behavior.
