# Add package-level README documentation for Turborepo packages

## Overview
This pull request adds comprehensive README files for each individual package in the Turborepo workspace to improve onboarding, package discoverability, and developer experience.

## What changed
- Added package-specific documentation for:
  - backend
  - frontend
  - contracts
  - types
  - docs
- Added a lightweight regression test to ensure each package continues to ship a README file.
- Wired the check into the root package scripts for easy reuse.

## Why
The monorepo had strong top-level documentation, but the individual packages lacked clear package-level guidance. This change makes it easier for contributors and reviewers to understand each package’s purpose, tools, and workflows without digging through the repository structure.

## Verification
- Ran `npm run test:readmes`
- Result: 5 tests passed, 0 failed

## Notes
- No production code paths were changed.
- No new YAML or infrastructure configuration was introduced.
