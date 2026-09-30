# Opalix Ops (the admin panel)

An internal back office for the owner. It is a separate Worker, `opalix-admin` (`admin/`), on its own origin with its own password and cookie. It is not the learner console (`dashboard/`): a leaked console cookie opens nothing here.

The browser only ever talks to this Worker. The Worker holds the API's service key and adds it to every call it forwards, so the key never reaches the browser.

## Screens

| Tab | What it does | Calls |
|---|---|---|
| Sessions | Live sessions, each with an **End** button (confirm first; the workspace is snapshotted, then the container is released). Below it, session history in any state with state, lab and user filters, cost, and "Load more". | `GET /sessions`, `DELETE /sessions/:id`, `GET /admin/sessions` |
| Pools | One tile per family: warm, claimed, max, available slots, degraded flag and the last start error. **Prime** and **Drain** (confirm first). | `GET /pools`, `POST /pools/:family/prime`, `POST /pools/:family/drain` |
| Catalogue | Every published lab with tier, path and module. A row expands to its stored versions, marks `current` and `previous`, and offers **Promote** (confirm first) to make another version current or roll back. | `GET /labs`, `GET /labs/:slug/versions`, `POST /labs/:slug/promote` |
| Usage & cost | Sessions, running time, container cost, LLM cost and completion rate for the last 7, 30 or 90 days, a bar chart of cost by day (UTC) and a table by lab. | `GET /admin/usage/summary` |
| Users | Every distinct `user_id` with session count, completed count, last session, total cost and plan (when the `users` table has a row). "Sessions" jumps to that user's history. | `GET /admin/users` |
| Waitlist | Signups from the site's waitlist form. | `GET /admin/waitlist` |
| Feedback | Lab feedback and site feedback merged, newest first, tagged by source. | `GET /admin/feedback` |
| Learning | How learners answer the quiz questions. Tiles for total answers, distinct questions and the weakest concept; a per-concept table with a percent-correct bar, weakest first; a per-question table (lab, concept, answers, correct, percent correct) that sorts weakest or strongest first, with a lab dropdown and a From / To date range (UTC, the end date inclusive). Under 50% correct, with at least 5 answers, a question is flagged `review`. | `GET /admin/learning` |

Every fetch shows a loading, an empty and an error state. Times are UTC. The tables that hold list data page with a "Load more" cursor.

The Learning tab reads the anonymous `learn_answers` table (see [Learning analytics](api.md#learning-analytics)). There is no user, session or address on a row, so nothing here can be tied to a learner, and the tab says so. A low percent correct means many learners miss that question: review the lesson or the wording of the question. The weakest-concept tile ignores concepts with fewer than 5 answers when any concept has more, so one unlucky answer does not name it. The filters are sent to the API (`?lab=`, `?from=`, `?to=` as epoch ms), and the lab dropdown is filled from the labs seen in the answers. Onboarding-quiz answers have no lab and show as "onboarding quiz"; the lab filter cannot select them. Without the table (migration 0008 not applied) the tab says so; the per-question list is capped at 500 by the API and the tile then reads `500+`.

Two caveats are on the screen and worth repeating here:

- **Container cost is an estimate** from container time (`sessions.cost_usd`), not an invoice.
- **LLM cost is self-reported**, taken from the container's own LLM calls (`sessions.llm_usd`), and is not reconciled against AI Gateway billing. The tile says so.

Completion is the share of *ended* sessions whose run passed every check (`completed_at` set).

## API routes (`src/admin.ts`)

All take the service key and nothing else (`requireServiceAuth`, exactly as `/pools` does). A session token gets a 401.

| Route | Returns |
|---|---|
| `GET /admin/sessions?state=&lab=&user=&limit=&before=` | `{ sessions, next? }`, newest first. `state` is one name or a comma-separated list (up to 8). Default limit 50, maximum 200. `before` is the previous page's `next` (a `created_at` in ms). |
| `GET /admin/usage/summary?from=&to=` | `{ from, to, totals: {sessions, running_s, cost_usd, llm_usd}, by_lab (top 20 by cost), by_day (UTC, oldest first), completion: {completed, ended, rate} }`. `from` and `to` are epoch ms or ISO dates; the default is the last 30 days. The window is on `created_at`. |
| `GET /admin/users?limit=&before=` | `{ users, next? }`, most recently active first. `before` is a `last_session_at`. Without a `users` table the plan is `null`. |
| `GET /admin/waitlist?limit=&before=` | `{ available, rows, next? }`. |
| `GET /admin/learning?lab=&from=&to=` | `{ available, questions, concepts }`: quiz-answer aggregates, weakest first (see `docs/api.md`). `{ available: false, questions: [], concepts: [] }` without the `learn_answers` table. |
| `GET /admin/feedback?limit=&before=` | `{ available, rows, next? }`. Each row has `source: "lab"` or `"site"`. A site row's own "which link" column is returned as `origin`. If only one of the two tables exists, the other is listed under `missing`. |
| `GET /labs/:slug/versions` | `{ slug, current, previous, versions: [{version, title, manifest_version, estimated_minutes, published_at, current, previous}] }`, newest version first. A version whose manifest cannot be read is listed with an `error`. |
| `POST /labs/:slug/promote` body `{ "version": "1.2.0" }` | `{ slug, current, previous }`. 404 `unknown_version` if `labs/{slug}/{version}/manifest.json` does not exist; 400 `bad_version` if the version is not semver. Writes `previous` (the old current) and then `current`, then rebuilds the catalogue index. Promoting the version that is already current changes neither pointer, so `previous` is kept, but the index is still rebuilt. |

A missing waitlist, feedback or learning table (a migration that has not run) answers `available: false` with empty lists and the screen says so. Any other database error is a 500, on purpose: an outage should not read as "nothing to show".

Cursors are millisecond timestamps, so two rows created in the same millisecond can straddle a page boundary. At this scale that is a known, accepted limit.

Running sessions resolve their lab by version when they start and keep it, so a promotion changes what new sessions get, not what is running.

## Secrets

The Worker needs three secrets. None is ever written into the repo or a var.

| Secret | What it is |
|---|---|
| `SANDBOX_API_KEY` | The sandbox API's service key. Held only by the Worker. |
| `ADMIN_PASSWORD` | What the login page checks. |
| `ADMIN_COOKIE_SECRET` | Signs the session cookie (`__Host-opx_admin`, 8 hours). Use a long random value, different from the password. |

With any of the three missing the panel is closed: login answers 503 and nothing is served.

Set them once, before or after the first deploy:

```sh
npx wrangler secret put SANDBOX_API_KEY --config admin/wrangler.jsonc
npx wrangler secret put ADMIN_PASSWORD --config admin/wrangler.jsonc
npx wrangler secret put ADMIN_COOKIE_SECRET --config admin/wrangler.jsonc
```

(`SANDBOX_API_KEY` is the same value the console Worker holds; the other two are new and independent of the console's.) After a service key rotation (`docs/runbooks/secrets-rotation.md`), put the new `SANDBOX_API_KEY` here as well.

## Build, run and deploy

```sh
node admin/build.mjs                       # bundles the page and the Worker, copies packages/design
npx wrangler dev --config admin/wrangler.jsonc --port 8790
npx wrangler deploy --config admin/wrangler.jsonc
```

`admin/dist-worker`, `admin/public/dist` and `admin/public/design` are generated and git-ignored. The design tokens and fonts are copied from `packages/design` at build time so the panel cannot drift from them.

The login form is limited to five attempts a minute per address (rate-limit namespace `1003`).

## Security notes

- The cookie is `__Host-`prefixed, `HttpOnly`, `Secure`, `SameSite=Lax`. Logout is POST only.
- `/api/*` without a cookie is a 401 (never HTML). The browser's own cookie and `Authorization` are not forwarded; the API's own 401 is reported as a 502 so it cannot be mistaken for "signed out".
- A state-changing request with an `Origin` other than this Worker's is refused.
- The CSP is `default-src 'self'` with `connect-src 'self'`, `style-src 'self'`, `script-src 'self'`, `frame-src 'none'`: no inline script or style, and the page never contacts the API directly. Server-supplied text is rendered as text, never as HTML.

## Known limits

- **One shared password.** There are no accounts, so no per-person revocation: to lock someone out, change `ADMIN_PASSWORD` and `ADMIN_COOKIE_SECRET` (the second invalidates every cookie already issued).
- **No audit trail.** The panel does not record who ended a session, drained a pool or promoted a version, and there is only one identity to record.
- **No SSO.** Cloudflare Access needs a hostname in a zone the account controls, which `workers.dev` is not. Putting Access in front later changes `admin/src/worker.js` and nothing else.
- The service key sits behind that one password: whoever has it can do anything the service key can, through `/api/*`, which is a blanket passthrough by design.
- Users are distinct `user_id` values, not accounts; the console uses one subject for every learner today.
