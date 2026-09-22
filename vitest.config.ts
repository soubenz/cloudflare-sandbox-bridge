import { defineConfig } from 'vitest/config';

/**
 * Plain Node pool, not @cloudflare/vitest-pool-workers: everything under
 * test/unit is pure logic (manifest parsing/templating, token mint/verify,
 * the timer scheduler, check-output parsing) exercised against hand-built
 * fakes (test/fakes/), not against Miniflare. The Session/Pool Durable
 * Objects bind real Cloudflare Containers, which Miniflare can only run
 * with a local Docker daemon — not available in every dev/CI environment
 * (this repo's own sandbox included) — so DO-level and container-level
 * behavior is verified in the integration suite (vitest.integration.config.ts)
 * against `wrangler dev` or staging instead. See docs/spike.md.
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
