import { fileURLToPath } from 'node:url';
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
  resolve: {
    alias: {
      // `cloudflare:workers` only resolves inside workerd, so anything that
      // extends DurableObject (src/do/pool.ts) is unimportable here without
      // this. The stand-in supplies the ctx/env constructor and nothing else.
      'cloudflare:workers': fileURLToPath(new URL('./test/fakes/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
