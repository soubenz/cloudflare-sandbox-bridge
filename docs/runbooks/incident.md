# Incident runbook

What to do when the API, the warm pools or a deploy is unhealthy. Work top to bottom: signal, triage, remedy, verify, postmortem line. Every command assumes `OPALIX_URL` and `OPALIX_KEY` are exported in your shell (the deployed API base URL and the service key; see `docs/runbooks/secrets-rotation.md`). Never paste either value into a ticket, chat or log.

Two Workers run separately: the API (`opalix-sandbox`, `wrangler.jsonc`) and the console (`dashboard/wrangler.jsonc`). This runbook is about the API and its container fleet. A dead console with a healthy API is a dashboard deploy problem: re-run Deploy, or roll the console back with `--config dashboard/wrangler.jsonc`.

Run `npm run doctor` first if you are on a fresh machine. It checks your tooling and env, not production.

## Signals

| Signal | Where it shows up | What it means |
|---|---|---|
| `probe` workflow failed | GitHub email to repo watchers, red run in Actions | `.github/workflows/probe.yml` calls `GET /health?deep=1` every 10 minutes from outside Cloudflare with `curl -f --max-time 20`. Red means a non-2xx (a 503 names what failed), a timeout, or an auth error. |
| Pool-degraded message | The `ALERT_WEBHOOK_URL` channel (Slack or Discord): `opalix: agent pool degraded - <last error>` or `opalix: gateway pool degraded - ...` | The pool's target is above 0, it has no warm containers, and three consecutive container starts failed. A `opalix: <family> pool recovered` message follows the next successful start. |
| Learner report | Support, chat, a console user | Typical words: "lab will not start", "stuck on starting", "terminal is 401", "got kicked out". Ask for the lab slug and the time, then go to triage step 4. |
| Deploy workflow failed | Actions, `Deploy` run on `main` | Go to remedies, "A Deploy job failed". Production still runs the previous deploy until a run completes the `Deploy` step. |

A probe that fails once and is green ten minutes later is a blip; note it and move on. Two red runs in a row is an incident.

If the probe is green but `ALERT_WEBHOOK_URL` fired, the pool recovered on its own: read triage step 3 for `last_start_error` and file a postmortem line anyway.

## Triage, in order

Stop at the first step that names a cause, then jump to the matching remedy. Record what you saw at each step; the postmortem line needs it.

### Step 1. Deep health

```
curl -sS --max-time 20 -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $OPALIX_KEY" "$OPALIX_URL/health?deep=1"
```

Read the body:

- `200 { "ok": true, "checks": { "d1", "r2", "pools": { "agent": { "degraded", "warm" }, "gateway": {...} } } }`: everything the probe measures is healthy. Skip to step 4 (this is a learner-specific problem).
- `503 { "ok": false, "failing": [...], "checks": {...} }`: `failing` names the broken parts. A `d1` or `r2` entry means Cloudflare storage is unreachable or `labs/index.json` is missing: check the Cloudflare status page, then `npx wrangler d1 execute opalix --remote --command "SELECT 1"`. A pool entry means degraded: go to step 3.
- `401`: your key is wrong or was rotated. Check `docs/runbooks/secrets-rotation.md`. If the probe itself is red on 401, the `OPALIX_KEY` repo secret is stale.
- Timeout or `000`: the Worker is not answering. Try plain `curl -sS "$OPALIX_URL/health"` (open route, returns `{ "ok": true }`). If that fails too, go to triage step 5 (deployments and `wrangler tail`).
- `warm: 0` with `degraded: false` is normal outside the pool schedule (`POOL_SCHEDULE_*` is `mon-fri 06-20=1; *=0` UTC) and is not an incident.

### Step 2. Container applications

```
npx wrangler containers list
npx wrangler containers info <id>
```

`list` prints a table with one row per container application. The two apps are `opalix-sandbox-agentlab` and `opalix-sandbox-gatewaylab` (the Worker name plus the lowercased class); take each `<id>` from the row, since ids are not written down anywhere in this repo. `scripts/wait-for-rollout.sh` greps the same table.

Read `info` for:

- **state**: `active` means Cloudflare has finished rolling the application out and can place instances. Anything else (for example `provisioning`) means it is still rolling out or cannot start. A rollout normally settles about two minutes after `wrangler deploy` returns (`docs/spike.md`, "A deploy lesson").
- **instances**: the count and health of running instances. Zero healthy instances on a `provisioning` app is the outage shape: no session in that family can start. Read each instance's health errors.
- **image digest**: the `sha256` of the image the application points at. Compare it with the digest the last successful Deploy pushed (the push step prints `digest: sha256:...`). A stale digest means the deploy did not roll the image; a fresh one with failing instances means the new image is bad.
- **`ImagePullError`**: seen once for the gateway image outgrowing its disk ("the requested disk size was smaller than the unpacked size of the image"). CI now stops that earlier with `scripts/image-size-gate.mjs`. If you see it, the fix is in `wrangler.jsonc` `instance_type`, through a normal push.

### Step 3. Pool state

```
curl -sS -H "Authorization: Bearer $OPALIX_KEY" "$OPALIX_URL/pools/agent"
curl -sS -H "Authorization: Bearer $OPALIX_KEY" "$OPALIX_URL/pools/gateway"
```

Read `stats` in each body (`docs/api.md`):

- `degraded`: `true` once the target is above 0, nothing is warm and 3 starts in a row failed. Cleared by the next successful start.
- `consecutive_start_failures`: 0 is healthy. A number that keeps growing means the pool retries and keeps failing; that number is the count of failed starts since the last success.
- `last_start_error` and `last_start_error_at`: the newest start error and its epoch-ms time. This is usually the answer. Read it for `ImagePullError`, `APPLICATION_NOT_FOUND`, capacity errors or a container crash on boot. An old `last_start_error_at` with `consecutive_start_failures: 0` is history, not a live failure.
- `warm`, `claimed`, `available`, `max_instances`: `available` is `max_instances - claimed`. `available: 0` means sessions get `503 at_capacity` with `Retry-After`; that is admission control, not a fault, unless `claimed` is far above the real session count (see step 4).

### Step 4. Sessions

```
curl -sS -H "Authorization: Bearer $OPALIX_KEY" "$OPALIX_URL/sessions"
curl -sS -N -H "Authorization: Bearer $OPALIX_KEY" "$OPALIX_URL/sessions/<id>/events"
```

`GET /sessions` lists every live session, newest first (max 200). Look for sessions stuck in `starting`, or many sessions for one lab. `GET /sessions/<id>` returns `meta.state` and `meta.end_reason`.

The events stream replays the last 50 events (the service key is accepted on session routes; `-N` stops curl buffering; press Ctrl-C to stop). Look for `session.state` transitions, `container.restarted`, `service.health` with `reason` and `logs_tail` (a failed service start), and `alert` events (`kind` values are listed in `docs/api.md`). Events are dropped an hour after a session ends.

Learner says 401 on the terminal: check whether `SESSION_TOKEN_SECRET` was rotated. Starting the lab again from the console rejoins and mints a new token.

### Step 5. Deployments and logs

```
npx wrangler deployments list
npx wrangler tail
```

`deployments list` prints oldest first, so the newest deployment is at the bottom. Match its time against when the signal started. A signal that begins within minutes of a deployment points at that deployment. Remember the last finished deploy wins: a push to `main` from another branch or session can redeploy older code over yours (`docs/spike.md`).

`wrangler tail` streams live logs from the API Worker. Reproduce the failure (or wait for the next probe) while it runs, and look for exceptions and the route that fails. Add `--status error` to cut the noise. Sampling for traces is 20%, so absence of a trace proves nothing.

## Remedies

Pick by cause. Do only one at a time and re-check step 1 of triage between them.

### A Deploy job failed

Deploy is `.github/workflows/deploy.yml` (`workflow_dispatch` works, runs are serialized by the `deploy-production` concurrency group). Read the failing step first:

- `Typecheck`, `Unit tests`, `init.sh copies are identical`, `Image size gate`: a real defect in the commit. Fix forward, or `git revert` and push (see the image regression case below).
- Anything else looking like a Cloudflare or network error: re-run only the failed job, `gh run rerun <run-id> --failed`, then `gh run watch`. `D1 migrations apply` is safe to repeat; it tracks what it has run.
- The `Deploy` step is timing out: the job limit is 50 minutes (`timeout-minutes: 50`). Two full image rebuilds already hit 30 minutes once.

Known transients:

- **Registry push stall.** Symptom: the `Deploy (Worker, Durable Objects, and both container images)` step prints the last layer push and then hangs with no output for many minutes. Remedy: cancel the run (`gh run cancel <run-id>`), then re-run it (`gh run rerun <run-id>`, or `gh workflow run Deploy`). Do not wait for the 50-minute timeout.
- **`APPLICATION_NOT_FOUND`**: seen on 2026-09-30, a transient error from Cloudflare that cleared on a re-run without any code change. Remedy: re-run the failed jobs, `gh run rerun <run-id> --failed`. If it repeats on a second attempt, confirm both apps still exist with `npx wrangler containers list` before doing anything else.

### Worker-only regression: `wrangler rollback`

Use when the bad change is in `src/` (or the dashboard) and the container images did not change.

```
npx wrangler deployments list
npx wrangler rollback <version-id>
```

Take `<version-id>` from the deployment just before the bad one (remember: oldest first). Without an id, wrangler rolls back to the previous deployment. Then check triage step 1.

`wrangler rollback` restores Worker code and config only. **It does NOT restore container images.** The container applications keep whatever image the last deploy rolled out. D1 migrations are not undone either.

The next push to `main` deploys the code in `main` again, so a rollback is a stopgap: land a `git revert` on `main` too, or the fix vanishes on the next deploy.

For the console Worker use `npx wrangler rollback --config dashboard/wrangler.jsonc`.

### Image regression: `git revert` and push

If a bad image (a crash on boot, `ImagePullError`, a broken `opalix-init.sh`) is what the pools are failing on, rollback will not help. Fix it like this:

1. `git revert <bad-commit>` on `main` (revert, do not rewrite history) and push.
2. The push touches `images/**`, so Deploy rebuilds both images, rolls them out, waits for the rollout with `scripts/wait-for-rollout.sh`, and drains the pools. Watch it: `gh run watch`.
3. If the image did not change but `wrangler.jsonc` did (for example `instance_type`), the same applies; `wrangler.jsonc` also counts as a container change.

### Drain the pools after any image change

Warm containers keep running the image they booted on. After every image change, drain both pools so new containers start on the new image. Deploy does this itself when `images/` or `wrangler.jsonc` changed. Do it by hand after a manual fix, and only after `npx wrangler containers list` shows both apps `active`, or the pool refills on the old image:

```
bash scripts/drain-pools.sh
```

It POSTs `/pools/agent/drain` and `/pools/gateway/drain` (needs `OPALIX_URL` and `OPALIX_KEY`). Drain destroys warm containers only; claimed sessions keep running.

### Prime a pool

`POST /pools/:family/prime` only ever grows a pool, and the 5-minute cron rewrites the target from `POOL_TARGET_*` or `POOL_SCHEDULE_*`, so a manual prime lasts until the next tick. Use it right after a drain during working hours, so the first learner does not wait for a cold start:

```
curl -sS -X POST -H "Authorization: Bearer $OPALIX_KEY" -H 'Content-Type: application/json' -d '{"target":1}' "$OPALIX_URL/pools/agent/prime"
curl -sS -X POST -H "Authorization: Bearer $OPALIX_KEY" -H 'Content-Type: application/json' -d '{"target":1}' "$OPALIX_URL/pools/gateway/prime"
```

Also: `npm run opalix -- pool prime <family> --target 1`. Do not prime outside the schedule window for long; a warm gateway is about $0.148 per hour (`docs/runbooks/cost.md`).

### A pool is degraded but the image is fine

If `last_start_error` is a capacity or platform error and the apps are `active`, the pool backs off and retries by itself. Check Cloudflare's status page, wait one cron tick, and re-read step 3. If it is still degraded after two ticks, drain that family and prime it.

## Verify

The incident is over only when all of these hold:

1. The probe is green: `gh workflow run probe`, then `gh run list --workflow probe --limit 3`. Or run triage step 1 and get `200` with `"ok": true`.
2. Both apps are `active` with healthy instances (`npx wrangler containers list`), and `degraded` is `false` in both `/pools/agent` and `/pools/gateway`.
3. A real session works end to end. Run the `hello` lab (a `type: build` lab on the agent family) against production:

   ```
   npm run opalix -- labs test test/fixtures/labs/hello
   ```

   Exit 0 means: session started, checks failed on the untouched workspace, passed with `solution/` applied, session ended. For gateway-family changes also run a gateway lab, for example `npm run opalix -- labs test labs/see-what-a-gateway-does`, or `npx vitest run test/integration/smoke.test.ts -c vitest.integration.config.ts` with the same two env vars.
4. Tell the affected learners, and post a note where the alert fired.

## Postmortem line

Add one line per incident to the ops log, in this shape:

```
YYYY-MM-DD HH:MM-HH:MM UTC | <signal> | impact: <who/what, how many sessions> | cause: <one clause> | fix: <what you ran> | follow-up: <ticket or "none">
```

Example (fill with real values, do not copy):

```
2026-09-30 09:10-09:55 UTC | probe red x3 | impact: no gateway labs could start | cause: registry push stall left the deploy half done | fix: cancelled and re-ran Deploy, drained pools | follow-up: none
```

No keys, tokens, session tokens or learner names in the line. If the same cause appears twice in a month, turn the follow-up into a change in this repo (a workflow step, an alert or a check in `scripts/doctor.mjs`).
