import { defineConfig } from 'vitest/config';

// Runs against a live Worker (local `wrangler dev` with Docker, or staging).
// Set OPALIX_URL and OPALIX_KEY in the environment before running.
//
// Do not name the URL variable BASE_URL: Vite defines `import.meta.env.BASE_URL`
// from its `base` option, and vitest backs `import.meta.env` with `process.env`,
// so a shell-exported BASE_URL silently becomes "/" inside every test.
if (!process.env.OPALIX_URL || !process.env.OPALIX_KEY) {
  throw new Error(
    'Integration tests need OPALIX_URL and OPALIX_KEY set (e.g. OPALIX_URL=https://opalix-sandbox.<subdomain>.workers.dev).',
  );
}

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
