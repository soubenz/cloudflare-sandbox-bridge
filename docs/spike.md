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

## LiteLLM proxy (T4, 26 Sep 2026)

Everything below was run in a venv under
`/tmp/claude-0/.../scratchpad/litellm-t4/` (this session's scratchpad), not
in this repo, against a real local PostgreSQL 16 cluster and a real
fake-OpenAI HTTP server. Nothing was guessed from litellm's docs; every
claim cites the command and the real output. Where I did read installed
package *source* (not docs) to explain *why* something happened, I say so
explicitly and separately from the live evidence.

### Environment note — this is not quite the lab image

This dev sandbox is **Ubuntu 24.04.4 LTS**, not the 22.04 the lab
containers run (`cat /etc/os-release` → `PRETTY_NAME="Ubuntu 24.04.4
LTS"`). Per the task, I used the `python3.10` interpreter that happens to
also be installed here (`/usr/bin/python3.10`, `Python 3.10.20`) rather
than the system default (`python3` → `Python 3.11.15`), so the *Python*
version matches the lab target even though the OS userland (glibc, apt
package set, preinstalled Node) does not. This matters for one specific
claim below (Prisma's Node bootstrap) — flagged where relevant.

### Step 1 — install and pin

```
$ python3.10 -m venv venv
$ ./venv/bin/pip install "litellm[proxy]"
...
Successfully installed ... litellm-1.102.1 litellm-enterprise-0.1.67
litellm-proxy-extras-0.4.97 ... fastapi-0.141.1 uvicorn-0.54.0 ...

$ ./venv/bin/pip show litellm
Name: litellm
Version: 1.102.1
...
```

Two things worth flagging about this install, found by inspecting what
actually landed in `site-packages` (not docs):

* **`litellm[proxy]` pulls in `litellm-enterprise` 0.1.67 automatically**
  (`License-Expression: LicenseRef-Proprietary`). It's just an importable
  dependency, not a license grant — enterprise-gated endpoints still refuse
  without a license (see Q3c).
* **`litellm[proxy]` does *not* install the `prisma` Python package.**
  `./venv/bin/pip show prisma` → `WARNING: Package(s) not found: prisma`
  right after the install above. Starting the proxy with a Postgres
  `DATABASE_URL` at this point fails immediately:
  ```
  ModuleNotFoundError: No module named 'prisma'
  Unable to connect to DB. DATABASE_URL found in environment, but the
  prisma CLI is neither on PATH nor importable as a package.
  ```
  `prisma` (0.15.0) had to be `pip install`ed separately.

### Step 2 — Postgres, locally

`postgresql` (meta) + `postgresql-16` were installed with `apt-get install
-y postgresql` (real internet access confirmed via `apt-get update`
succeeding). A cluster was created and started under the scratchpad,
running as the unprivileged `postgres` system user:

```
$ sudo -u postgres /usr/lib/postgresql/16/bin/initdb -D .../litellm-t4/pgdata --auth=trust
... Success. ...

$ sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D pgdata -l pgdata/pg.log \
    -o "-p 5432 -h 127.0.0.1" start
waiting for server to start.... done
server started

$ psql -h 127.0.0.1 -p 5432 -U postgres -c "SELECT version();"
 PostgreSQL 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1) on x86_64-pc-linux-gnu ...
```

Postgres worked, so this is answered directly rather than "if you can't, say
why" — but one real, reproducible problem showed up along the way, worth
recording because it cost real time: **this specific coding sandbox
periodically resets the scratchpad's ancestor directories back to `700`
between tool calls** (a security control of the harness, not of the target
container). Since `pgdata` lives several directories under the scratchpad
root, this twice made an ancestor directory untraversable to the `postgres`
user *while Postgres was already running*, and its checkpointer — which
reopens `pg_control` by path on every checkpoint — hit:
```
2026-09-26 10:22:25.303 UTC [2482] PANIC:  could not open file
  ".../pgdata/global/pg_control": Permission denied
2026-09-26 10:22:25.304 UTC [2481] LOG:  checkpointer process (PID 2482)
  was terminated by signal 6: Aborted
2026-09-26 10:22:25.314 UTC [2481] LOG:  database system is shut down
```
Both times, `pg_ctl start` afterwards replayed WAL cleanly and all data
(171 applied migrations, created keys/teams/spend rows) survived intact —
confirmed via `SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at
IS NOT NULL` returning `171` both before and after. **This is an artifact
of this research sandbox, not a finding about the real container image**
(which won't have an external process resetting its filesystem
permissions), so it is not carried into the Implications list, but it does
mean two of the timing runs below started from a WAL-recovered cluster
rather than a pristine one — noted where relevant.

### Step 3 — fake provider + config

`fake_provider.py` (plain `http.server`, no deps) on `127.0.0.1:8961`
answers `POST /a/v1/chat/completions` with a fixed
`{"content": "fixed-fake-reply"}` and `usage: {"prompt_tokens": 1000,
"completion_tokens": 1000, "total_tokens": 2000}` (a large fixed usage so a
tiny budget is easy to exceed deterministically). `config.yaml` defines two
aliases, `support` and `other`, both `openai/fake-model` pointed at that
`api_base`, each given explicit `input_cost_per_token`/
`output_cost_per_token: 0.001` (needed for Q3d — a model litellm doesn't
recognise prices at `$0` by default, so a budget could never be exceeded
without this). The proxy was started with:
```
DATABASE_URL=postgresql://litellm:litellm@127.0.0.1:5432/litellm
LITELLM_MASTER_KEY=sk-t4-master
LITELLM_LOCAL_MODEL_COST_MAP=True
./venv/bin/litellm --config config.yaml --port 4000
```

### Q1 — Does key/team management require Postgres?

Yes, hard-required — confirmed two ways.

**Live**: same install, `DATABASE_URL=sqlite:///$(pwd)/test_sqlite.db`,
port 4001:
```
LiteLLM Proxy: DATABASE_URL uses unsupported scheme 'sqlite'. LiteLLM's
database features (virtual keys, store_model_in_db, spend tracking)
require PostgreSQL; use a 'postgresql://' connection string. SQLite and
other engines are not supported. See https://docs.litellm.ai/docs/proxy/virtual_keys
```
The process exits immediately — no server ever binds
(`curl .../health/readiness` → connection refused, `000`).

**Why, from the installed source** (not docs): the schema every version of
the DB layer is generated from is hard-coded, not merely defaulted —
`venv/lib/python3.10/site-packages/litellm_proxy_extras/schema.prisma`:
```
datasource client {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```
There is no other provider shipped, so no config change makes SQLite work;
this isn't a missing driver, it's a schema that only understands Postgres.

### Q2 — what does the proxy try to reach at runtime?

Method used: started the proxy with a bad, **process-scoped**
`HTTPS_PROXY=http://127.0.0.1:1` (nothing listens there) so any outbound
HTTPS call fails fast and loud in the log, without touching the session's
real proxy settings.

**a) Model cost map (`model_prices_and_context_window.json` from GitHub).**
Confirmed live, both directions.

Without `LITELLM_LOCAL_MODEL_COST_MAP` set, network blocked:
```
LiteLLM:WARNING: model cost map fetch attempt 1/3 failed (ConnectError
  fetching https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json:
  [Errno 111] Connection refused); retrying in 2.4s
LiteLLM:WARNING: ... attempt 2/3 failed ...; retrying in 4.7s
LiteLLM:WARNING: Failed to fetch remote model cost map from
  https://raw.githubusercontent.com/... after 3 attempts; keeping local backup
```
It degrades gracefully (falls back to litellm's bundled copy, does not
crash) but burns ~7s of retries with backoff on every cold start with no
egress.

With `LITELLM_LOCAL_MODEL_COST_MAP=True` set, same blocked network, fresh
run, log grepped for `model_prices|github|cost map`: **zero fetch-attempt
lines** (only the static "file an issue on GitHub" banner text remained).
Startup proceeded straight through with no retry delay. The env var is
also documented in the installed module's own docstring
(`litellm/litellm_core_utils/get_model_cost_map.py`), which I read to name
it, then verified live.

**b) Prisma engine binaries / `prisma generate` / migrations.** This is a
genuine build-time-only step; nothing suppresses it via an env var. Traced
through four real states:

1. `litellm[proxy]` alone, `DATABASE_URL` set to real Postgres → crashes
   immediately (`ModuleNotFoundError: No module named 'prisma'`, shown
   above).
2. `pip install prisma` (0.15.0) → different, later crash:
   ```
   Exception: Unable to find Prisma binaries. Please run 'prisma generate' first.
   ```
3. Manually ran the real generation step (needs `venv/bin` on `PATH` so
   the schema's declared generator binary, `prisma-client-py`, resolves):
   ```
   $ PATH=$(pwd)/venv/bin:$PATH DATABASE_URL=postgresql://... \
     prisma generate --schema=.../litellm_proxy_extras/schema.prisma
   ✔ Generated Prisma Client Python (v0.15.0) to ./venv/lib/python3.10/site-packages/prisma in 1.16s
   ```
   This is the point where the real network calls happen. It downloaded a
   Node-based Prisma CLI plus **5 query-engine binaries**, one per
   `binaryTarget` the schema declares (`native`, `debian-openssl-1.1.x`,
   `debian-openssl-3.0.x`, `linux-musl`, `linux-musl-openssl-3.0.x`), into
   `~/.cache/prisma/` (104 MB) and
   `~/.cache/prisma-python/binaries/5.17.0/<hash>/node_modules/prisma/`
   (134 MB) — confirmed by `find ~/.cache -iname '*query-engine*'` and
   `du -sh` before/after.
4. With that cache in place, the real proxy startup log shows the rest
   happening automatically, from Postgres alone (no network needed at this
   point):
   ```
   litellm_proxy_extras - INFO - Preparing the Prisma CLI toolchain (timeout 600.0s)
   litellm_proxy_extras - INFO - Prisma CLI toolchain ready
   litellm_proxy_extras - INFO - Running prisma migrate deploy
   ... 171 migrations found in prisma/migrations ... No pending migrations to apply.
   litellm_proxy_extras - INFO - prisma migrate deploy completed
   ```
   So migrations themselves are *not* a manual step — the proxy runs
   `prisma migrate deploy` against its own bundled 171 migrations on every
   boot — but that only works because the client+engine from step 3 were
   already generated.

No env var bypasses step 3. This is corroborated straight from the
installed source, not docs: `litellm/proxy/prisma_migration.py`'s own
docstring reads *"every shipped image bakes the client at build time;
refreshing it writes into site-packages, which an arbitrary non-root uid or
a read-only root filesystem cannot do"* — i.e. upstream's own image already
treats this as build-time-only, which matches exactly what I reproduced.

One gap: Node 22 was already present on this machine
(`/opt/node22/bin/node`), so the private-Node-runtime bootstrap that
`litellm_proxy_extras/prisma_toolchain.py`'s own docstring describes for a
machine with *no* Node at all ("installs a private Node runtime... can
take minutes") was never exercised here. **The real Ubuntu 22.04 lab base
image needs to be checked for whether Node is present**; if not, the
build-time `prisma generate` step will also pull a private Node via
`nodeenv`, adding to the one-time build cost (still build-time, still not a
runtime download, but worth knowing about before assuming step 3 is quick).

**c) Telemetry.** Read the source first, then verified with the
network-blocked run above. `litellm/utils.py` hardcodes
`posthog: Final = None`, and the actual `PostHogLogger`
(`litellm/integrations/posthog.py`) is only instantiated if `"posthog"` is
explicitly configured as a `success_callback`/logging integration with an
API key — nothing in `config.yaml` does that here. Across every log
captured in this spike, including the two deliberately network-blocked
runs above, grepping for `posthog|telemetry` in the *runtime* logs never
turns up an outbound attempt (only source-code matches when grepping
`site-packages` directly). So for litellm 1.102.1 there is no env var
needed to "turn telemetry off" because nothing calls out by default; I did
**not** test the opposite direction (deliberately configuring the
`posthog` callback to confirm it *would* call out), since that wasn't
needed to support the negative claim.

### Q3 — what works without an enterprise licence

**a) Virtual key limited to specific model aliases — works.**
```
$ curl -sX POST :4000/key/generate -H "Authorization: Bearer sk-t4-master" \
    -d '{"models": ["support"], "key_alias": "q3a-key-v2"}'
{"...,"models":["support"],...,"key":"sk-<generated>",...}

$ curl -sX POST :4000/chat/completions -H "Authorization: Bearer $KEY" \
    -d '{"model":"support",...}'
-> HTTP 200, {"...,"choices":[{"message":{"content":"fixed-fake-reply"}...

$ curl -sX POST :4000/chat/completions -H "Authorization: Bearer $KEY" \
    -d '{"model":"other",...}'
-> HTTP 403
{"error":{"message":"key not allowed to access model. This key can only
access models=['support']. Tried to access other",
"type":"key_model_access_denied","code":"403"}}
```

**b) Teams — works.**
```
$ curl -sX POST :4000/team/new -H "Authorization: Bearer sk-t4-master" \
    -d '{"team_alias": "team-alpha", "models": ["support"]}'
-> {"team_alias":"team-alpha","team_id":"4fff92e8-...",...}

$ curl -sX POST :4000/key/generate -H "Authorization: Bearer sk-t4-master" \
    -d '{"team_id": "4fff92e8-...", "key_alias": "team-alpha-key"}'
-> {"...,"team_id":"4fff92e8-...","key":"sk-<generated>",...}
```

**c) A team member who can create keys for their own team, refused for a
different team, refused on a proxy-admin endpoint — works, but *not* the
way the question assumes.** Assigning the **`admin`** team-member role is
itself enterprise-gated:
```
$ curl -sX POST :4000/team/member_add -H "Authorization: Bearer sk-t4-master" \
    -d '{"team_id": "<team-alpha>", "member": {"user_id": "alice", "role": "admin"}}'
{"detail":{"error":"Assigning team admins is a premium feature. You must be
a LiteLLM Enterprise user to use this feature. ..."}}
```
(traced to
`litellm/proxy/management_endpoints/team_endpoints.py:_check_team_member_admin_add`
— `if m.role == "admin" and premium_user is not True: raise ValueError(...)`).
So the literal scenario in Q3c ("a team member with an admin role")
**cannot be built without a licence.** Adding the same user with
`role: "user"` succeeds (`HTTP 200`), and by default a plain `user`-role
member is *also* refused `/key/generate` for their own team:
```
{"error":{"message":"Team member does not have permissions for endpoint:
/key/generate. You only have access to the following endpoints:
['/key/info', '/key/health'] for team 4fff92e8-.... To create keys for
this team, please ask your proxy admin to check the team member
permission settings...","type":"team_member_permission_error","code":"401"}}
```
The free, non-enterprise mechanism for this is `team_member_permissions`
(`POST /team/permissions_update`, itself gated only to proxy/team/org
admins, with **no premium check in the code path** — confirmed by reading
`team_endpoints.py` around that route). After the proxy admin grants it:
```
$ curl -sX POST :4000/team/permissions_update -H "Authorization: Bearer sk-t4-master" \
    -d '{"team_id": "<team-alpha>", "team_member_permissions": ["/key/generate", ...]}'
-> HTTP 200

$ curl -sX POST :4000/key/generate -H "Authorization: Bearer $ALICE_KEY" \
    -d '{"team_id": "<team-alpha>", "key_alias": "alice-for-team-alpha-2"}'
-> HTTP 200, key created, "created_by":"alice"

$ curl -sX POST :4000/key/generate -H "Authorization: Bearer $ALICE_KEY" \
    -d '{"team_id": "<team-beta>", "key_alias": "alice-for-team-beta-2"}'
-> HTTP 400 {"error":{"message":"User=alice not assigned to team=<team-beta>",...}}

$ curl -s :4000/user/list -H "Authorization: Bearer $ALICE_KEY"
-> HTTP 403 {"detail":{"error":"Only proxy admins and organization admins can list users."}}
```
So: own-team key creation ✔, foreign-team refused ✔, proxy-admin-only
endpoint (`GET /user/list`) refused ✔ — all without a licence, just not via
the `admin` role field.

**d) Per-team budgets — works.**
```
$ curl -sX POST :4000/team/new -H "Authorization: Bearer sk-t4-master" \
    -d '{"team_alias":"team-budget","models":["support"],"max_budget":1.0,"budget_duration":"30d"}'
-> {"team_id":"c376eb0e-...","max_budget":1.0,"spend":0.0,...}

$ curl -sX POST :4000/key/generate ... -d '{"team_id":"c376eb0e-...","key_alias":"budget-key"}'
-> key sk-<generated>

$ curl -sX POST :4000/chat/completions -H "Authorization: Bearer $BKEY" \
    -d '{"model":"support",...}'
-> HTTP 200 (spend logged at $2.00 — 1000 in + 1000 out tokens * $0.001, via /spend/logs)

$ curl -s ":4000/team/info?team_id=c376eb0e-..." -H "Authorization: Bearer sk-t4-master"
-> spend=2.0 max_budget=1.0

$ curl -sX POST :4000/chat/completions -H "Authorization: Bearer $BKEY" \
    -d '{"model":"support",...}'
-> HTTP 429
{"error":{"message":"Budget has been exceeded! Team=c376eb0e-... Current
cost: 2.0, Max budget: 1.0","type":"budget_exceeded","code":"429"}}
```

### Q4 — exact status codes and bodies

**a) Key calls an alias it isn't allowed to use → `403`:**
```
{"error":{"message":"key not allowed to access model. This key can only
access models=['support']. Tried to access other",
"type":"key_model_access_denied","param":"model","code":"403"}}
```

**b) Anyone calls an alias that doesn't exist in the config (tried with
the master key itself) → `400`:**
```
{"error":{"message":"/chat/completions: Invalid model name passed in
model=nope-model. Call `/v1/models` to view available models for your
key.","type":"invalid_request_error","param":null,"code":"400"}}
```

### Q5 — startup time, peak memory, key-info endpoint

Measured against the already-migrated Postgres cluster (171 migrations
already applied — realistic for a learner's *n*-th session, not a from-
scratch DB), Prisma client already generated, `LITELLM_LOCAL_MODEL_COST_MAP=True`,
polling `/health/readiness` every 0.5–1s from process launch:

| Run | Elapsed to first `200` |
|---|---|
| 1 (single alias) | 22 092 ms |
| 2 (two aliases) | 19 836 ms |

Both in the same ~20–22s band. Time is dominated by three sequential
shell-outs the proxy does before Uvicorn even starts: the "Preparing the
Prisma CLI toolchain" check (~4–5s, even fully cached, because it's still a
subprocess `prisma --version` call), then `prisma migrate deploy` (~4s to
invoke and report "No pending migrations to apply"), then Python/FastAPI
import and app init.

Peak RSS, sampled every 0.5s from launch to ready, summed across the
Python process and its Prisma query-engine child (a separate OS process):
**≈589 MB** peak during startup (`588 904` KB), settling to **≈455 MB**
steady-state a few seconds after `/health/readiness` turned healthy
(`439 008` KB parent + `24 504` KB query-engine child, and again
`441 732` + `25 636` KB on a second run) — measured with `ps -o rss=`
against the litellm PID and its child.

**Key-info endpoint:** `GET /key/info?key=<key>` (bearer: master key),
confirmed live — returns `models`, `team_id`, `max_budget`, `spend`,
`budget_duration`, `blocked`, etc. for the given key:
```
$ curl -s ":4000/key/info?key=$ALICE_KEY" -H "Authorization: Bearer sk-t4-master"
{"key":"sk-<generated>","info":{"key_alias":"alice-personal-key",
"models":[],"user_id":"alice","team_id":null,"max_budget":null,"spend":0.0,...}}
```
(Role isn't a *key*-level field in this version — role lives on the
team-membership or user record; `/key/info` still returns everything
needed to know what a key can do: its allowed models and its team.)

### A companion data point (attributed, not verified by me here)

The agent building the actual gateway container image reported, from a live
run of that image (not from this local spike): litellm 1.102.1 already
installed, ~10.5s to first successful call with
`LITELLM_LOCAL_MODEL_COST_MAP=True` set (vs ~16.3s without it, consistent
in *kind* with the ~7s of retry cost measured above, though smaller in
this instance's case), ~320 MB RSS, and that `httpx` inside that container
fails `CERTIFICATE_VERIFY_FAILED` unless `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`
is set. I did not reproduce any of these four numbers myself in this
sandbox (different environment: bare pip+venv+local Postgres, not the
built image) — they're included here only because they bear directly on
the Implications list below, and are called out as reported, not measured,
so they aren't mistaken for this spike's own evidence.

### Implications for the gateway image

* **Pin `litellm==1.102.1`** (`litellm[proxy]` extra) — the exact version
  installed and exercised throughout this spike (`pip show litellm`).
  Explicitly also pin/install **`prisma==0.15.0`**, since it is *not*
  pulled in by the `[proxy]` extra and the proxy hard-fails without it.
* **Postgres is mandatory, not a default** — `DATABASE_URL` must be a
  `postgresql://` URL. SQLite (or anything else) is rejected outright at
  startup (Q1), and the rejection is backed by a hard-coded
  `provider = "postgresql"` in the shipped Prisma schema — there is no
  config path around this.
* **Build-time steps required so nothing downloads at runtime:**
  1. `pip install "litellm[proxy]" prisma` (the pin above).
  2. With a reachable (even throwaway) Postgres at build time, run
     `PATH=<venv>/bin prisma generate --schema=<venv>/lib/python3.*/site-packages/litellm_proxy_extras/schema.prisma`
     with `DATABASE_URL` set. This is the one genuinely network-dependent
     step (Node CLI + 5 query-engine binaries, confirmed downloaded,
     ~238 MB combined cache) and there is no env var that defers or skips
     it — it must happen at build time. Check whether the Ubuntu 22.04 base
     already has Node; if not, this step also bootstraps a private Node
     runtime and will take noticeably longer the first time.
  3. Migrations (`prisma migrate deploy`, 171 of them today) do **not**
     need a separate manual step — the proxy runs them itself at every
     boot, and this only needs DB connectivity, not network, once step 2's
     client is already baked in. Still fine to also run once at build time
     against a throwaway Postgres as an extra validation if desired.
  4. Bake `LITELLM_LOCAL_MODEL_COST_MAP=True` into the image's default
     environment — confirmed live to fully suppress the
     `raw.githubusercontent.com` cost-map fetch (and its ~7s of retries
     under blocked egress) with zero functional loss for a config that
     only uses custom-priced aliases like ours.
  5. No build step or env var is needed for telemetry in this version —
     nothing calls out by default (Q2c); don't add a `posthog` callback.
  6. (Reported, not verified here) set `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`
     if the built image shows `CERTIFICATE_VERIFY_FAILED` on any httpx
     call — see the companion data point above.
* **Startup/memory budget:** allow ~20s cold start even with everything
  pre-baked and DB reachable (this sandbox: 19.8–22.1s; the real container
  reportedly ~10.5s) and size the instance for at least 512 MB–1 GB RSS
  (this sandbox: ~455 MB steady / ~589 MB peak; the real container
  reportedly ~320 MB) — the two environments disagree enough in absolute
  terms that the labs should re-measure this once inside the actual image
  rather than trust either number blindly.
* **For the two learning labs:** scoped virtual keys, teams, per-team
  model restriction, per-team budgets, and `/key/info` all work fully in
  the open-source tier with real evidence above — safe to build labs
  around them. **Team-admin-role assignment (`role: "admin"` on
  `/team/member_add`) is Enterprise-only** and will refuse with a clear
  "premium feature" error; if a lab wants "a team lead who can self-serve
  keys for their own team," build it on `team_member_permissions` +
  `/team/permissions_update` (free, demonstrated above), not on the
  `admin` role, unless the labs are meant to also teach the Enterprise
  licensing boundary itself.

### What I could not verify

* Whether enabling the `posthog` logging callback *would* actually call
  out (only confirmed it's off by default and unused in our config).
* Any other management endpoint's premium-gating beyond team-admin-role
  and `/user/list` — did not exhaustively fuzz every endpoint.
* The Node-runtime bootstrap path in `prisma generate` on a machine with no
  Node pre-installed (this machine already had Node 22) — the real 22.04
  base image should be checked directly.
* The four companion numbers in the "attributed" section above (real
  container startup time/RSS with/without the cost-map env var, and the
  `SSL_CERT_FILE` requirement) — reported by a parallel session against the
  actual built image, not reproduced by me in this local spike.
* Real Ubuntu 22.04 behaviour generally — this sandbox is 24.04; only the
  Python interpreter version (3.10.20) was matched to the lab target, not
  the OS userland.

## LiteLLM in a live gateway container (26 Sep 2026)

Measured in a real `gateway-hello` session on the deployed platform
(`standard-1`: 0.5 vCPU, 4 GiB), through the learner's terminal, then the
session was ended. No database — the database numbers are T4's, above.

Environment: LiteLLM **1.102.1** (already in the image, unpinned), Python
3.10.12, `nproc` 1, 4169 MB RAM, **no Postgres binaries**.

| LiteLLM proxy, scripted provider on 127.0.0.1 | Ready after | RSS |
|---|---|---|
| As installed | 16.3 s | ~320 MB |
| With `LITELLM_LOCAL_MODEL_COST_MAP=True` | 10.5 s | ~320 MB |

Without the variable, the log shows three failed attempts to fetch
`model_prices_and_context_window.json` from `raw.githubusercontent.com`
(`CERTIFICATE_VERIFY_FAILED`), then "keeping local backup". A call through
the proxy to the scripted provider succeeded in both runs.

**HTTPS from Python to the allowed AI Gateway host**
(`https://gateway.ai.cloudflare.com/v1`):

| Client | Result |
|---|---|
| curl | 404 (reached the gateway) |
| Python `urllib` | HTTP 404 (reached it) |
| Python `httpx` | `CERTIFICATE_VERIFY_FAILED: self-signed certificate in certificate chain` |
| `httpx` with `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` | 404 (reached it) |

`images/common/opalix-init.sh` adds the container's outbound CA to the
system store with `update-ca-certificates`. `httpx` and `requests` use
certifi's own bundle instead, and nothing in either image sets
`SSL_CERT_FILE` or `REQUESTS_CA_BUNDLE`. So LiteLLM, and any learner code
using the OpenAI Python SDK, `httpx` or `requests`, cannot reach the AI
Gateway in either image. The shipped Real-mode labs work only because their
services use `urllib`.

Probe pitfall: a file written through the files API into a new directory
leaves that directory `root:755`, so the learner's shell can't create files
next to it.
