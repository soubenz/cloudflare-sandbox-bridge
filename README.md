# cloudflare-sandbox-bridge

Cloudflare Worker deployed as `cloudflare-sandbox-bridge-2`, exposing the
[`@cloudflare/sandbox`](https://github.com/cloudflare/sandbox-sdk) bridge HTTP
API (`/v1/sandbox`, `/v1/pool/*`, `/health`, etc.) for a custom Python client —
this repo does not use the JS SDK.

`src/index.ts` and `wrangler.jsonc` reflect the actual deployed configuration.
`wrangler.jsonc` var values are kept in sync with what's live; see comments
inline for anything non-default.

**Read [PATCHES.md](PATCHES.md) before touching this Worker.** Two behavioural
fixes live only in the deployed bundle, not in any installable dependency —
they must be reapplied by hand if this is ever redeployed via `wrangler
deploy` against a fresh `@cloudflare/sandbox` install.