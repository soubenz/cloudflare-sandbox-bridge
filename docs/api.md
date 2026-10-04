# Opalix sandbox API

Base URL: `PUBLIC_BASE_URL` in `wrangler.jsonc` (e.g. `https://labs-api.opalix.ai`).

## Auth

Two credential kinds:

- **Service key** (`Authorization: Bearer <SANDBOX_API_KEY>`) — for the app
  backend and the CLI. Required on `POST /sessions`, `GET /sessions`,
  `POST /labs/publish`, `POST /pools/:family/prime`, `POST /pools/:family/drain`,
  `/users/*`, and `POST /sessions/{id}/events`. The read-only catalogue and
  pool routes (`GET /labs`, `GET /labs/:slug`, `GET /labs/:slug/learn`, `GET /pools`,
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
The exceptions refuse the service key with `403 session_token_required`:
the service-cookie route (it would put the key in a cookie) and
`GET /sessions/{id}/solution` (the reveal is the learner's own view).

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
| GET | `/labs` | service¹ | catalogue, ordered by `(path, module, order, slug)` → `[{ slug, version, title, type, family, summary?, objectives, difficulty?, timeout_minutes, path?, module?, order?, prerequisites?, tier, estimated_minutes?, archived?, has_learn }]`. `has_learn` is always present: true when the current version ships a [learn bundle](#learn-bundle). `summary`, `difficulty`, `path`, `module`, `order`, `prerequisites` and `estimated_minutes` are omitted when the manifest does not set them; `archived` is present (as `true`) only for an archived lab, which the list still returns so admin tools and tests see every lab (the learner console hides it, and it stays startable by slug); `tier` is `free` or `pro` (default `pro`); `objectives` is `[]` when unset. `bundle.ts` `listCatalogue({ path?, module?, tier?, limit?, cursor? })` implements the filtered, paged form (cursor = last slug of the previous page; default limit 50, max 200) for the route to expose |
| GET | `/labs/:slug` | service¹ | current version + manifest → `{ version, manifest }` |
| GET | `/labs/:slug/learn` | service¹ | the lab's [learn bundle](#learn-bundle), current version → `{ slug, version, learn }` (the slug rides along so the console can build narration URLs from the bundle alone); `404 no_learn` when the lab is published without one, `404 lab_not_found` when it is not published. Read by the console Worker with the service key, like `GET /labs/:slug` |
| GET | `/learn/onboarding` | service | the platform onboarding quiz, `packages/catalogue/onboarding.json` parsed with `parseOnboarding` → `{ version: 1, intro, areas, questions }`. It is a branching quiz: `areas` is `[{ area, blurb }]`, one per area of `concepts.json` (`blurb` a one-line description, up to 90 characters), and every question is a lab quiz question plus a required `level` of `basic` or `advanced` (every area has at least one of each; 12 to 24 questions in all). The console asks only about areas the learner ticks, the area's first `basic` question and then, if right, its first `advanced` one, in file order; see [Learning content](learning-content.md#the-platform-onboarding-quiz). `404 no_onboarding` when that file is not in the deployed bundle; a file that does not validate is a 500 |
| POST | `/learn/answers` | service | anonymous quiz-answer analytics, called by the console Worker → `201 { ok: true, recorded }`. See [Learning analytics](#learning-analytics) |
| GET | `/labs/:slug/audio/:file` | service¹ | one [narration clip](#narration-clips) of the lab's comic, current version. `:file` is `<16 hex>.mp3` (anything else is `404 no_audio`, and nothing else under the lab's R2 prefix is ever reachable). `200 audio/mpeg` with `Cache-Control: public, max-age=31536000, immutable` (the name is a content hash) and `Accept-Ranges: bytes`; a single `Range: bytes=a-b` / `a-` / `-n` is answered `206` with `Content-Range`, an unsatisfiable one `416`, several ranges the whole clip. Read by the console Worker with the service key (it proxies it as `GET /api/audio/:slug/:file`, cookie-gated, `Cache-Control: private`) |
| POST | `/labs/publish` | service | multipart: `manifest`, `workspace`, `private` files, an optional `solution` file (the lab's `solution/` as a gzip tarball; `labs publish` sends it when the directory has anything to upload), an optional `learn` file (the compiled `learn/` folder as JSON, see [Learn bundle](#learn-bundle)), zero or more `audio` files (the comic's narration clips, see [Narration clips](#narration-clips)) and optional `force=true` → `201 { slug, version, warnings: string[] }`; `warnings` lists prerequisites that are not published labs. Re-publishing an existing version is `409 version_exists` unless `force`. The solution is stored privately at `labs/{slug}/{version}/solution.tgz`, never inside `workspace.tgz` or `private.tgz` and never served by a catalogue route; a forced re-publish without a `solution` part removes the one the version had. The `learn` part is validated with `parseLearnBundle` (the Worker does not trust the CLI): a bundle that does not parse or does not cross-check is `400 invalid_learn_bundle` listing every problem, and nothing of the publish is stored; a forced re-publish without a `learn` part removes the one the version had. The `audio` parts are checked against the bundle's `audio` index (`400 invalid_audio` otherwise, nothing stored) |
| GET | `/pools`, `/pools/:family` | service¹ | warm pool stats → `{ warm, claimed, max_instances, available, config, stats }`; `max_instances` is the container class's ceiling (`MAX_INSTANCES_<FAMILY>` var, default 10) and `available` is `max_instances - claimed`, the sessions that could still start⁴; `stats` includes `consecutive_start_failures`, `degraded`, and `last_start_error` / `last_start_error_at` when a start has failed |
| POST | `/pools/:family/prime` | service | `{ target? }` → `{ ok: true }`; only ever grows the pool |
| POST | `/pools/:family/drain` | service | destroys every warm container; claimed ones are untouched → `{ ok: true }` |
| POST | `/sessions` | service | `{ lab, user_id }` → `202 { id, state, token, urls }`; `503 at_capacity` with a `Retry-After` header when the family's pool is full⁴ |
| POST | `/sessions/start` | service | `{ lab, user_id }` → `202` same shape, or `200 { ..., rejoined: true }` if that user already has a live session²; if the user has a [pre-warm](#pre-warming) of that lab it begins it instead (`202`, same shape, instant) |
| POST | `/sessions/prepare` | service | `{ lab, user_id }` → pre-warm a lab: claims a container and boots it fully, then parks the session in `ready` with no lab clock running. `202 { id, state, prepared: true }` (no token or URLs: they are minted when the lab begins), or `200 { id, state, prepared: true, reused: true }` when this user already has a pre-warm for that lab (at most one per user; one for another lab is replaced). `409 active_session_exists` while the user has a lab running; `503 at_capacity` like a start. See [Pre-warming](#pre-warming) |
| POST | `/sessions/prepare/cancel` | service | `{ user_id, lab? }` → `200 { ok: true, cancelled }`. Ends the user's pre-warm if it has not begun (`lab` narrows it to that lab); `cancelled: false` for a lab that is running, no session, or another lab. Never touches a begun session. Idempotent, safe to call from a closing page |
| POST | `/sessions/:id/begin` | session | `ready → running`: starts the lab clocks of a pre-warmed session → `{ meta, token }` (like resume, a token that outlives the session). Idempotent on anything already begun; `409 cannot_begin` once ended. `POST /sessions/start` does this itself |
| GET | `/sessions` | service | every live session (including `ready` pre-warms), newest first, max 200 |
| GET | `/sessions/:id` | session | the `status()` body: `{ meta, services, snapshots, checks?, cost, hints, pressure, manifest_summary?, checks_history, solution, server_time }` — see [Session status](#session-status) |
| GET | `/sessions/:id/solution` | session token only | the lab's solution as files, once the session has earned it → `200 { files: [{ path, content }], truncated }`; `404 no_solution`, `403 solution_locked`; the service key is refused with `403 session_token_required`. See [Solution reveal](#solution-reveal) |
| GET/PUT/DELETE | `/sessions/:id/files/:path` | session | under `/workspace`; PUT capped at 2 MiB |
| GET | `/sessions/:id/files?path=` | session | list; `path` defaults to `/workspace` but is **not** confined to it |
| POST | `/sessions/:id/checks` | session | `{ only? }` → runs and returns the full `ChecksRun`. `only` must name checks of the lab's manifest (400 `unknown_check` otherwise, empty list included). A session runs one check run at a time (409 `checks_running`) and at most one every 2 seconds, measured from the start of the previous run (429 `checks_too_frequent`). A run that would execute no check is never stored |
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
| DELETE | `/sessions/:id?snapshot=0` | session | ends the session; snapshots by default (never a `ready` one: it has no work to keep, and it cancels the pre-warm) |
| GET | `/users/:uid/progress` | service | per-lab standing from D1 `check_runs` → `{ labs: [{ slug, attempts, best_score, passed_all, last_run_at, sessions }] }`, most recently attempted first. `best_score` is the best weighted share of checks passed in one run (0-1); `passed_all` is true if any run passed every check of the lab; `sessions` counts distinct sessions that ran checks |
| GET | `/users/:uid/checks?lab=&limit=&before=` | service | a user's runs across sessions, newest first → `{ runs: [...] }` (same shape as the session route, plus `session_id` and `lab_slug`). `lab` filters to one lab; `before` is an epoch-ms cursor (pass the last `started_at` you saw); `limit` default 20, max 100 |
| GET | `/users/:uid/profile?compact=&starting=` | service | the learner's skill scores, XP, streak and awards → see [Profile, XP and awards](#profile-xp-and-awards). `compact=1` returns only what the Home widget needs; `starting=gateway:ok,mcp:new` echoes the onboarding quiz result. `400 bad_user_id`; an unknown user is a `200` with an empty profile |
| GET | `/users/:uid/awards` | service | `{ user_id, earned, locked }`, the same two lists as `profile.awards` |
| GET | `/users/:uid/sessions?active=1` | service | D1-backed history/active check; capped at 50 rows without `active=1` |
| PUT | `/users/:uid/path-inputs` | service | store the learner's quiz levels, goal and hours, then recompute their [learning path](#personal-learning-path). Body `{ areas, goal_text?, goal_kind?, hours_per_week }` → the path. `400 invalid_path_inputs` on a bad body |
| POST | `/users/:uid/path` | service | recompute the path from the stored inputs (a cache hit when nothing changed); `?force=1` skips the cache → the path. `404 no_inputs` |
| GET | `/users/:uid/path` | service | the path, from cache or built on the spot → the path. `404 no_inputs` when the user never sent inputs |

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
| 400 | `unknown_event_type` | `POST /sessions/{id}/events` with a type outside the injectable set (`cost`, `llm.call`, `alert`, `pressure`, `hint`, `solution.unlocked`, `session.idle_warning`, `session.expiring`, `session.state`, `service.health`) |
| 404 | `unknown_family` | a `/pools/:family` path that is not `agent` or `gateway` |
| 403 | `session_token_required` | `POST /sessions/{id}/services/{name}/session` or `GET /sessions/{id}/solution` called with the service key |
| 404 | `no_solution` | `GET /sessions/{id}/solution` for a lab version that has no solution (whatever the session's progress) |
| 403 | `solution_locked` | `GET /sessions/{id}/solution` before the unlock rule is met; `details: { rule, progress }`, the same shape as `solution` in the status |
| 500 | `solution_unreadable` | `GET /sessions/{id}/solution` when the stored archive is corrupt or holds an unsafe path (a publish defect, not the learner's) |
| 404 | `unknown_service` | restart, cookie route or proxy for a service not in the lab |
| 400 | `bad_feedback` | `POST /sessions/{id}/feedback` with a `rating` that is not an integer 1-5, a `text` that is not a string or is over 2000 characters, or a body that is not an object |
| 400 | `bad_user_id` | `GET /users/{uid}/profile` or `/awards` with an id that is empty, over 128 characters, or holds a control character |
| 400 | `unknown_check` | `POST /sessions/{id}/checks` with an `only` that is empty, not an array of strings, or names a check the lab does not have; the message lists the valid names (`details: { unknown?, valid }` when the error is raised in the Worker; over the DO boundary the message carries them) |
| 400 | `bad_cursor` | `GET /users/{uid}/checks` with a `before` that is not a number |
| 400 | `invalid_path_inputs` | `PUT /users/{uid}/path-inputs` with a body that fails validation; `details.issues` lists `{ path, message }` |
| 400 | `invalid_user_id` | a learning-path route whose `:uid` is empty or over 128 characters |
| 404 | `no_inputs` | `GET`/`POST /users/{uid}/path` for a user who never sent path inputs |
| 409 | `active_session_exists` | the user already has a live session (the D1 unique index) |
| 409 | `checks_running` | `POST /sessions/{id}/checks` while a check run of that session is still executing |
| 409 | `cannot_begin` | `POST /sessions/{id}/begin` on a session that has ended |
| 409 | `cannot_resume` | `POST /sessions/{id}/resume` on a session that is not `ended` |
| 409 | `no_snapshot` | resume with no snapshot to restore from |
| 409 | `not_running` | the session is not running (still starting, resuming, recovering or ended) |
| 409 | `session_recovering` | a stale process/terminal handle; the container was replaced |
| 409 | `version_exists` | `POST /labs/publish` for a `<slug>/<version>` that is already published, without `force` |
| 409 | `file_exists` | SDK `FileExistsError` |
| 429 | `checks_too_frequent` | `POST /sessions/{id}/checks` less than 2 seconds after the previous run started; `details.retry_after_ms` is the wait left (also in the message as `retry_after_ms=N`) |
| 413 | `payload_too_large` | `PUT .../files/...` over 2 MiB, or the SDK's own file-size limit |
| 502 | `service_down` | service proxy while that service is `unhealthy` |
| 503 | `at_capacity` | `POST /sessions`, `POST /sessions/start`: the family's pool is at `max_instances` or backing off; `details.retry_after_s`, and the `Retry-After` header carries the same number |
| 503 | `container_unavailable` | SDK `ContainerUnavailableError`; `details.retry_after_ms` when the SDK supplies it |
| 503 | `sdk_transient` | SDK `OperationInterruptedError` / `RPCTransportError` |
| 500 | `internal_error` | anything unrecognised: the message is the fixed text `Internal error` (or `Could not reserve the session slot`), never the underlying error, which is logged server-side; `details.error_name` carries the original class name |

## Profile, XP and awards

A learner's skill scores, XP, streak and awards, for the profile page and the
Home widget. Service key only, like the other `/users/:uid/*` routes; the
console Worker calls them for the signed-in learner. Everything is a pure
function of the learner's facts: skill scores and XP are recomputed from D1
`check_runs` and `sessions` on every read (never stored, never incremented), and
only the awards are stored, in `awards(user_id, award_id, earned_at, session_id)`
(migration `0009_awards.sql`), so a date never moves once written. The code is
in `src/profile/`; `computeProfile(facts, catalogue)` is the pure core.

`GET /users/:uid/profile`

```json
{
  "user_id": "u1",
  "xp": 275,
  "level": { "n": 3, "title": "Apprentice", "xp_into": 25, "xp_needed": 250 },
  "streak": { "days": 2, "best": 4, "last_active": "2026-01-06" },
  "skills": [
    {
      "area": "gateway", "title": "LLM gateway", "score": 67, "level": "Proficient",
      "evaluation": "You are confident in LLM gateway: 3 of 6 labs finished, with strong results. Next up: \"One endpoint, one key\".",
      "labs_done": 3, "labs_total": 6,
      "next_lab": { "slug": "one-endpoint-one-key", "title": "One endpoint, one key" },
      "starting_level": null
    }
  ],
  "awards": {
    "earned": [{ "id": "first-lab", "title": "First steps", "description": "Finish your first lab.", "icon": "flag", "tier": "bronze", "earned_at": 1767700000000, "session_id": "…" }],
    "locked": [{ "id": "ten-labs", "title": "Ten down", "description": "Finish ten labs.", "icon": "trophy", "tier": "silver", "progress": { "have": 3, "need": 10 } }]
  },
  "overall": { "score": 11, "level": "Foundations", "evaluation": "Overall you are at Foundations level. …" },
  "updated_at": 1767700000000
}
```

- `skills` has the six areas of the onboarding quiz, always, in the quiz's order
  (`gateway`, `mcp`, `rag`, `otel`, `platform`, `sovereignty`). A lab feeds an
  area through its catalogue `path` and `module`; the single mapping is
  `src/profile/areas.ts`. A lab in no area (the optional runtime module, the
  other paths) feeds no skill but still earns XP and counts for awards.
  Archived labs, and labs the catalogue does not list, count for nothing.
- `level` on a skill and on `overall` is a name: `Not started` (0),
  `Foundations` (1-29), `Practitioner` (30-59), `Proficient` (60-84), `Expert`
  (85-100). `overall.score` is the mean of the six area scores, rounded.
- `evaluation` is plain sentences chosen by fixed rules (a strength for the
  level, then the next lab to do in that area in catalogue order, preferring one
  whose prerequisites are done). No model is involved.
- `next_lab` is `null` when the area has no labs or all are finished.
- `starting_level` (`new`, `ok`, `strong`, or `null`) is the onboarding quiz
  result for the area, a starting point only and never part of a score. The
  quiz result lives in the browser, so the caller passes it as
  `?starting=gateway:strong,mcp:new`; unknown areas and levels are ignored.
- `level` (top level) is the XP level: ten titled levels (Newcomer, Explorer,
  Apprentice, Builder, Engineer, Specialist, Architect, Mentor, Master, Legend)
  starting at 0, 100, 250, 500, 850, 1300, 1900, 2600, 3500 and 4600 XP.
  `xp_into` is XP past the level's start and `xp_needed` is the width of the
  level's band (`0` at level 10).
- `streak` counts consecutive UTC calendar days with a passing run (so every
  completed lab counts). `days` is the streak now: it stays alive through the
  end of the day after the last active day, then drops to 0. `best` is the
  longest ever. `last_active` is `YYYY-MM-DD` (UTC) or `null`.
- `awards.earned` is newest first; `awards.locked` is in display order and
  every entry has `progress: { have, need }`. `icon` is one of `flag`,
  `target`, `feather`, `stack`, `trophy`, `flame`, `bolt`, `refresh`, `puzzle`,
  `map`, `star`, `medal`, `compass`.
- `updated_at` is the epoch ms the profile was computed.

`GET /users/:uid/profile?compact=1` is the Home widget's slice:

```json
{
  "user_id": "u1",
  "overall": { "score": 11, "level": "Foundations", "evaluation": "…" },
  "level": { "n": 3, "title": "Apprentice", "xp_into": 25, "xp_needed": 250 },
  "xp": 275,
  "streak": { "days": 2, "best": 4, "last_active": "2026-01-06" },
  "top_skills": [{ "area": "gateway", "title": "LLM gateway", "score": 67, "level": "Proficient" }],
  "recent_awards": [],
  "updated_at": 1767700000000
}
```

`top_skills` is the three highest scores (ties in area order; a new learner gets
three `Not started` areas); `recent_awards` is the three most recently earned.

`GET /users/:uid/awards` returns `{ user_id, earned, locked }`, the same lists as
`profile.awards`.

**Errors.** `401 unauthorized` without the service key; `400 bad_user_id` for an
id that is empty, longer than 128 characters or holds a control character. A
user with no activity is not an error: it is a `200` with zero scores, level 1
and every award locked. A D1 failure is a `500`.

### How a lab is scored

A lab's score, 0-100, comes from the learner's best run of it (highest share of
check weight passed; a run that passed every check beats an equal partial one;
ties keep the earliest):

```
raw     = best run's score x 100
hinted  = max(raw x 0.6, raw - 5 x hints)         each hint costs 5 points, never below 60% of raw
factor  = max(0.8, 1 - 0.03 x (attempts - 1))     first try is full; 3% per extra run, floor 80%
lab     = hinted x factor
```

`hints` is how many hints had unlocked in the best run's session and `attempts`
is how many runs of that lab it took to reach the best run. An area's score is
the average of its labs weighted by difficulty (`intro` 1, `core` 2, `advanced`
3; no difficulty counts as `core`) over ALL the area's non-archived labs, an
unattempted lab counting as 0, rounded to a whole number (any score above 0
shows as at least 1).

**XP.** A completed lab (a run that passed every check; only the first counts)
earns `intro` 50, `core` 100 or `advanced` 150, plus 25 if no hint had unlocked
in the completing session, plus 25 if the very first run of the lab passed.

**Awards** (`earned_at` is when the learner qualified, taken from the facts
where they say so, and is stored the first time and never changed; an earned
award is never taken back):

| id | tier | earned when |
|---|---|---|
| `first-lab` | bronze | one lab completed |
| `first-try-pass` | bronze | a lab's first run passed everything |
| `no-hints-finish` | bronze | a lab completed in a session with no hint unlocked |
| `three-labs` / `ten-labs` | bronze / silver | 3 / 10 labs completed |
| `streak-3-days` / `streak-7-days` | bronze / silver | best streak of 3 / 7 UTC days |
| `module-complete-{path}-{module}` | silver | every lab of a module completed; only for paths with more than one module (a one-module path is its module, and gets `path-complete-*` instead) |
| `path-complete-{path}` | gold | every lab of a path completed |
| `area-proficient-{area}` | silver | area score at least 60 |
| `area-expert-{area}` | gold | area score at least 85 |
| `speed-run` | silver | a lab completed in under 50% of its `estimated_minutes`, measured from its session starting |
| `comeback` | bronze | a passing run after a run with a failing check, in the same session |
| `all-six-areas` | gold | every area at Foundations (score 1) or better |

Awards are stored after each finished check run (the run's session id goes in
`awards.session_id`), and each new one is announced on that session's event
stream as `award.earned`. A profile read also stores any award the learner has
already qualified for but nothing announced (learners from before awards
existed), without an event. Storing is `INSERT ... ON CONFLICT DO NOTHING`, so
recomputing any number of times is idempotent.

## Learn bundle

The learning layer of a lab (`labs/<slug>/learn/`, authored as described in
`docs/learning-content.md`). `labs publish` compiles the folder with
`compileLearnDir` (`cli/src/learn-compile.ts`) and refuses to publish while
there are problems, listing all of them; the compiled JSON goes up as the
`learn` part of `POST /labs/publish`. The Worker parses it again with
`parseLearnBundle` (`src/labs/learn.ts`) and stores the parsed form, defaults
filled in, at `labs/{slug}/{version}/learn.json` in R2, next to `manifest.json`
(same key layout as `solution.tgz`, but this one is served to learners).
`GET /labs/:slug/learn` returns it for the current version as
`{ version, learn }`. The catalogue entry's `has_learn` says whether the file
exists, so the console can skip the request.

`learn` holds only what the author wrote under `learn/`; nothing from
`checks/`, `solution/` or `workspace/` is ever part of it. (The quiz's
`answer` arrays are in it, because the console grades the quiz in the
browser. They are answers to the concept questions, not to the lab's graded
checks.)

```json
{
  "version": 1,
  "story":     { "title": "…", "minutes": 2, "body": "markdown, no HTML" },
  "concepts":  [{ "id": "gateway.routing-aliases", "title": "…", "minutes": 3, "recap": "one line", "body": "markdown" }],
  "questions": [{ "id": "q-alias-purpose", "concept": "gateway.routing-aliases", "type": "single",
                  "prompt": "…", "options": [{ "id": "a", "text": "…" }], "answer": ["a"],
                  "explanation": "…", "diagnostic": true }],
  "comic":     { "title": "…", "pages": [{ "panels": [ … ] }] },
  "audio":     { "model": "@cf/deepgram/aura-2-en", "clips": { "82111213e8173703": { "voice": "thalia", "text": "…", "seconds": 5.06, "bytes": 24384 } },
                 "lines": [{ "panel": 0, "kind": "voiceover", "clip": "82111213e8173703" }] },
  "answers_file": "answers.json",
  "fields":    [{ "key": "support_deployment", "prompt": "…", "kind": "choice", "choices": ["a", "b"], "help": "…" }]
}
```

`story` is absent when the lab has no `story.md`; `comic` and `audio` when it has no `comic.yaml` or no narration (see below). `concepts` (at most 8),
`questions` (at most 40) and `fields` (at most 12) may be empty arrays. Every
concept id must be in `packages/catalogue/concepts.json`, every question's
concept must have a lesson in the same bundle, and every lesson needs a
diagnostic question; the schema and the cross-checks live in
`src/labs/learn.ts` and are shared by the CLI and the Worker.

Old versions keep the bundle they were published with. Rolling `current` back
(`POST /labs/:slug/promote`) changes what `GET /labs/:slug/learn` serves, and
`has_learn` follows after the index rebuild the promote already performs.

### Narration clips

A comic can be narrated by one storyteller voice (`labs narrate`, see
`docs/learning-content.md#narration-the-storyteller`). Each panel of the comic may carry a
`voiceover` (plain single-line text, up to 240 characters); the narrator reads it, and nothing else
(captions and speech bubbles are shown as text and never voiced). The bundle's `audio` is the index:
`clips` maps a 16-hex key to `{ voice, text, seconds, bytes }` (at most 80 clips, each at most 400 KB and
70 s; `text` up to 240 characters), and `lines` lists, in reading order, which clip reads which
panel's voiceover (`{ panel, kind: "voiceover", clip }`; `panel` counts across pages from 0; a panel with no
voiceover has no line). `parseLearnBundle` cross-checks it against the comic with the same
`narrationLines` the CLI used (`src/labs/comic-kit.ts`): audio that is not word for word the comic's
voiceovers, in the narrator voice, is `400 invalid_learn_bundle` ("out of date, run `labs narrate`").
Narration stays optional, but a comic with a voiceover that carries audio must carry audio of this shape: the older shape (`kind` `caption` or `bubble`,
several voices) still parses, and is accepted only for a comic that has no voiceover at all (a lab not yet
rewritten); with a voiceover in the comic it is refused as out of date. A console plays only the new shape and
plays any other, or any mismatch, silent. A comic with a voiceover is also held to the storyteller
contract by the same check: only `maren`, `tomasz` and `you` in `cast` or as a bubble speaker (the
retired `priya`, `jonas` and `anneke` still parse but are refused), and at most 9 panels in all.

The clips themselves are `audio` parts of `POST /labs/publish` (content type `audio/mpeg`, file
name `<key>.mp3`). The Worker rejects the publish with `400 invalid_audio`, storing nothing, unless every
name is `<16 hex>.mp3` and unique, there are at most 80, each is at most 400 KB, starts like an MP3
and is exactly the `bytes` the index says, and the uploaded set is exactly the set the index names (an
unreferenced or missing clip is refused). They are stored at `labs/{slug}/{version}/audio/<key>.mp3`
and served by `GET /labs/:slug/audio/:file` (service key; `Range` supported so a clip can seek). A
forced re-publish leaves exactly that publish's clips. Nothing from `checks/` or `solution/` is
reachable through the route.

## Personal learning path

Turns the platform quiz into an ordered list of labs for one learner. The
design is **the rules choose the labs, a model may order them, the server
checks the order.** All three routes take the service key (the console Worker
calls them for a signed-in learner); nothing here is reachable with a session
token.

### Inputs: `PUT /users/:uid/path-inputs`

```json
{
  "areas": { "gateway": "new", "mcp": "familiar", "rag": "strong" },
  "goal_text": "Run our company's AI gateway",
  "goal_kind": "role-ready",
  "hours_per_week": 4
}
```

| Field | Rule |
|---|---|
| `areas` | required object; keys are quiz areas from `packages/catalogue/concepts.json` (`gateway`, `mcp`, `rag`, `otel`, `platform`, `sovereignty`), values `new`, `familiar` or `strong`. The console's own `ok` is accepted and stored as `familiar`. An area left out has no adjustment. An unknown key or level is rejected |
| `goal_text` | optional string, at most 200 characters (201 is rejected). Whitespace and control characters collapse to single spaces; empty means no goal |
| `goal_kind` | `role-ready`, `specific-skill` or `explore` (default `explore`) |
| `hours_per_week` | required whole number, 1 to 20 |

An unknown field anywhere is rejected too. A failure is
`400 invalid_path_inputs` with every problem in `message` and in
`details.issues`, and nothing is stored. A valid body replaces the user's
previous inputs (one row per user, `user_profile_inputs`) and the response is
the recomputed path. The console calls this again after a quiz retake.
`goal_text` is free text the learner typed: it lives only in that row and is
never logged.

### The path: `GET` and `POST /users/:uid/path`

`GET` returns the stored path, building it first if the inputs, the catalogue,
the user's completed labs or their plan changed since it was stored.
`POST` does the same and `?force=1` rebuilds regardless of the cache. Both
answer `404 no_inputs` when the user never sent inputs. All three routes
(including `PUT`) return the path itself, with an `x-path-cache` header:
`hit` (served from storage, no model call), `miss` (rebuilt) or `forced`.

```json
{
  "steps": [
    { "slug": "see-what-a-gateway-does", "title": "See what a gateway does", "area": "gateway",
      "why": "You have already finished this lab.", "estimated_minutes": 20, "status": "done" },
    { "slug": "add-a-model-without-touching-app-code", "title": "Add a model without touching app code", "area": "gateway",
      "why": "A first step into LLM gateway, which is new to you.", "estimated_minutes": 30, "status": "next" }
  ],
  "total_minutes": 30,
  "weeks_estimate": 1,
  "goal": { "text": "Run our company's AI gateway", "kind": "role-ready" },
  "source": "ai",
  "generated_at": 1767000000000
}
```

- `steps` are, in this order: labs the learner has **done**, the labs still to
  do in path order, then labs their plan **locks**. `status` is `done`; `next`
  (the first step that is not done and not locked; absent when nothing is
  left to do); `upcoming`; or `locked`.
- `area` is the quiz area the lab belongs to (the area whose `path` and `module`
  in `concepts.json` match the lab's), or `null` for a lab outside every area.
- `why` is one plain sentence of at most 120 characters. A done step and a locked
  step get a stock line; a model's reason that is missing, longer than 120
  characters, or looks like code or a link is replaced by a generic one
  ("A first step into LLM gateway, which is new to you.", "Builds on the earlier
  steps in Retrieval.", "One lab to confirm what you already know about Tools and
  MCP.", "The next step on your path.").
- `estimated_minutes` is the manifest's, or 30 when the manifest sets none.
- `total_minutes` is the time **still to do**: the steps that are neither done nor
  locked. `weeks_estimate` is that time at `hours_per_week`, rounded up (0 when
  nothing is left).
- `source` is `ai` when a model ordered the labs and `rules` when the rules' own
  order is used. `generated_at` is epoch milliseconds.

### The rules (which labs, and a baseline order)

`src/path/rules.ts`, pure and unit tested. They apply in this order:

1. **Archived** labs are never on a path.
2. **Completed** labs (some `check_runs` row for the user and lab with
   `passed_all`, the same fact as `GET /users/:uid/progress`) are shown as
   `done` and never offered again.
3. **Plan.** The free plan may start only labs with `tier: free` (the manifest's
   "whether the free plan may start this lab"). Any other lab is `locked` for a
   free learner, and so is a lab with a locked prerequisite. Locked labs are
   listed last, are never given to the model and do not count in the totals. The
   plan is `users.plan` (`free`, or any other value for a paid plan); a user with no
   `users` row is free. A completed pro lab still shows as `done`. The Worker does
   not enforce the plan when a session starts today, so this rule is the one place
   the path applies it.
4. **Strong areas** are skipped, except one capstone: the highest-order lab of
   that area the learner's plan can start. Skipped labs count as known, so the
   capstone's prerequisites inside the area are satisfied without being on the
   path.
5. **Prerequisites.** A lab is only on the path after its prerequisites: each is
   earlier on the path, completed, or skipped under rule 4. A prerequisite that is
   not in the catalogue, or is archived, is ignored. A cycle cannot be satisfied;
   its labs are kept in catalogue order rather than dropped.
6. **New areas** start with their foundation labs (the area's `difficulty: intro`
   labs, or its first lab when it has none), ahead of everything else. The rest is
   catalogue order (`path`, `module`, `order`, `slug`).

### The model orders within the rules

When at least two labs are allowed, the Worker asks Workers AI to put them in the
best order for the learner's goal, hours and quiz levels, with one short reason per
lab. With fewer there is nothing to order and no call is made.

- **Call path.** `wrangler.jsonc` declares no `AI` binding, so the call goes the way
  the labs' model calls do: the AI Gateway's OpenAI-compatible endpoint,
  `https://{LLM_HOST}/v1/{CLOUDFLARE_ACCOUNT_ID}/{AI_GATEWAY_NAME}/compat/chat/completions`,
  with `Authorization: Bearer {AI_GATEWAY_TOKEN}` (see the AI Gateway section of
  `docs/spike.md`). The Worker holds the token itself, so no egress rule is involved.
- **Request.** Model `workers-ai/@cf/meta/llama-3.1-8b-instruct-fp8` (the constant
  `PATH_MODEL` in `src/path/ai.ts`), `temperature: 0`, and `response_format: { type: "json_object" }` (this model
  refuses JSON-schema mode with a 403, so the shape `{ "steps": [{ "slug", "why" }] }`,
  `why` at most 120 characters, is spelled out in the prompt and enforced by the server). The prompt carries the goal (quoted, as data), hours per week, quiz
  levels and the allowed labs with title, area, difficulty, minutes and
  prerequisites. `cf-aig-cache-ttl: 86400` is set, and `cf-aig-skip-cache: true` on
  `?force=1`.
- **The server validates the answer, always.** The path is exactly the allowed
  set, each lab once. Slugs the model made up are dropped, a duplicate keeps its
  first place (and first reason), allowed labs it left out are appended in rules
  order, and a lab that precedes one of its prerequisites is moved to just after
  it (a stable topological fix-up). `source` is still `ai`.
- **Fallback.** A call that fails, answers non-200, returns something that is not
  the JSON shape, or does not answer within **6 seconds** is not an error: the path
  is the rules' order with generic reasons and `source: "rules"`. It is stored and
  cached like any other, so a model outage does not turn into a call per read.
  `?force=1` tries the model again.

### Cache

`user_paths` holds one row per user: `input_hash`, `path_json`, `source`, `model`
(`NULL` for `rules`), `created_at`, `updated_at`. `input_hash` is the SHA-256 of a
canonical form of: the quiz levels, goal text and kind, hours per week, the plan,
the allowed labs as `slug@version`, the locked labs, the completed set, the model
id and a prompt version. Same hash: the stored path is returned and **no model call
is made**. Any change to those (a retake, an edit, a lab completed, a new lab
version, a plan change, a model change) makes a new hash and the next read rebuilds
the path. A retake with identical answers is a hit.

### Refresh on completion

When a check run passes every check of a lab (the moment the session's
`completed_at` is set), the Worker calls `refreshPath(env, userId)` in the
background, after the `check_runs` row is written. It never delays or fails the
run. It uses **no model**: when the hash has changed it keeps the stored order and
the stored reasons, marks the finished lab `done`, moves `next`, appends any lab
published since (generic reason) and stores the result under the new hash, so the
next read is a hit. A user with no inputs or no stored path is skipped (their first
read builds the path), and an unchanged hash does nothing. Use
`POST /users/:uid/path?force=1` to have the model re-order from scratch.

Storage: `migrations/0010_learning_path.sql` adds `user_profile_inputs` and
`user_paths`.

## Learning analytics

`POST /learn/answers` (service key) records which quiz questions learners get
right. The console Worker calls it once per finished quiz.

```json
{
  "lab_slug": "see-what-a-gateway-does",
  "lab_version": "1.0.0",
  "answers": [
    { "question_id": "q-alias-purpose", "concept": "gateway.routing-aliases", "correct": true, "phase": "diagnostic" }
  ]
}
```

- `lab_slug` and `lab_version` are optional (the onboarding quiz belongs to no
  lab); `phase` is `onboarding` or `diagnostic`. `answers` has 1 to 60 items.
- The body is validated strictly: an unknown key anywhere, such as
  `user_id`, is `400 bad_answers`. **The table has no user id, no session id
  and no IP address** (`learn_answers`, `migrations/0008_learn_answers.sql`),
  so a row cannot be tied to a learner.
- All rows of one request are inserted in a single D1 batch (all or none).
  The Worker does not check that a `question_id` exists in the lab's bundle.

`GET /admin/learning` reads the table back; see
[Admin routes](#admin-routes-service-key-only).

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
| `solution` | `{ available, unlocked, rule, progress: { check_runs, hints_delivered, hints_total, completed } }` — see [Solution reveal](#solution-reveal) |
| `server_time` | server epoch ms, for correcting client clock skew against `meta.expires_at` |

The `sessions` row in D1 also gets `hints_delivered` (count) and, at the
first run that passes every check, `completed_at`; `check_runs` rows carry
`user_id`, `lab_slug`, `lab_version`, `score` and `passed_all`
(migration `0005_product.sql`). A run limited with `only` never counts as
`passed_all`, since it did not cover every check.

## Solution reveal

Once a learner has made a real attempt, the lab's `solution/` is shown to
them as files to diff against their own work. `labs publish` uploads it (see
`docs/lab-authoring.md`); the Worker keeps it at
`labs/{slug}/{version}/solution.tgz`, private like `private.tgz`.

**The rule.** A session has earned the solution when either

- it has passed every check (some check run passed all of the lab's checks,
  the condition behind `sessions.completed_at`; a run limited with `only`
  never counts), or
- every hint the manifest defines has been delivered **and** at least two
  check runs have happened. A lab with no hints needs only the two runs.

The run count is a persisted per-session counter, not the length of
`checks_history` (which keeps ten). Once earned, the solution stays earned.
`solution.rule` carries the fixed text "Pass every check, or use every hint
and run the checks twice."

**Status.** `solution` in `GET /sessions/:id`: `available` is true iff the lab
version this session runs has a `solution.tgz`; `unlocked` is the rule above;
`progress` is `{ check_runs, hints_delivered, hints_total, completed }`.
`unlocked` can be true while `available` is false.

**Route.** `GET /sessions/:id/solution` takes a session token only. In order:
`404 no_solution` when `available` is false (a session with no solution to
show is never told it is "locked"); `403 solution_locked` with
`details: { rule, progress }` while locked; otherwise
`200 { files: [{ path, content }], truncated }`. `path` is relative to
`/workspace`, files are sorted by path, and only text is returned: a file
that is not valid UTF-8, or that contains a NUL byte, is skipped. Caps: 64 KB
per file, 40 files, 512 KB in all, and the archive is read at most 16 MiB
unpacked. A text file dropped by a cap sets `truncated: true`. The Worker
gunzips and untars in memory; regular files only, and an archive holding an
absolute path or a `..` segment is refused (`500 solution_unreadable`).

**Event.** `solution.unlocked` (`data: {}`) is emitted once per session, at
the end of the check run or on the delivery of the last hint that makes the
rule true. The flag is stored with the session, so a container recovery or a
resume never repeats it. It is not emitted for a lab version with no
solution.

## Session lifecycle

`starting → running → ended`, with `recovering` and `resuming` as transient
sub-states of `running`, and `ready` as an optional stop between `starting`
and `running` for a [pre-warmed](#pre-warming) session. (`created` exists in
the `SessionState` type but no code path ever sets it.) `POST /sessions` returns as soon as the session row
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

## Pre-warming

The console starts a lab's container while the learner is still reading the
last steps of "Before you begin", so Start is instant. It is built from three
calls and one state.

```
POST /sessions/prepare   starting ── (container claimed, hydrated, env, services) ──► ready
POST /sessions/start     ready ── begin ──► running          (or  POST /sessions/:id/begin)
POST /sessions/prepare/cancel | DELETE /sessions/:id | 10 minutes   ready ──► ended
```

- **`ready` has no lab clock.** The container is fully started, but
  `started_at` and `expires_at` are unset and no hard, idle, pressure, hint,
  metrics or health timer exists. The single timer is `prepare_expiry`, set
  `PREPARE_TTL_MS` (10 minutes) after the session became `ready`: it ends the
  session with `end_reason: "unclaimed"`, no snapshot, and releases the
  container, so an abandoned prefetch costs about ten minutes of one
  container. `meta.prepare` is true from creation until the lab begins;
  `meta.prepared_at` records when it became `ready` and is kept after.
- **Begin** (`POST /sessions/{id}/begin`, or `POST /sessions/start` for that
  user and lab) sets `started_at`, `expires_at = now + timeout_minutes`,
  cancels `prepare_expiry` and schedules exactly the timers a normal start
  does (one shared function, `scheduleRunTimers`, also used by resume). A
  `ready` session's time is not billed to the lab: the cost cursor starts at
  begin. Begun while still `starting`, the session simply finishes its start
  into `running` instead of parking.
- **`POST /sessions/start` reuses it.** For a user with a `ready` (or still
  booting) pre-warm of the requested lab it begins that session and answers
  `202 { id, state, token, urls }`, the shape of a cold start (`state` is
  `running`, or `starting` if the boot had not finished); there is no
  `rejoined` flag. A pre-warm of another lab is cancelled and the start is
  cold; one that ended a moment ago also falls back to a cold start.
- **One slot per user.** `ready` holds the same one-active-session slot as
  `running` (migration `0011_ready_state.sql` rebuilds the partial unique
  index), so a user has at most one pre-warm and a pre-warm and a live lab
  cannot coexist. A second `prepare` returns the first.
- **Cancel.** `DELETE /sessions/{id}` on a `ready` session ends it
  (`end_reason: "user"`, never a snapshot). `POST /sessions/prepare/cancel`
  is the same by user instead of id, and refuses to touch a session that has
  begun (the check runs inside the Session DO), which is what makes it safe
  for a closing page to send blindly.
- **Failure.** If the container claim or the boot fails during a prepare, the
  session ends with `end_reason: "error"` like any failed start and the user's
  slot is free; the later `POST /sessions/start` is then an ordinary cold
  start. `GET /usage` ignores sessions that never started (`started_at` is
  null), so a ready window is not in that estimate; the admin summaries
  exclude `unclaimed` sessions from their counts.
- **Invisible to the learner.** A `ready` session never reaches the console:
  `POST /api/prepare` returns no id or token, so there is no remembered
  session, no Rejoin card and no "lab running". `GET /sessions/:id` shows
  `state: "ready"` and `meta.prepared_at` to a service-key caller (ops).

## Events

`GET /sessions/{id}/events` is an SSE stream. Each frame carries a numeric
`id:` (the SQL row's `seq`) usable as `Last-Event-ID` on reconnect; without
one, the last 50 events are replayed. The log is capped at the most recent
1000 events. A `: ping` comment is sent every 20 seconds.

| `event:` | `data` |
|---|---|
| `session.state` | `{ state }`, plus `recovered: true`, `resumed: true`, `began: true` (a pre-warm that has begun) or `reason` on the relevant transitions; `state: "ready"` when a pre-warm has finished booting |
| `session.expiring` | `{ reason: "hard_timeout" }` |
| `session.idle_warning` | `{ idle_ms }` |
| `service.health` | `{ service, health }`, plus `restarted: true`, `relaunched: true`, or `reason` + `logs_tail` on a failed start |
| `container.restarted` | `{ reason }` — the container was replaced and recovery has begun |
| `pressure` | `{ event_id, title, message }` |
| `hint` | `{ index, after_minutes, text }` — one per `hints[]` entry, on its own timer |
| `solution.unlocked` | `{}` — once per session, when the [solution reveal](#solution-reveal) rule first becomes true and the lab has a solution |
| `award.earned` | `{ id, title, tier }` — once per award, right after the check run that earned it is stored. Tier is `bronze`, `silver` or `gold`. Best effort: a failure to compute awards never fails the run, it only means no toast. See [Profile, XP and awards](#profile-xp-and-awards) |
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

## Admin routes (service key only)

These back the admin panel (`admin/`, see `docs/admin.md`). Every one requires
the service key; a session token is refused. They are registered by
`src/admin.ts`.

| Route | Returns |
|---|---|
| `GET /admin/sessions?state=&lab=&user=&limit=&before=` | Sessions in any state, newest first, with cost, running seconds, completion and hints delivered. `limit` defaults to 50 (max 200); `before` is a `created_at` cursor in ms; the reply carries `next` when there is more. |
| `GET /admin/usage/summary?from=&to=` | Totals, the top 20 labs by cost, cost per UTC day, and `completion` (`completed`, `ended`, `rate`) for the window (default the last 30 days). The LLM figure is self-reported by the container, not reconciled against billing. |
| `GET /admin/users?limit=&before=` | Each distinct `user_id` with session count, last session, total cost, completed count and plan when a `users` row exists. |
| `GET /admin/waitlist?limit=&before=` | Waitlist rows, newest first; `{ available: false, rows: [] }` if the table does not exist. |
| `GET /admin/feedback?limit=&before=` | Lab feedback and site feedback merged newest first, each with a `source`; `missing` names a table that does not exist. |
| `GET /admin/learning?lab=&from=&to=` | Quiz-answer analytics from the anonymous `learn_answers` table: `{ available, questions: [{ lab_slug, question_id, concept, attempts, correct, percent_correct }], concepts: [{ concept, attempts, correct, percent_correct }] }`. Questions are grouped per `(lab_slug, question_id)` (`lab_slug` is `null` for the onboarding quiz), weakest first, at most 500; concepts are totals per concept id, at most 200. `percent_correct` is 0 to 100 with one decimal. `lab` narrows to one lab; `from` / `to` (epoch ms or an ISO date) bound `created_at` and default to all time. `{ available: false, questions: [], concepts: [] }` if the table does not exist. |
| `GET /labs/:slug/versions` | Every published version of a lab with its manifest title, version and estimated minutes, and which is `current` and `previous`. |
| `POST /labs/:slug/promote` body `{ "version": "1.2.0" }` | Points `current` at that version (the old one becomes `previous`) and rebuilds the catalogue index. `404 unknown_version` if it was never published; promoting the current version is a no-op apart from the index rebuild. |

Only a missing table or column is reported as `available: false`; any other
database error is a 500.
