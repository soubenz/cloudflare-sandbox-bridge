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

---

# Tier 5 — measured performance, 24 Sep 2026

Measured against the live deployment at
`https://opalix-sandbox.soubenz94.workers.dev` (Worker version
`72dd6649`, commit `f63b0cc`), family `agent`, lab `hello`,
instance type `standard-1`. All timings were taken between 08:07 and
08:12 UTC on 24 Sep 2026 by a throwaway Node script driving the public
HTTP API from this dev container; the numbers therefore include
dev-container → Cloudflare edge round-trip time.

17 sessions were started in total: 16 measured, plus one to drain a
surplus warm container at the end (see "Anomalies"). Every session was
ended with `DELETE /sessions/{id}?snapshot=0`; all 17 deletes returned
200 and the pool's `claimed` count is back to 0.

## Method

* `t0` = the instant the `POST /sessions` response was fully received
  (202, `state: "starting"`).
* `t1` = the instant the first `GET /sessions/{id}` reported
  `meta.state === "running"`. Polled every 250 ms, so each sample
  carries up to ~250 ms of quantisation plus one request RTT.
* Sessions were run strictly sequentially, each ended before the next
  began, with a fresh unique `user_id` every time (the D1 partial unique
  index allows only one active session per user).
* **Cold vs warm was not assumed, it was verified.** Each run reads
  `GET /pools/agent` immediately before and after the start and
  classifies the claim by which counter moved: `cold_misses + 1` → cold,
  `warm_hits + 1` → warm. This matters because a cron
  (`*/5 * * * *`) re-primes the pool to `POOL_TARGET_AGENT = 1` every
  five minutes, so "I set target 0" is not sufficient evidence that a
  given start was cold.

## 1. Cold-start latency (pool empty)

`POST /pools/agent/prime {"target":0}` before each run, `warm: 0`
confirmed by `GET /pools/agent`, and the claim confirmed cold by a
`cold_misses` increment.

| Metric | Value |
|---|---|
| Sample size | 10 |
| min | 3 500 ms |
| p50 | 7 467 ms |
| p95 | 21 355 ms |
| max | 21 355 ms |
| mean | 10 119 ms |

Raw samples (ms, sorted):
`3500, 3529, 4042, 4846, 7467, 9182, 13344, 13394, 20533, 21355`

With n = 10 the p95 is just the maximum and should not be read as a real
95th percentile. The distribution is visibly wide and roughly trimodal
(~3.5–4.8 s, ~7.5–13.4 s, ~20.5–21.4 s) — a 6x spread between best and
worst cold start on an otherwise identical lab.

## 2. Warm-pool claim latency

`POST /pools/agent/prime {"target":2}`, waited until `GET /pools/agent`
reported `warm: 2`, then started a session; claim confirmed warm by a
`warm_hits` increment.

| Metric | Value |
|---|---|
| Sample size | 5 |
| min | 1 772 ms |
| p50 | 2 305 ms |
| max | 4 895 ms |
| mean | 2 778 ms |

Raw samples (ms, sorted): `1772, 2301, 2305, 2617, 4895`

Three of these five were deliberate (primed to 2). Two were claims that
the cron's own re-prime made warm mid-run; they were kept because the
counter check proved they were warm hits, and they are the 1 772 ms and
4 895 ms samples (pool at `warm: 1` rather than 2 — no measurable
difference in claim path).

**Warm vs cold delta:** p50 2 305 ms vs 7 467 ms — warm is **5 162 ms
(≈3.2x) faster at the median**, and 1 772 ms vs 3 500 ms (≈1.7x) at the
best case. Even the slowest warm claim (4 895 ms) beat the cold median.
This is the evidence for plan risk **R9**: with one warm container a
start lands around 2.3 s, not "instant", because ~1.8 s of floor remains
after the container itself is free (lab hydration, egress allowlist, env
application, service launch, plus edge RTT from this dev container).

## 3. Pool stats after the run

`GET /pools/agent`, taken immediately after the last measured session
was ended (before the drain session in "Anomalies"):

| Field | Value |
|---|---|
| `warm` | 2 |
| `claimed` | 0 |
| `config.target` | 1 |
| `config.batch` | 3 |
| `config.ping_every_s` | 240 |
| `stats.claims` | 37 |
| `stats.warm_hits` | 18 |
| `stats.cold_misses` | 19 |
| `stats.starts` | 20 |
| `stats.start_ms_total` | 50 293 ms |
| `stats.failures` | **0** |
| `stats.capacity_backoff_until` | 1790202102961 (23 Sep 22:21 UTC — expired, not active) |

These counters are cumulative for the life of the Pool DO, not for this
run. The deltas attributable to this run (from `claims: 20, warm_hits:
13, cold_misses: 7, starts: 14, start_ms_total: 36411` at 08:07:42) are:

| Delta | Value |
|---|---|
| claims | +17 (16 session starts — see the duplicate-claim anomaly) |
| warm_hits | +5 |
| cold_misses | +12 (10 cold runs + 2 from the one duplicated claim) |
| pool-side container starts | +6 |
| pool-side start time | +13 882 ms over 6 starts → **2 314 ms mean** |
| failures | +0 |

`start_ms_p50` is **not measured**: the Pool DO records only
`start_ms_total` and `starts` (`src/do/pool.ts`), so only a mean is
derivable. Note also that this ~2.3 s mean is the pool's own
`ensureRunning()` time for a bare container — it is *not* the
session-visible cold start, which is 3–4x larger because of everything
that happens after the claim.

The final state after cleanup is `warm: 1, claimed: 0, target: 1`.

## 4. Image sizes — MEASURED (24 Sep 2026, deploy run #18)

A `docker image ls` step was added to the Deploy workflow, because the
build output reports manifest bytes rather than image size. From run
`35991933396`:

| Image | Size |
|---|---|
| `opalix-sandbox-agentlab:924ededd` | **2.16 GB** |
| `opalix-sandbox-gatewaylab:924ededd` | **2.16 GB** |

For comparison, the base `cloudflare/sandbox:next-python` is about 329 MB
compressed. Grafana, LiteLLM, Prometheus and the Python toolchain account
for the rest.

**This is the most likely explanation for the cold-start spread measured
in section 1** (3.5 s to 21.4 s on identical work, with the pool's own
container start averaging 2.3 s): a 2.16 GB image has to be present on
the machine placing the container, and whether it is decides which end of
that range a learner gets. Two things follow. A warm pool is not a
nice-to-have at this size — it is the difference between "instant" and
twenty seconds. And image size is worth attacking directly: separating
Grafana and Prometheus into their own family image, or dropping unused
Python extras, would cut both the spread and the placement cost.

Both families being byte-identical in size to three significant figures
is worth a second look; they install different things (Grafana + LiteLLM
versus Prometheus + locust + Grafana), so equal sizes suggest the base
layers dominate so heavily that the difference rounds away.

### Original note, kept for the record — why this was hard to get



**The CI build logs do not report image sizes.** Checked the full log
archive for the most recent successful `Deploy` run on `main`
(run `35972868912`, job `107546412111`, 24 Sep 2026 08:01–08:06 UTC).

What the logs actually contain:

* BuildKit's export stage prints `exporting layers done` /
  `writing image sha256:… done` with **no byte count**.
* The registry push prints
  `72dd6649: digest: sha256:44a65… size: 5969` (agentlab) and
  `… size: 5343` (gatewaylab). **These are manifest sizes in bytes**,
  not image sizes, and must not be quoted as such.
* There is no `docker images` / `docker image inspect` step in
  `.github/workflows/deploy.yml`, so no total is ever printed.

The one size figure the logs *do* support, offered only as a lower
bound on the agent image and clearly not the image size:

| Quantity | Value | Source |
|---|---|---|
| `cloudflare/sandbox:next-python` base, compressed layers pulled | 328.85 MB across 19 layers | `Dry-run` step, BuildKit pull progress |
| `cloudflare/sandbox:next` base (gateway) | not derivable — only 0.01 MB transferred, the rest was already in the local layer cache from the agent build | same |

Neither figure includes the layers our Dockerfiles add (apt packages,
Grafana 11.4.0, Prometheus 2.55.1, LiteLLM), and both are *compressed
transfer* sizes rather than on-disk sizes.

To get real numbers, add a step to `.github/workflows/deploy.yml` after
the build, e.g.
`docker image ls --format '{{.Repository}} {{.Size}}' | grep opalix-sandbox`,
and re-read this table from the next run.

## 5. Service readiness

For all **16** measured sessions, the `echo` service already reported
`health: "healthy"` in the *same* `GET /sessions/{id}` response that
first showed `meta.state === "running"`.

| Metric | Value |
|---|---|
| Sample size | 16 |
| Sessions where `echo` was `healthy` at `running` | 16 / 16 |
| Additional wait after `running` | **0 ms** in every run |

Confirmed, and it is by construction rather than luck:
`runStart()` in `src/session/lifecycle.ts` awaits `startAllServices()`
— which runs each service's `waitForPort` healthcheck — *before* it
patches `state` to `running`. A client can treat `running` as
"declared services are up" and does not need a second readiness poll.

## Anomalies

1. **`prime` can only grow the pool, never shrink it.** After priming to
   `target: 2` for the warm measurements, `POST /pools/agent/prime
   {"target":1}` set the target back but left `warm: 2` — `alarm()` only
   acts when `target - warm > 0`, and the 240 s ping loop keeps the
   surplus container alive indefinitely. `Pool.drain()` exists in
   `src/do/pool.ts` but no route exposes it. A surplus `standard-1`
   container would have run forever. Worked around by starting one extra
   short session to claim and destroy it (`warm` is now back to 1), but
   this needs either a drain route or a shrink branch in `alarm()`.

2. **One session start produced two pool claims.** Session
   `01m3979w0z9mv0h99t7d25t4ap` moved `claims` 22 → 24 and `cold_misses`
   8 → 10 for a single `POST /sessions`. The session itself started
   normally (3 774 ms to `running`) and ended cleanly. Because
   `runStart()` claims a *fresh* sandbox id and overwrites
   `meta.sandbox_id`, a duplicate claim means a second container was
   started that the session's own `end()` would not destroy — it would
   sit in the pool's `claimed` map until the 3 h `CLAIMED_REAP_MS`
   sweep. `claimed` did read 0 afterwards, so nothing was visibly
   stranded, but the duplicate is real and reproducible risk: it is
   consistent with the `start` timer's `alarm()` being redelivered, or
   the `claim()` RPC being retried after a lost response. This sample was
   excluded from the cold percentiles above (it is the 16th start; the
   cold table uses the 10 cleanly-classified cold runs).

3. **Cold start is unstable.** 3 500 ms to 21 355 ms on identical work,
   with no failures and no retries logged. The pool's own container start
   averaged 2 314 ms over the same window, so the variance is downstream
   of the container being available.

4. **The cron fights the measurement.** `triggers.crons: ["*/5 * * * *"]`
   → `initConfig(family, poolTarget(env, family))` resets
   `POOL_TARGET_AGENT` to 1 and re-primes every five minutes, so a
   `prime {"target":0}` does not stay at 0 and does not empty an
   already-warm pool. Any future benchmarking must verify cold/warm from
   the `cold_misses` / `warm_hits` counters rather than trusting the
   target.

5. No `failures` were recorded by the pool (`stats.failures` +0), no
   `DELETE` failed, no session reached a `failed` state, and no
   `container_unavailable` capacity backoff was triggered during the run.

### Not measured in this pass

`LiteLLM` / `Grafana` `waitForPort` times, memory at idle and under
load, terminal round-trip latency, and the gateway family generally —
this pass covered only the `agent` family with the `hello` fixture, and
the table at the top of this file still needs those rows filled from a
`gateway` lab.

### Provenance and confounds

Another session was committing to this repo and deploying the same
production Worker while this benchmark ran. The timeline was checked so
the samples can be trusted:

| Time (UTC, 24 Sep 2026) | Event |
|---|---|
| 08:06:35 | Deploy run `35972868912` (commit `f63b0cc`) completes — Worker version `72dd6649` |
| 08:07:42 – 08:10:17 | All 15 cold/warm samples measured |
| 08:10:29 | commit `02efad1` pushed by a concurrent session |
| 08:10:35 | Deploy run `35973708335` created, still `in_progress` when checked |
| ~08:11 | 5th warm sample |
| ~08:12:40 | Drain session |
| 08:12:36 | commit `091d8f0` pushed by a concurrent session |

No deploy *completed* between 08:06:35 and the end of the measurements,
so every sample above ran against Worker version `72dd6649`. Note that
`091d8f0` changes `src/session/services.ts` health-check behaviour and
`02efad1` changes `src/session/lifecycle.ts` alarm dispatch — both land
after these numbers were taken, so section 5 in particular should be
re-confirmed on the next deployed version.

## AI Gateway + Workers AI (24 Sep 2026)

Measured against a real gateway (`opalix`, cache TTL 86400, logging on),
because the docs were ambiguous on the first question and silent on the
third. Every figure below is from a live call, not a reading.

### Auth: `Authorization`, not `cf-aig-authorization`

The docs describe `cf-aig-authorization` as the gateway credential and warn
that using `Authorization` is the top cause of 401s. For **Workers AI models
through the OpenAI-compatible endpoint that is backwards**:

| Headers sent | Result |
|---|---|
| `cf-aig-authorization` only | **401** Authentication error |
| `Authorization` only | **200** |
| both | 200 |
| neither | 401 |

`cf-aig-authorization` applies to gateways with *authenticated gateway* mode
turned on, which ours is not. So `llmOutbound`'s existing
`Authorization: Bearer` injection is already right, and the change this was
about to make would have broken every Real-mode lab. If authenticated
gateway mode is ever enabled, both headers will be needed.

### Cache: a real determinism guarantee, with a warm-up

An identical request returns a byte-identical cached response and
`cf-aig-cache-status: HIT`. That is what Real-mode graders rest on, since
`temperature: 0` promises nothing on batched fp8 inference.

| Path | Call 1 | Call 2 | Call 3 |
|---|---|---|---|
| gateway default TTL | MISS | **HIT** | — |
| explicit `cf-aig-cache-key` + `cf-aig-cache-ttl` | MISS | **MISS** | **HIT** |

The explicit-key path needed **two** repeats before it hit, sequentially,
with no concurrency involved. So a grader must not assert `HIT` on the first
repeat after warming: pre-warm at publish time, and treat a MISS as a retry
rather than a failure.

### Logs: usable, and quick enough

`GET /accounts/{acct}/ai-gateway/gateways/opalix/logs/{cf-aig-log-id}`,
polled from the id in the response header:

```
visible after 2s
{"model":"@cf/meta/llama-3.1-8b-instruct-fp8","cached":false,"success":true,
 "status_code":200,"tokens_in":25,"tokens_out":13,
 "cost":0.00000752536245714873,"duration":1423}
```

Ingestion latency is undocumented; measured at ~2 s here. Graders that read
tokens, cost or duration (P1-02, P1-07, P3-03) must poll that id with
backoff rather than read once.

Cost is an estimate and a cache hit always records `cost: 0`, so grade
"cost went down", never an exact figure.

### What this fixes in the plan

Section 21 said to change `llmOutbound` to `cf-aig-authorization`. That is
wrong and the spike is why it was run first.

### Proven from inside a container (25 Sep 2026)

The wiring, not just the endpoint. A `hello` session, probed over the
terminal:

```
URL=https://gateway.ai.cloudflare.com/v1/<account>/opalix/compat
MODEL=workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8

POST $LLM_BASE_URL/chat/completions   -> HTTPCODE=200, "content":"gateway-ok"
GET  https://example.com              -> 520 (refused)
```

The container carries **no credential**: `llmOutbound` injects the token in
the Worker. The open question this answered was whether the SDK's https
interception and its ephemeral CA would let a plain `curl` out to the
gateway at all — they do, with no change to the image. The egress fence is
unaffected: everything not on the allowlist is still refused.
