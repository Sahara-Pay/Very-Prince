# Docs Package

The docs package contains the Docusaurus website for Very-Prince. It is the primary place for product, architecture, and contributor-facing documentation.

## What this package does

- Hosts the public documentation site for the project.
- Organizes guides for setup, contribution, and platform concepts.
- Supports local previewing and static-site builds for deployment.

## Prerequisites

- Node.js 20+
- npm 10+

## Quick start

From the repository root:

```bash
npm install
npm run start --workspace @very-prince/docs
```

Or from the package directory:

```bash
cd packages/docs
npm run start
```

## Common scripts

```bash
npm run build
npm run start
npm run typecheck
npm run serve
```

## Development notes

- Keep the documentation concise and practical for contributors and reviewers.
- Prefer updating docs alongside code changes when behavior or setup changes.
- Use the docs site for high-level architecture context rather than implementation details that belong in package-level README files.
