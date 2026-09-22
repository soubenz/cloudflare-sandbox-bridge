# Opalix sandbox API

Base URL: `PUBLIC_BASE_URL` in `wrangler.jsonc` (e.g. `https://labs-api.opalix.ai`).

## Auth

Two credential kinds:

- **Service key** (`Authorization: Bearer <SANDBOX_API_KEY>`) — for the app
  backend and the CLI. Required on `POST /sessions`, `/labs/*`, `/pools/*`,
  `/users/*`, and `POST /sessions/{id}/events`.
- **Session token** — minted by `POST /sessions`, short-lived (session
  `expires_at` + 10 minutes). Accepted as `Authorization: Bearer <token>`,
  `?token=<token>` (browser links), or the `opx_s_{id}` cookie the service
  proxy sets on first use. Required on every other `/sessions/{id}/*` route.
  A session token only authenticates its own session — using it against a
  different session id is rejected.

## Routes

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | liveness |
| GET | `/labs` | service | catalogue |
| GET | `/labs/:slug` | service | current version + manifest |
| POST | `/labs/publish` | service | multipart: `manifest`, `workspace`, `private` files |
| GET | `/pools`, `/pools/:family` | service | warm pool stats |
| POST | `/pools/:family/prime` | service | `{ target? }` |
| POST | `/sessions` | service | `{ lab, user_id }` → `202 { id, state, token, urls }` |
| GET | `/sessions/:id` | session | status, services, snapshots, last checks |
| GET/PUT/DELETE | `/sessions/:id/files/:path` | session | under `/workspace`; PUT capped at 2 MiB |
| GET | `/sessions/:id/files?path=` | session | list |
| POST | `/sessions/:id/checks` | session | `{ only? }` → runs and returns results |
| GET | `/sessions/:id/events` | session | SSE, replays from `Last-Event-ID` |
| POST | `/sessions/:id/events` | service | `{ type, data }` — the LLM Worker reporting cost/calls |
| POST | `/sessions/:id/services/:name/restart` | session | |
| ANY | `/sessions/:id/services/:name/*` | session | path-based UI proxy |
| WS | `/sessions/:id/terminal` | session | relayed PTY |
| POST | `/sessions/:id/snapshot` | session | |
| POST | `/sessions/:id/resume` | session | requires a snapshot; new token returned |
| DELETE | `/sessions/:id?snapshot=0` | session | ends the session; snapshots by default |
| GET | `/users/:uid/sessions?active=1` | service | D1-backed history/active check |

## Session lifecycle

`created → starting → running → ended`, with `recovering` and `resuming` as
transient sub-states of `running`. `POST /sessions` returns as soon as the
session row exists (`state: "starting"`); poll `GET /sessions/:id` or watch
`session.state` on the event stream for `running`.

Every session has a hard timeout (`manifest.timeout_minutes`, 60-120) and an
idle timeout (`manifest.idle_minutes`, default 10, reset by any file write,
terminal input, check run, or service restart). Both snapshot before
destroying the container, so `POST /sessions/:id/resume` picks up where it
left off in a fresh container.

## Events

`event:` names on the SSE stream: `session.state`, `session.expiring`,
`session.idle_warning`, `service.health`, `container.restarted`, `pressure`,
`check.started`, `check.result`, `check.finished`, `snapshot.created`,
`metrics`, `cost`, `llm.call`, `alert`. Each event carries a numeric `id:`
(the SQL row's `seq`) usable as `Last-Event-ID` on reconnect.

## Backend abstraction

Every route above talks to the container only through `src/session/backend.ts`'s
`Backend` interface (`CloudflareBackend` wraps `@cloudflare/sandbox`). A
future non-Cloudflare backend (rented VMs, k3s, Kata — the "cluster backend"
in the product plan, or a cost-driven move off Cloudflare per the pricing
review) implements the same interface; no route or manifest field changes.
