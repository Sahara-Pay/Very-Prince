import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/tests/vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // Diagnostic scripts meant to be run manually via `npx tsx` (they call
    // process.exit and write heap snapshots; see their file headers).
    exclude: ['src/tests/memory-baseline.test.ts', 'src/tests/streaming-verification.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/tests/**'],
    },
  },
});
