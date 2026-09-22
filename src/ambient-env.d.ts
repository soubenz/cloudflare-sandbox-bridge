/**
 * `@cloudflare/sandbox`'s Container base class types its STATIC
 * `outboundByHost` / `outbound` properties as `OutboundHandler<Cloudflare.Env>`
 * — the ambient ("Cloudflare.Env") type `wrangler types` generates, not our
 * hand-written `Env` in src/env.ts. Static class members can't see a
 * subclass's own generic parameter in TypeScript (`Sandbox<Env>`'s statics
 * are fixed at the base class's default), so egress.ts's handlers must be
 * typed against this ambient interface, not our own `Env`.
 *
 * `wrangler types` only knows about `vars` and bindings declared in
 * wrangler.jsonc; secrets (`wrangler secret put`) have no static
 * declaration there, so we add them here via declaration merging. This file
 * is the only place that needs to stay in sync with the secrets list in
 * wrangler.jsonc's comment and .dev.vars.example.
 */
declare namespace Cloudflare {
  interface Env {
    SANDBOX_API_KEY: string;
    SESSION_TOKEN_SECRET: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    LLM_WORKER_KEY: string;
  }
}
