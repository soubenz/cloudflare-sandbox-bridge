import { defineConfig } from 'vitest/config';

// Runs against a live Worker (local `wrangler dev` with Docker, or staging).
// Set BASE_URL and OPALIX_KEY in the environment before running.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
