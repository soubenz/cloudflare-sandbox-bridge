# cloudflare-sandbox-bridge

Cloudflare Worker exposing the
[`@cloudflare/sandbox`](https://github.com/cloudflare/sandbox-sdk) bridge HTTP
API (`/v1/sandbox`, `/v1/pool/*`, `/health`, etc.) for a custom Python client —
this repo does not use the JS SDK.

`src/index.ts` is the shared thin wrapper for every region. Each region has
its own **self-contained** `wrangler.<region>.jsonc` (`wrangler.eu.jsonc`,
`wrangler.usa.jsonc`, `wrangler.apac.jsonc`) — they differ only in `name`,
`containers[].max_instances`, `WARM_POOL_MAX_INSTANCES`, and
`SANDBOX_LOCATION_HINT`. There is no shared/default `wrangler.jsonc`; always
pick a region file explicitly.

`cloudflare-sandbox-bridge-2` (the original, manually-managed production EU
deployment, custom domain `eu-sandbox.ai.ingka.com`) is intentionally **not**
one of these configs and is not managed by this repo or Workers Builds.
`wrangler.eu.jsonc` here deploys a separate, fresh EU Worker
(`map-sandbox-bridge-eu`).

## Deploying a region

Each region is deployed by its own Worker connected to this repo via
[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
(Settings → Builds on that Worker in the dashboard — a one-time GitHub App
connection), with the region's config passed explicitly as the deploy
command:

```sh
npx wrangler deploy -c wrangler.eu.jsonc
npx wrangler deploy -c wrangler.usa.jsonc
npx wrangler deploy -c wrangler.apac.jsonc
```

or locally via `npm run deploy:eu` / `deploy:usa` / `deploy:apac` (needs
`wrangler login` or a `CLOUDFLARE_API_TOKEN` with Workers Scripts + Containers
edit scope). Docker is **not** required — `containers[].image` here points at
a `Dockerfile` path, which Workers Builds builds remotely; only a fully local
`wrangler deploy` from a machine without Docker would need one of the
alternatives in [Deploy Containers](https://developers.cloudflare.com/containers/guides/deploy/).

Set the `SANDBOX_API_KEY` secret once per region before first deploy:

```sh
npx wrangler secret put SANDBOX_API_KEY -c wrangler.usa.jsonc
```

**Read [PATCHES.md](PATCHES.md) before touching any of these Workers.** Two
behavioural fixes live only in the currently-deployed bundles, not in any
installable dependency — they must be reapplied by hand (or upstreamed) if
any of these are ever redeployed against a fresh `@cloudflare/sandbox`
install without the patch applied.