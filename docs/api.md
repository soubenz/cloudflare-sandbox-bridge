# Opalix sandbox API

Base URL: `PUBLIC_BASE_URL` in `wrangler.jsonc` (e.g. `https://labs-api.opalix.ai`).

## Auth

Two credential kinds:

- **Service key** (`Authorization: Bearer <SANDBOX_API_KEY>`) — for the app
  backend and the CLI. Required on `POST /sessions`, `GET /sessions`,
  `POST /labs/publish`, `POST /pools/:family/prime`, `POST /pools/:family/drain`,
  `/users/*`, and `POST /sessions/{id}/events`. The read-only catalogue and
  pool routes (`GET /labs`, `GET /labs/:slug`, `GET /pools`,
  `GET /pools/:family`) require it too. **No route is open.** There was once
  a var that opened several of them so the console could work without a
  credential; the console now has a server side that holds the key, so the
  var and the route it guarded are gone.
- **Session token** — minted by `POST /sessions`, `POST /sessions/start`
  and `POST /sessions/{id}/resume`. Accepted as
  `Authorization: Bearer <token>`, `?token=<token>` (browser links), or the
  `opx_s_{id}` cookie the service proxy sets on first use. Required on every
  other `/sessions/{id}/*` route. A session token only authenticates its own
  session — using it against a different session id is rejected.

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
| GET | `/labs` | service¹ | catalogue → `[{ slug, version, title, type, family }]` |
| GET | `/labs/:slug` | service¹ | current version + manifest → `{ version, manifest }` |
| POST | `/labs/publish` | service | multipart: `manifest`, `workspace`, `private` files → `201 { slug, version }` |
| GET | `/pools`, `/pools/:family` | service¹ | warm pool stats → `{ warm, claimed, config, stats }` |
| POST | `/pools/:family/prime` | service | `{ target? }` → `{ ok: true }`; only ever grows the pool |
| POST | `/pools/:family/drain` | service | destroys every warm container; claimed ones are untouched → `{ ok: true }` |
| POST | `/sessions` | service | `{ lab, user_id }` → `202 { id, state, token, urls }` |
| POST | `/sessions/start` | service | `{ lab, user_id }` → `202` same shape, or `200 { ..., rejoined: true }` if that user already has a live session² |
| GET | `/sessions` | service | every live session, newest first, max 200 |
| GET | `/sessions/:id` | session | `{ meta, services, snapshots, checks? }` |
| GET/PUT/DELETE | `/sessions/:id/files/:path` | session | under `/workspace`; PUT capped at 2 MiB |
| GET | `/sessions/:id/files?path=` | session | list; `path` defaults to `/workspace` but is **not** confined to it |
| POST | `/sessions/:id/checks` | session | `{ only? }` → runs and returns the full `ChecksRun` |
| GET | `/sessions/:id/events` | session | SSE, replays from `Last-Event-ID` |
| POST | `/sessions/:id/events` | service | `{ type, data }` — the LLM Worker reporting cost/calls |
| POST | `/sessions/:id/services/:name/restart` | session | → the service's `ServiceRuntime` |
| ANY | `/sessions/:id/services/:name/*` | session | path-based UI proxy |
| WS | `/sessions/:id/terminal` | session | relayed PTY |
| POST | `/sessions/:id/snapshot` | session | → the new `SnapshotEntry` |
| POST | `/sessions/:id/resume` | session | requires a snapshot; `{ meta, token }` with a new token |
| DELETE | `/sessions/:id?snapshot=0` | session | ends the session; snapshots by default |
| GET | `/users/:uid/sessions?active=1` | service | D1-backed history/active check; capped at 50 rows without `active=1` |

¹ Service key required. Nothing opens these.

² `POST /sessions` and `POST /sessions/start` differ only in what they do
about a conflict. `POST /sessions` is a strict create: a second live session
for the same `user_id` is a `409`, which is what the CLI and the integration
suite want. `POST /sessions/start` rejoins it instead and returns a fresh
token, which is what an interactive client wants — a reload or a second tab
should land back where it was rather than on a wall it cannot clear.

The `urls` object on a session start is
`{ status, terminal, events, services }`, where `services` maps a service
name to its proxy URL. Only services with `ui: true` appear in that map.

`POST /sessions/{id}/events` accepts only the three types the LLM Worker
reports — `cost`, `llm.call` and `alert`. Any other value is rejected with
`400 unknown_event_type`. An `llm.call` whose `data.cost_usd` is a number is
added to the session's running LLM spend.

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
| 404 | `unknown_family` | a `/pools/:family` path that is not `agent` or `gateway` |
| 404 | `unknown_service` | restart or proxy for a service not in the lab |
| 409 | `active_session_exists` | the user already has a live session (the D1 unique index) |
| 409 | `cannot_resume` | `POST /sessions/{id}/resume` on a session that is not `ended` |
| 409 | `no_snapshot` | resume with no snapshot to restore from |
| 409 | `not_running` | terminal attach while the session is not `running` |
| 409 | `session_recovering` | a stale process/terminal handle; the container was replaced |
| 409 | `file_exists` | SDK `FileExistsError` |
| 413 | `payload_too_large` | `PUT .../files/...` over 2 MiB, or the SDK's own file-size limit |
| 502 | `service_down` | service proxy while that service is `unhealthy` |
| 503 | `container_unavailable` | SDK `ContainerUnavailableError`; `details.retry_after_ms` when the SDK supplies it |
| 503 | `sdk_transient` | SDK `OperationInterruptedError` / `RPCTransportError` |
| 500 | `internal_error` | anything unrecognised; `details.error_name` carries the original class name |

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
