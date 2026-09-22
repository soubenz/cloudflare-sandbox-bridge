# Phase 0 spike results

Template — fill in during the spike (plan section 11, Phase 0). None of
this has been measured yet: this development environment had no Docker
daemon and no live Cloudflare account, so nothing here has been verified
against a real container. Run the spike before trusting any code in this
repo against real learners.

## Numbers to fill in

| Metric | Value | Notes |
|---|---|---|
| Agent image size | | `images/agent/Dockerfile` |
| Gateway image size | | `images/gateway/Dockerfile` |
| Cold `getSandbox` → `exec(['true'])`, p50 | | 10 runs |
| Cold `getSandbox` → `exec(['true'])`, p95 | | |
| LiteLLM `waitForPort` time (cold) | | |
| Grafana `waitForPort` time (cold) | | |
| Memory idle, `basic` (1 GiB) | | fits? |
| Memory under agent load, `basic` | | |
| Memory idle, `standard-1` (4 GiB) | | |
| Memory under agent load, `standard-1` | | |
| Claim latency, 1 warm container in pool | | |
| Relayed terminal round-trip latency | | src/session/terminal.ts |
| Chosen instance type — agent family | | |
| Chosen instance type — gateway family | | |
| Chosen pool target per family | | |

## Risks (plan section 12) — verdict per item

| # | Risk | Verdict |
|---|---|---|
| R1 | Two container classes, one Worker, independent scaling | |
| R2 | `enableInternet=false` + `outboundByHost` blocks/intercepts correctly on `@next`; confirm `ctx.containerId` shape | |
| R3 | `writeFile` fast enough for multi-MB bundles, else use the `bundlesOutbound` handler | |
| R4 | `createBackup` after `restoreBackup` captures the merged overlay | |
| R5 | `terminal.connect()` with a synthetic request returns a usable socket | |
| R6 | `SandboxAddon.getWebSocketUrl` can target our terminal route (for a later browser client) | |
| R7 | A 3-minute exec and a 2-hour attached terminal don't hit DO/RPC limits | |
| R8 | `getProcess()` goes null promptly after a container kill; sandbox id survives for `recover()` | |
| R9 | Cold start fits an "instant" budget with 1 warm container | |
| R10 | Grafana `serve_from_sub_path` / LiteLLM `SERVER_ROOT_PATH` behave behind `src/session/proxy.ts` | |
| R11 | D1 accepts the partial unique index (`migrations/0001_init.sql`) | |
| R12 | `locationHint: weur` honoured for Session DOs and sandbox stubs | |
| R13 | The `@next` image tag in the Dockerfiles matches the installed npm version and boots correctly | |
| R14 | A custom 0.5 vCPU / 2 GiB instance type is accepted and sufficient, or `standard-1` is needed | |

## How to run it

1. `docker login` to Cloudflare's registry / have a Cloudflare account with
   Containers enabled.
2. `wrangler d1 create opalix` and `wrangler r2 bucket create opalix-labs`
   (+ `opalix-backups`), then fill the real ids into `wrangler.jsonc`.
3. `wrangler secret put SANDBOX_API_KEY` etc. (see `wrangler.jsonc`'s
   comment for the full list).
4. `npm run opalix -- labs publish test/fixtures/labs/hello`
5. `npm run opalix -- session start hello --user spike` and work through
   `attach`, `check`, `snapshot`, `end`, `resume`, `end`.
6. Fill in the tables above from what you observed (Cloudflare dashboard /
   Workers Observability traces for timing; `docker images` for size).
