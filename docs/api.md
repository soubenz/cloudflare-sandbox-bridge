# Opalix sandbox API

Base URL: `PUBLIC_BASE_URL` in `wrangler.jsonc` (e.g. `https://labs-api.opalix.ai`).

## Auth

Two credential kinds:

- **Service key** (`Authorization: Bearer <SANDBOX_API_KEY>`) — for the app
  backend and the CLI. Required on `POST /sessions`, `GET /sessions`,
  `POST /labs/publish`, `POST /pools/:family/prime`, `POST /pools/:family/drain`,
  `/users/*`, and `POST /sessions/{id}/events`. The read-only catalogue and
  pool routes (`GET /labs`, `GET /labs/:slug`, `GET /pools`,
  `GET /pools/:family`), `GET /usage` and `GET /health?deep=1` require it
  too. Only plain `GET /health` is open (it returns nothing but `{ ok: true }`).
  **No other route is open.** There was once
  a var that opened several of them so the console could work without a
  credential; the console now has a server side that holds the key, so the
  var and the route it guarded are gone.
- **Session token** — minted by `POST /sessions`, `POST /sessions/start`
  and `POST /sessions/{id}/resume`. Accepted as
  `Authorization: Bearer <token>`, `?token=<token>` (browser links), or the
  `opx_s_{id}` cookie the service proxy sets on first use (or that
  `POST /sessions/{id}/services/{name}/session` sets on request — see
  [Service cookie](#service-cookie)). Required on every
  other `/sessions/{id}/*` route. A session token only authenticates its own
  session — using it against a different session id is rejected.

During a key rotation the API also accepts `SANDBOX_API_KEY_PREVIOUS` (when
set) and marks those responses `X-Opalix-Key: previous`; see
`docs/runbooks/secrets-rotation.md`.

Every route that accepts a session token also accepts the service key, so a
service caller can reach the whole session surface without minting a token.

Token lifetime tracks the session. Every mint goes through
`sessionTokenExp` in `src/auth.ts`, which is the session's expiry plus ten
minutes of grace, so a token outlives the session it belongs to rather than
the other way round. `POST /sessions` derives that expiry from the
manifest's `timeout_minutes`, because `expires_at` is not set until the
session reaches `running`.

This was not always true: both mints previously used a flat hour, so a lab
with `timeout_minutes` above 60 handed its client a token that died
mid-session with no refresh route. Labs up to the schema maximum of 120
minutes are usable now.

## Routes

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | liveness → `{ ok: true }` |
| GET | `/health?deep=1` | service | probes D1, R2 (`labs/index.json`) and both pools → `200 { ok: true, checks: { d1, r2, pools: { agent: { degraded, warm }, gateway } } }`, or `503 { ok: false, failing: [...], checks }` naming what failed; a degraded pool counts as failing³ |
| GET | `/usage?from=&to=` | service | estimated container spend per family from D1 sessions (epoch ms; default last 30 days) → `{ from, to, by_family: { agent: { hours, usd, sessions }, gateway }, total_usd }`; see `docs/runbooks/cost.md` |
| GET | `/labs` | service¹ | catalogue, ordered by `(path, module, order, slug)` → `[{ slug, version, title, type, family, summary?, objectives, difficulty?, timeout_minutes, path?, module?, order?, prerequisites?, tier, estimated_minutes? }]`. `summary`, `difficulty`, `path`, `module`, `order`, `prerequisites` and `estimated_minutes` are omitted when the manifest does not set them; `tier` is `free` or `pro` (default `pro`); `objectives` is `[]` when unset. `bundle.ts` `listCatalogue({ path?, module?, tier?, limit?, cursor? })` implements the filtered, paged form (cursor = last slug of the previous page; default limit 50, max 200) for the route to expose |
| GET | `/labs/:slug` | service¹ | current version + manifest → `{ version, manifest }` |
| POST | `/labs/publish` | service | multipart: `manifest`, `workspace`, `private` files plus optional `force=true` → `201 { slug, version, warnings: string[] }`; `warnings` lists prerequisites that are not published labs. Re-publishing an existing version is `409 version_exists` unless `force` |
| GET | `/pools`, `/pools/:family` | service¹ | warm pool stats → `{ warm, claimed, max_instances, available, config, stats }`; `max_instances` is the container class's ceiling (`MAX_INSTANCES_<FAMILY>` var, default 10) and `available` is `max_instances - claimed`, the sessions that could still start⁴; `stats` includes `consecutive_start_failures`, `degraded`, and `last_start_error` / `last_start_error_at` when a start has failed |
| POST | `/pools/:family/prime` | service | `{ target? }` → `{ ok: true }`; only ever grows the pool |
| POST | `/pools/:family/drain` | service | destroys every warm container; claimed ones are untouched → `{ ok: true }` |
| POST | `/sessions` | service | `{ lab, user_id }` → `202 { id, state, token, urls }`; `503 at_capacity` with a `Retry-After` header when the family's pool is full⁴ |
| POST | `/sessions/start` | service | `{ lab, user_id }` → `202` same shape, or `200 { ..., rejoined: true }` if that user already has a live session² |
| GET | `/sessions` | service | every live session, newest first, max 200 |
| GET | `/sessions/:id` | session | the `status()` body: `{ meta, services, snapshots, checks?, cost, hints, pressure, manifest_summary?, checks_history, server_time }` — see [Session status](#session-status) |
| GET/PUT/DELETE | `/sessions/:id/files/:path` | session | under `/workspace`; PUT capped at 2 MiB |
| GET | `/sessions/:id/files?path=` | session | list; `path` defaults to `/workspace` but is **not** confined to it |
| POST | `/sessions/:id/checks` | session | `{ only? }` → runs and returns the full `ChecksRun` |
| GET | `/sessions/:id/checks?limit=20` | session | this session's last runs from D1, newest first (default 20, max 100) → `{ runs: [{ run_id, started_at, finished_at, passed, total, score, results }] }`; `results` is the parsed `CheckResultEntry[]` |
| GET | `/sessions/:id/progress-summary` | session | this session's user on this session's lab → `{ slug, attempts, best_score, passed_all, last_run_at, sessions, attempts_this_session }` (zeros and `last_run_at: null` before any run) |
| POST | `/sessions/:id/feedback` | session | `{ rating, text? }` — `rating` an integer 1-5, `text` at most 2000 characters. One row per session: a second call replaces the first. → `201 { ok: true }`; `400 bad_feedback` |
| GET | `/sessions/:id/events` | session | SSE, replays from `Last-Event-ID` |
| POST | `/sessions/:id/events` | service | `{ type, data }` — the LLM Worker reporting cost/calls |
| POST | `/sessions/:id/services/:name/restart` | session | → the service's `ServiceRuntime`. The request body is ignored: the service is relaunched from the spec fixed at session start, so its command, working directory and env cannot be changed by a restart |
| POST | `/sessions/:id/services/:name/session` | session | sets the service-proxy cookie so a UI can be opened with no `?token=` in its URL → `204` with `Set-Cookie: opx_s_{id}=<the caller's session token>; Path=/sessions/{id}/; HttpOnly; Secure; SameSite=None; Partitioned`. The token goes in `Authorization: Bearer`; the service key is refused (`403 session_token_required`) because it would end up in the cookie. `404 unknown_service`, `403 not_exposed` and `400 no_port` are the proxy's own errors for a service that cannot be proxied. Health is not checked: a service that is down still gets its cookie, and the proxy then answers `502 service_down`. CORS: the response and its preflight name the calling origin from `DASHBOARD_ORIGIN` and carry `Access-Control-Allow-Credentials: true`, so the console can call it with `credentials: 'include'`; the proxy routes carry the same headers |
| ANY | `/sessions/:id/services/:name/*` | session | path-based UI proxy. A document `GET` (`Accept: text/html`) with `?token=` sets the cookie and answers `302` to the same URL without `token`; any other request carrying `?token=` is proxied as before with the cookie set on the response |
| WS | `/sessions/:id/terminal` | session | relayed PTY |
| POST | `/sessions/:id/snapshot` | session | → the new `SnapshotEntry` |
| POST | `/sessions/:id/touch` | session | refreshes the idle clock ("I'm here") exactly as a file write does, without doing any work; 204, or `409 not_running` |
| POST | `/sessions/:id/resume` | session | requires a snapshot; `{ meta, token }` with a new token |
| DELETE | `/sessions/:id?snapshot=0` | session | ends the session; snapshots by default |
| GET | `/users/:uid/progress` | service | per-lab standing from D1 `check_runs` → `{ labs: [{ slug, attempts, best_score, passed_all, last_run_at, sessions }] }`, most recently attempted first. `best_score` is the best weighted share of checks passed in one run (0-1); `passed_all` is true if any run passed every check of the lab; `sessions` counts distinct sessions that ran checks |
| GET | `/users/:uid/checks?lab=&limit=&before=` | service | a user's runs across sessions, newest first → `{ runs: [...] }` (same shape as the session route, plus `session_id` and `lab_slug`). `lab` filters to one lab; `before` is an epoch-ms cursor (pass the last `started_at` you saw); `limit` default 20, max 100 |
| GET | `/users/:uid/sessions?active=1` | service | D1-backed history/active check; capped at 50 rows without `active=1` |

¹ Service key required. Nothing opens these.

³ A pool is `degraded` once its target is above 0, it has no warm containers,
and three consecutive container starts have failed. The Pool posts a JSON
body `{ text, content }` (Slack reads `text`, Discord reads `content`) to the
optional `ALERT_WEBHOOK_URL` secret when it becomes degraded, and again when
the next start succeeds. `.github/workflows/probe.yml` calls
`/health?deep=1` from outside Cloudflare every ten minutes.

² `POST /sessions` and `POST /sessions/start` differ only in what they do
about a conflict. `POST /sessions` is a strict create: a second live session
for the same `user_id` is a `409`, which is what the CLI and the integration
suite want. `POST /sessions/start` rejoins it instead and returns a fresh
token, which is what an interactive client wants — a reload or a second tab
should land back where it was rather than on a wall it cannot clear.

⁴ Admission control. `POST /sessions` and `POST /sessions/start` ask the
family's pool whether a session can start before they reserve the user's slot
in D1. The pool refuses with `503 at_capacity`, `details.retry_after_s` and a
matching `Retry-After` header when nothing is warm and either the live
sessions already hold `max_instances` containers, or the pool is backing off
after the platform reported no capacity (then `retry_after_s` is the time left
in the backoff, at most 300). While a warm container exists a session is
always admitted: claiming it does not add an instance. `MAX_INSTANCES_AGENT`
and `MAX_INSTANCES_GATEWAY` mirror the container classes' `max_instances` in
`wrangler.jsonc`; a unit test keeps the two equal.

A session row that still says active while its Durable Object has ended (or
never existed) would lock its user out through the one-active-session index.
`POST /sessions` therefore closes such a row and retries the insert once
before answering `409 active_session_exists`; `POST /sessions/start` does the
same before it rejoins; and an hourly sweep closes active rows older than
three hours whose DO has ended or is gone. A D1 failure other than that
index's violation is a `500`, and a session whose DO could not be created is
marked `ended` with `end_reason: "error"`.

The `urls` object on a session start is
`{ status, terminal, events, services }`, where `services` maps a service
name to its proxy URL. Only services with `ui: true` appear in that map.

### Service cookie

A service UI lives on the API's origin, not the console's, so an iframe or an
"open in new tab" link needs the session token to get in. Putting it in the
URL leaves it in the address bar, the history and any `Referer`. Instead the
console calls `POST /sessions/{id}/services/{name}/session` with
`credentials: 'include'` and `Authorization: Bearer <token>`; the `204`
carries

```
Set-Cookie: opx_s_{id}=<session token>; Path=/sessions/{id}/; HttpOnly; Secure; SameSite=None; Partitioned
```

and every later request under `/sessions/{id}/` (the iframe, the link, the
service's own assets) authenticates with the cookie. `Partitioned` is the
one attribute beyond the plain third-party form: without it current browsers
drop the cookie, because the console and the API are different sites. The
`?token=` path sets the identical cookie (one helper, `sessionCookie` in
`src/session/proxy.ts`). A browser that refuses the cookie anyway (third-party
cookies blocked outright) gets `401` from the proxy, and the console falls
back to a `?token=` iframe URL.

`POST /sessions/{id}/events` accepts only the three types the LLM Worker
reports — `cost`, `llm.call` and `alert`. Any other value is rejected with
`400 unknown_event_type`. An `llm.call` whose `data.cost_usd` is a number is
added to the session's running LLM spend.

## Pool schedule

`POOL_TARGET_<FAMILY>` is a fixed warm-container count. To vary it by time of
day, set the optional `POOL_SCHEDULE_AGENT` / `POOL_SCHEDULE_GATEWAY` var. The
cron (every 5 minutes) evaluates it at the cron's scheduled time, in **UTC**,
and passes the result to the pool; when the target drops below the number of
warm containers, the surplus is destroyed (oldest first), not left running.

```
"mon-fri 07-21=1; *=0"
```

Rules are separated by `;` and the first match wins. A rule is
`<days> <HH-HH>=<target>` or `*=<target>`. Days are `*`, or a comma list of
names and ranges (`mon-fri`, `sat,sun`, `mon,wed-fri`). Hours are `[start,
end)`, 0-24, with start below end (no overnight windows; write two rules on
adjacent days). The example keeps one warm container from 07:00 to 20:59 UTC
on weekdays and none otherwise. If the var is unset or empty, or does not
parse (logged once), or no rule matches, `POOL_TARGET_<FAMILY>` applies.
A manual `POST /pools/:family/prime { target }` is overwritten at the next
cron tick either way.

## Errors

Every error response is `{ "error": { "code", "message", "details"? } }`,
built in one place (`ApiError.toResponse` in `src/lib/errors.ts`). Errors
raised inside the Session Durable Object keep their status and code across
the RPC boundary.

| Status | Code | Raised by |
|---|---|---|
| 400 | `missing_fields` | `POST /sessions` or `POST /sessions/start` without `lab` or `user_id` |
| 400 | `bad_publish_payload` | `POST /labs/publish` missing any of the three files |
| 400 | `unknown_event_type` | `POST /sessions/{id}/events` with a type other than `cost`/`llm.call`/`alert` |
| 400 | `no_port` | service proxy for a service with no `port` |
| 400 | `not_a_websocket` | `/terminal` without an `Upgrade: websocket` header |
| 401 | `unauthorized` | missing/invalid service key, malformed, expired or mismatched session token |
| 403 | `not_exposed` | service proxy for a service with `ui: false` |
| 404 | `not_found` | an unknown DO sub-route; SDK not-found errors |
| 404 | `lab_not_found` | no published lab with that slug |
| 400 | `bad_window` | `GET /usage` with a `from`/`to` that is not a non-negative number, or `from >= to` |
| 400 | `bad_path` | a `/files` path that is not under `/workspace` — lexically, after `realpath` resolution (symlinks included), or because `learner` cannot access it |
| 400 | `unknown_event_type` | `POST /sessions/{id}/events` with a type outside the injectable set (`cost`, `llm.call`, `alert`, `pressure`, `hint`, `session.idle_warning`, `session.expiring`, `session.state`, `service.health`) |
| 404 | `unknown_family` | a `/pools/:family` path that is not `agent` or `gateway` |
| 403 | `session_token_required` | `POST /sessions/{id}/services/{name}/session` called with the service key |
| 404 | `unknown_service` | restart, cookie route or proxy for a service not in the lab |
| 400 | `bad_feedback` | `POST /sessions/{id}/feedback` with a `rating` that is not an integer 1-5, a `text` that is not a string or is over 2000 characters, or a body that is not an object |
| 400 | `bad_cursor` | `GET /users/{uid}/checks` with a `before` that is not a number |
| 409 | `active_session_exists` | the user already has a live session (the D1 unique index) |
| 409 | `cannot_resume` | `POST /sessions/{id}/resume` on a session that is not `ended` |
| 409 | `no_snapshot` | resume with no snapshot to restore from |
| 409 | `not_running` | the session is not running (still starting, resuming, recovering or ended) |
| 409 | `session_recovering` | a stale process/terminal handle; the container was replaced |
| 409 | `version_exists` | `POST /labs/publish` for a `<slug>/<version>` that is already published, without `force` |
| 409 | `file_exists` | SDK `FileExistsError` |
| 413 | `payload_too_large` | `PUT .../files/...` over 2 MiB, or the SDK's own file-size limit |
| 502 | `service_down` | service proxy while that service is `unhealthy` |
| 503 | `at_capacity` | `POST /sessions`, `POST /sessions/start`: the family's pool is at `max_instances` or backing off; `details.retry_after_s`, and the `Retry-After` header carries the same number |
| 503 | `container_unavailable` | SDK `ContainerUnavailableError`; `details.retry_after_ms` when the SDK supplies it |
| 503 | `sdk_transient` | SDK `OperationInterruptedError` / `RPCTransportError` |
| 500 | `internal_error` | anything unrecognised; `details.error_name` carries the original class name |

## Session status

`GET /sessions/:id` returns the Session DO's `status()`. A console that
reconnects without `Last-Event-ID` needs nothing else to redraw itself.

| Field | Meaning |
|---|---|
| `meta` | `SessionMeta`: state, timestamps, `expires_at`, `end_reason` |
| `services` | `{ [name]: ServiceRuntime }` |
| `snapshots` | `SnapshotEntry[]` |
| `checks?` | the most recent `ChecksRun` (also while it is still running) |
| `cost` | `{ running_s, usd, llm_usd, accounted_until? }` |
| `hints` | `{ delivered: [{ index, after_minutes, text }], total, schedule }`; `schedule` is every hint's `after_minutes`, `total` its length, `delivered` the hints whose timer has fired (also sent as `hint` events) |
| `pressure` | `{ [event_id]: { status: "pending" \| "fired" \| "failed", fired_at? } }`; `pending` covers events still to come and is not reported once the session has ended |
| `manifest_summary?` | `{ title, objectives, timeout_minutes, idle_minutes, checks: [{ name, weight }], services: [{ name, ui, port? }], hints_schedule }`; absent if the manifest is gone |
| `checks_history` | the last 10 finished runs, oldest first: `{ run_id, started_at, finished_at?, passed, total, score, results: [{ name, pass, weight }] }` (no messages; `GET /sessions/:id/checks` has the full runs) |
| `server_time` | server epoch ms, for correcting client clock skew against `meta.expires_at` |

The `sessions` row in D1 also gets `hints_delivered` (count) and, at the
first run that passes every check, `completed_at`; `check_runs` rows carry
`user_id`, `lab_slug`, `lab_version`, `score` and `passed_all`
(migration `0005_product.sql`). A run limited with `only` never counts as
`passed_all`, since it did not cover every check.

## Session lifecycle

`starting → running → ended`, with `recovering` and `resuming` as transient
sub-states of `running`. (`created` exists in the `SessionState` type but no
code path ever sets it.) `POST /sessions` returns as soon as the session row
exists (`state: "starting"`); poll `GET /sessions/:id` or watch
`session.state` on the event stream for `running`.

Every session has a hard timeout (`manifest.timeout_minutes`, 60-120) and an
idle timeout (`manifest.idle_minutes`, default 10). The idle clock —
`meta.last_input_at` — is reset by a file write, a file delete, a check run,
a service restart, a terminal attach, every terminal client frame, and every
request through the service proxy. Reads do not reset it: `GET` on a file, a
file listing, `GET /sessions/:id` and an open SSE stream all leave the clock
running.

A `session.expiring` warning is emitted 5 minutes before the hard timeout
and `session.idle_warning` 2 minutes before the idle timeout. The idle
warning fires on a timer that is only re-armed when the idle timer itself
runs, so an active session can still receive an idle warning at the
originally scheduled moment; the `idle_ms` on the event is the true
measurement and is the field to trust.

Both timeouts snapshot before destroying the container, so
`POST /sessions/:id/resume` picks up where it left off in a fresh container.
An hour after a session ends, its stored event log and per-service state are
dropped; the snapshot list survives, so a resume is still possible.

## Events

`GET /sessions/{id}/events` is an SSE stream. Each frame carries a numeric
`id:` (the SQL row's `seq`) usable as `Last-Event-ID` on reconnect; without
one, the last 50 events are replayed. The log is capped at the most recent
1000 events. A `: ping` comment is sent every 20 seconds.

| `event:` | `data` |
|---|---|
| `session.state` | `{ state }`, plus `recovered: true`, `resumed: true` or `reason` on the relevant transitions |
| `session.expiring` | `{ reason: "hard_timeout" }` |
| `session.idle_warning` | `{ idle_ms }` |
| `service.health` | `{ service, health }`, plus `restarted: true`, `relaunched: true`, or `reason` + `logs_tail` on a failed start |
| `container.restarted` | `{ reason }` — the container was replaced and recovery has begun |
| `pressure` | `{ event_id, title, message }` |
| `hint` | `{ index, after_minutes, text }` — one per `hints[]` entry, on its own timer |
| `check.started` | `{ run_id, total }` |
| `check.result` | one `CheckResultEntry`: `{ name, pass, message, duration_ms, exit_code, timed_out, weight }` |
| `check.finished` | `{ run_id, passed, total, score }` — `score` is pass-weight over total weight |
| `snapshot.created` | one `SnapshotEntry`: `{ backup_id, dir, ttl, created_at, reason }` |
| `metrics` | `{ running_s, cost_usd, llm_cost_usd }` — every 30s while running |
| `cost` | whatever the LLM Worker posts to `POST /sessions/{id}/events` |
| `llm.call` | whatever the LLM Worker posts; a numeric `cost_usd` is accumulated |
| `alert` | `{ kind, ... }` — see below |

`alert` is the catch-all for a failure that does not end the session. The
`kind` values the code emits are `pressure_failed`, `terminal_upstream_closed`,
`terminal_reconnect_failed`, `terminal_resize_failed`, `timer_failed`,
`recover_no_snapshot`, `snapshot_on_end_failed` and
`set_allowed_hosts_failed`, plus whatever the LLM Worker posts.

The `metrics` cost figure is an upper bound, not a bill: the SDK exposes no
per-instance CPU utilization, so it assumes the vCPU is active for the whole
running time.

## Backend abstraction

Every route above talks to the container only through `src/session/backend.ts`'s
`Backend` interface (`CloudflareBackend` wraps `@cloudflare/sandbox`). A
future non-Cloudflare backend (rented VMs, k3s, Kata — the "cluster backend"
in the product plan, or a cost-driven move off Cloudflare per the pricing
review) implements the same interface; no route or manifest field changes.
