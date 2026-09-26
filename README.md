# opalix-sandbox

The sandbox layer for [Opalix](https://opalix.ai): a Cloudflare Worker that
starts, drives, and tears down hosted lab environments for a hands-on
learning platform for production AI engineering. Learners work in real
containers (a Python agent, LiteLLM, Grafana, a fake LLM provider) and
either build a missing component or fix a broken system; a checker grades
the outcome.

This repo is the sandbox API only — a standalone service. The app frontend,
app backend, and a command-line client (`cli/`, included here) are all
clients of it. See `/root/.claude/plans/opalix-product-plan-resilient-swing.md`
in the planning session that produced this repo for the full design
rationale; this README is the quick-start.

## Layout

- `src/` — the Worker: routes (`router.ts`), the `Session` and `Pool`
  Durable Objects (`do/`), session logic (`session/`), lab manifest and
  bundle handling (`labs/`), per-family container classes (`families/`).
- `images/` — one Dockerfile per lab family (`agent`, `gateway`).
- `labs/` — real lab content goes here (empty at this commit; see
  `test/fixtures/labs/hello` for a trivial worked example).
- `cli/` — the `opalix` command-line client.
- `site/` — the public opalix.ai home page and waitlist: static HTML and
  CSS plus one Worker endpoint (`npm run dev:site`, `npm run deploy:site`).
- `test/unit` — fast, plain-Node unit tests (no Docker required).
- `test/integration` — end-to-end tests against a running Worker (`wrangler
  dev` with Docker, or staging).
- `migrations/` — D1 schema.
- `docs/` — API reference, lab-authoring guide, and the Phase 0 spike
  write-up template.

## Getting started

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in dev secrets
npm run types                    # generates worker-configuration.d.ts (gitignored)
npm run typecheck:all
npm test                         # unit tests, no Docker needed
npm run dev                      # wrangler dev — needs Docker for the container bindings
```

Deploying needs a Cloudflare account with Containers enabled, an R2 bucket
per binding, a D1 database (`npm run d1:migrate`), and the secrets listed
in `wrangler.jsonc`'s comment (`wrangler secret put SANDBOX_API_KEY`, etc).
`npm run deploy` / `npm run deploy:staging`.

## Using the CLI

```sh
export OPALIX_URL=http://localhost:8787
export OPALIX_KEY=<SANDBOX_API_KEY>
npm run opalix -- labs publish test/fixtures/labs/hello
npm run opalix -- session start hello --user demo-user
npm run opalix -- session attach
npm run opalix -- session check
npm run opalix -- session end
```

## Status

This is the Phase 1 implementation from the sandbox-layer plan: the full
API surface, both Durable Objects, and the CLI are written and typecheck
clean, with unit tests for every pure-logic module (manifest parsing and
templating, session-token auth, the timer scheduler, check-output parsing).
It has **not** been deployed or run against a live container yet — that is
Phase 0's spike, which needs a Cloudflare account with Containers enabled
and a Docker daemon (this development environment had neither). See
`docs/spike.md` for what to verify before trusting this in anger.
