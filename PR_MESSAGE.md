# Add snapshot testing for key Next.js UI components

## Overview
This PR adds snapshot testing for key Next.js UI components and addresses several critical configuration and compatibility issues in the existing vitest setup on Windows environments.

## What changed
- **Snapshot Tests**: Created new snapshot tests in `packages/frontend/src/components/__tests__/snapshots.test.tsx` covering:
  - `GlassButton` (Primary and Secondary buttons/links)
  - `GlassPanel` (With custom class names and children)
  - `OrganizationSkeletonCard` (Visual loading state)
  - `EmptyMaintainersState` (Premium empty state for registered organizations)
- **Vitest Config Fix**: Cleaned up conflicting duplicate imports and invalid syntax inside `vitest.config.ts`.
- **Mocking and Matcher Resolutions**:
  - Replaced `jest.mock` / `jest.Mock` with `vi.mock` / `vi.mocked` in `dashboardOrgPage.test.tsx` for proper Vitest integration.
  - Added `@testing-library/jest-dom` import in `XdrDebugPanel.test.tsx` to enable the `toBeInTheDocument` matcher.
  - Structured test mock variables in `sorobanClient.test.ts` within `vi.hoisted` blocks to prevent TDZ ReferenceErrors caused by Vitest's hoisting transform.
  - Made the `beforeEach` block in `sorobanClient.test.ts` async to support `await import`.
- **Skeleton Component Update**: Added `data-testid="organization-skeleton"` to `OrganizationSkeletonCard` to satisfy existing test assertions.
- **Dependencies Management**: Added missing transitive testing/styling devDependencies directly in `packages/frontend/package.json` to ensure clean installation on Windows.

## Why
Adding snapshot testing captures the HTML output of key UI components, ensuring any future layout or styling changes are caught immediately. Fixing existing test setup blocks prevents developer friction and provides a robust verification suite.

## Verification
- Ran `npm run test` in `packages/frontend`
- Result: 9 test files passed, 50 tests passed (including 6 new written snapshots), 0 failed
