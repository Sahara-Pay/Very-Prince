# Turborepo Remote Cache

This repo uses Turborepo's built-in Vercel Remote Cache so build/lint/test
outputs are shared across machines and (once CI exists) across CI runs,
instead of every environment recomputing them from scratch.

## Local setup

```bash
npx turbo login
npx turbo link
```

This authenticates your local Turbo CLI against Vercel and links this
repo to the correct team scope. No secrets are committed to the repo.

## CI setup (once a CI pipeline exists)

Set these as CI secrets/environment variables:

- `TURBO_TOKEN` — a Vercel access token scoped to this team
- `TURBO_TEAM` — the Vercel team slug this repo is linked to

With both set, `turbo run build` (and any other cached task) will
automatically read from and write to the shared remote cache — no
additional flags needed.
