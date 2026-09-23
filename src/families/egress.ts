import type { OutboundHandler } from '@cloudflare/containers';

// See src/ambient-env.d.ts: static outboundByHost is fixed to Cloudflare.Env
// (ambient) by the base class, not our own Env type, so handlers here are
// typed against the default (Cloudflare.Env), not imported from ../env.

/**
 * Hostnames egress is allowed to. These must be literal strings, not
 * `env.LLM_HOST` / `env.MIRROR_HOST` — `static allowedHosts` / `static
 * outboundByHost` on a Sandbox subclass are evaluated at module load time,
 * before any per-request `env` exists, so they cannot read Worker vars or
 * secrets. Keep these in sync with `wrangler.jsonc`'s `vars.LLM_HOST` /
 * `vars.MIRROR_HOST` by hand (a unit test asserts they match, see
 * `test/unit/egress.test.ts`). The handler *bodies* run per-request and can
 * read `env` freely — only the hostname keys are fixed at load time.
 */
export const LLM_HOST = 'llm.opalix.ai';
export const MIRROR_HOST = 'mirror.opalix.ai';
export const BUNDLES_HOST = 'bundles.opalix.internal';

/**
 * The hosts every lab gets. `setAllowedHosts()` REPLACES the runtime list
 * rather than extending it (and this SDK version has no add-one call), so
 * any per-lab allowlist must be unioned with this or a lab that declares
 * one extra host loses the LLM worker, the package mirror and the bundle
 * server. See session/lifecycle.ts applyEgressAllowlist.
 */
export const BASE_ALLOWED_HOSTS = [LLM_HOST, MIRROR_HOST, BUNDLES_HOST];

/**
 * Every outbound call to the LLM Worker gets the real credential injected
 * here, in the Worker, so the container never holds `LLM_WORKER_KEY`. The
 * container sets `X-Opalix-Session` and `X-Opalix-Session-Token` from
 * `/etc/opalix/session.env` (written at session start, see
 * session/lifecycle.ts); this handler forwards them unchanged so the LLM
 * Worker can verify the session token without a round trip back here.
 */
export const llmOutbound: OutboundHandler = async (request, env) => {
  const forwarded = new Request(request, {
    headers: new Headers(request.headers),
  });
  forwarded.headers.set('Authorization', `Bearer ${env.LLM_WORKER_KEY}`);
  return fetch(forwarded);
};

/** Package mirror: no credential to inject, just a passthrough allowlist entry. */
export const mirrorOutbound: OutboundHandler = async (request) => fetch(request);

/**
 * Serves lab bundle archives from R2 without exposing R2 credentials or a
 * public bucket URL to the container. Used by hydrate.ts as a fallback if
 * writeFile() is too slow for multi-MB archives (spike risk R3); the
 * container does `curl http://bundles.opalix.internal/labs/<slug>/<v>/workspace.tgz`.
 */
export const bundlesOutbound: OutboundHandler = async (request, env) => {
  const url = new URL(request.url);
  const key = url.pathname.replace(/^\/+/, '');
  const obj = await env.LABS_BUCKET.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size) },
  });
};
