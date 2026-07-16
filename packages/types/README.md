# Types Package

The types package contains the shared TypeScript interfaces and domain models used across the monorepo. Centralizing these definitions helps keep the backend, frontend, and contract-adjacent integrations aligned.

## What this package does

- Provides shared schema and type definitions for the monorepo.
- Reduces duplication across frontend and backend code.
- Makes cross-package contracts easier to maintain as the platform evolves.

## Usage

This package is consumed by other workspace packages through the workspace dependency setup. Add shared models here when they need to be referenced by more than one package.

## Development notes

- Keep exports straightforward and easy to import.
- Prefer stable, documented interfaces over ad-hoc local types.
- Update consumers when shared types change.

## Validation

The package can be type-checked with:

```bash
cd packages/types
npm run lint
```
