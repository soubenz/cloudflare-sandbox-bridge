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
export const LLM_HOST = 'gateway.ai.cloudflare.com';
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
 * Model calls go to Cloudflare AI Gateway, and the credential is injected
 * here so the container never holds it. Lab code calls the gateway's
 * OpenAI-compatible endpoint with no key at all; this handler adds one.
 *
 * `Authorization`, **not** `cf-aig-authorization`. The AI Gateway docs
 * present the latter as the gateway credential and warn that using
 * `Authorization` is the top cause of 401s — for a Workers AI model on
 * `/compat` it is the other way round, measured against a live gateway:
 * `cf-aig-authorization` alone returns 401 and plain `Authorization`
 * returns 200 (see the AI Gateway section of docs/spike.md). That header
 * applies to gateways with authenticated-gateway mode on, which ours is
 * not; if that is ever turned on, both are needed.
 *
 * The session headers the container sets from `/etc/opalix/session.env`
 * are forwarded unchanged. AI Gateway ignores them, but they are what a
 * later fault-injection Worker in front of the gateway would key on, and
 * dropping them here would make that a breaking change rather than an
 * additive one.
 */
export const llmOutbound: OutboundHandler = async (request, env) => {
  const forwarded = new Request(request, {
    headers: new Headers(request.headers),
  });
  forwarded.headers.set('Authorization', `Bearer ${env.AI_GATEWAY_TOKEN}`);
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
