/**
 * @file vitest.setup.ts
 * @description Global Vitest setup.
 *
 * `src/config/env.ts` validates `process.env` at module load time and requires
 * a handful of secrets that only exist in real deployments. This setup runs
 * before any test file (and therefore before any module import), so test
 * suites that transitively import `env.ts` get a valid environment without
 * needing a `.env` file on the CI/local machine.
 */

process.env.JWT_SECRET ??= "vitest-jwt-secret-0123456789abcdef0123456789abcdef";
process.env.RESEND_API_KEY ??= "re_vitest_key_0123456789";
process.env.RPC_URL ??= "https://soroban-testnet.stellar.org";
process.env.NODE_ENV ??= "test";
