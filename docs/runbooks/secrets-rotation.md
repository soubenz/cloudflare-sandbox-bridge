# Secrets rotation runbook

Every secret below is declared in `src/env.ts` (API Worker) or read in `dashboard/src/worker.js` (console Worker). `site/wrangler.jsonc` declares no secrets: the site Worker only uses the `DB` and `WAITLIST_LIMIT` bindings. Set API secrets with `npx wrangler secret put NAME`; set console secrets with `npx wrangler secret put NAME --config dashboard/wrangler.jsonc`.

## 1. Cloudflare API token used by CI (`CLOUDFLARE_API_TOKEN`)

Rotate now: the current token was pasted into a chat once. Treat it as compromised.

Consumers: the `CLOUDFLARE_API_TOKEN` GitHub Actions secret, read by every wrangler step in `.github/workflows/deploy.yml` (dry-run, `d1 migrations apply`, API deploy, dashboard deploy) and `.github/workflows/deploy-site.yml`.

Scopes for the new token (Account level, this account only). Workers Scripts, D1 and Containers come straight from the workflow steps. R2 is needed because the Worker binds `BACKUP_BUCKET` and `LABS_BUCKET`, and Account Settings because wrangler resolves the account:
- Workers Scripts: Edit
- D1: Edit
- Workers R2 Storage: Edit
- Containers: Edit (Read is not enough: `--containers-rollout=immediate` pushes images and rolls out)
- Account Settings: Read

Steps:
1. Cloudflare dashboard, My Profile, API Tokens, Create Token, Custom token. Add the five scopes above, restrict to the Opalix account, set an expiry.
2. Update the GitHub secret: `gh secret set CLOUDFLARE_API_TOKEN` (paste the new value at the prompt).
3. Run the Deploy workflow: `gh workflow run Deploy`, then `gh run watch`.
4. Confirm every step is green, including "Apply D1 migrations" and both deploy steps. If a step fails with an authentication error, add the missing scope to the new token; do not revoke the old one yet.
5. Revoke the old token in the dashboard. Do not leave it to expire.

## 2. `SANDBOX_API_KEY` (service key)

Consumers (all four must change):
- API Worker secret `SANDBOX_API_KEY`.
- Dashboard Worker: its own copy of `SANDBOX_API_KEY`, sent as the bearer on every call in `callApi` (`dashboard/src/worker.js`).
- Operators' local `OPALIX_KEY` (CLI, `test/integration/*`, `test/e2e/*`).
- CI: no workflow uses `OPALIX_KEY` today. If one is added, it is a fifth consumer.

Use the dual-key window so nothing breaks mid-rotation. The API accepts `SANDBOX_API_KEY_PREVIOUS` alongside `SANDBOX_API_KEY` and marks responses to previous-key callers with `X-Opalix-Key: previous`.

1. Generate the new key: `openssl rand -hex 32`. Keep the old value to hand.
2. Put the current value in the previous slot: `npx wrangler secret put SANDBOX_API_KEY_PREVIOUS` (paste the old key).
3. Put the new value in the primary slot: `npx wrangler secret put SANDBOX_API_KEY` (paste the new key). Both keys now work.
4. Update the dashboard: `npx wrangler secret put SANDBOX_API_KEY --config dashboard/wrangler.jsonc` (new key).
5. Update every operator's local `OPALIX_KEY`, and any CI secret that holds it.
6. Verify each client is on the new key: `curl -si -H "Authorization: Bearer $OPALIX_KEY" $OPALIX_URL/pools | grep -i x-opalix-key`. No output means the new key; `X-Opalix-Key: previous` means that client still holds the old one.
7. Wait 24 hours. Recheck step 6 for the dashboard and the CLI.
8. Close the window: `npx wrangler secret delete SANDBOX_API_KEY_PREVIOUS`. The old key now returns 401.

Rollback during the window: put the old value back with `wrangler secret put SANDBOX_API_KEY`.

## 3. `SESSION_TOKEN_SECRET`

Signs every session token (`src/auth.ts`). Rotation invalidates all of them at once: every learner with a running lab gets 401 on the terminal, events and file routes. There is no dual-key window for this secret.

`POST /pools/{agent,gateway}/drain` only destroys warm containers. Claimed sessions are untouched (`docs/api.md`), so drain does not protect running labs. It does stop new sessions from being handed a container mid-rotation.

1. Pick a quiet hour. Check who is affected: `curl -s -H "Authorization: Bearer $OPALIX_KEY" $OPALIX_URL/sessions`.
2. If the list is not empty, announce the logout to those learners first.
3. Drain the warm pools: `curl -X POST -H "Authorization: Bearer $OPALIX_KEY" $OPALIX_URL/pools/agent/drain`, and the same for `gateway`.
4. Rotate: `openssl rand -hex 32`, then `npx wrangler secret put SESSION_TOKEN_SECRET`.
5. Redeploy so no isolate keeps the old value: `gh workflow run Deploy`.
6. Recovery for learners: starting the lab again from the console calls `POST /sessions/start`, which rejoins the live session and mints a new token. Service callers can keep using the service key on any session route.

## 4. `AI_GATEWAY_TOKEN`

A Cloudflare API token with Workers AI access. `llmOutbound` in `src/families/egress.ts` injects it into model calls; the container never holds it.

1. Cloudflare dashboard, My Profile, API Tokens: create a new token with Workers AI access only. Revoke the old one after step 3.
2. `npx wrangler secret put AI_GATEWAY_TOKEN` (new token).
3. Run the egress integration test against the live Worker: `OPALIX_URL=<url> OPALIX_KEY=<key> npx vitest run -c vitest.integration.config.ts test/integration/egress.test.ts`. It starts a real session, so allow a few minutes. It checks the fence and that no platform credential reaches the container; it does not itself make a model call, so also run one lab that calls the model.

## 5. Dashboard `CONSOLE_PASSWORD` and `CONSOLE_COOKIE_SECRET`

Both are secrets on the dashboard Worker (`dashboard/wrangler.jsonc`).
- `CONSOLE_PASSWORD`: what the login page checks. Rotating it does not end existing cookies; users stay signed in until the 12-hour cookie expires.
- `CONSOLE_COOKIE_SECRET`: signs the `opx_console` cookie. Rotating it logs every console user out at once. Rotate this one to force a sign-out, for example after a password leak.

Steps: `npx wrangler secret put CONSOLE_PASSWORD --config dashboard/wrangler.jsonc`, then the same for `CONSOLE_COOKIE_SECRET`. No redeploy needed; a secret change takes effect on its own. Tell console users to sign in again.

The site Worker (`site/wrangler.jsonc`) has no secrets to rotate.

## 6. Summary

| Secret | Lives in | Consumed by | Blast radius of rotation |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | `deploy.yml`, `deploy-site.yml` | CI deploys fail until updated. No runtime impact. |
| `SANDBOX_API_KEY` | API Worker, dashboard Worker, operators' `OPALIX_KEY` | All service-key routes; dashboard `callApi`; CLI | None with the dual-key window. Without it, every un-updated client gets 401. |
| `SANDBOX_API_KEY_PREVIOUS` | API Worker (temporary) | Same routes, old key only | Deleting it ends the old key. |
| `SESSION_TOKEN_SECRET` | API Worker | `mintSessionToken`, `verifySessionToken`, `mintLlmToken` | Every live session token is invalid. Running labs lose browser access until rejoined. |
| `AI_GATEWAY_TOKEN` | API Worker | `llmOutbound` (all model calls from labs) | Model calls fail until the new value is set. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | API Worker | Sandbox SDK presigned-URL backups (`opalix-backups`) | Snapshots and resume fail until updated. Rotate in R2 API tokens, then `wrangler secret put` both. |
| `CONSOLE_PASSWORD` | Dashboard Worker | Console login | Users need the new password at next sign-in. |
| `CONSOLE_COOKIE_SECRET` | Dashboard Worker | Console session cookie | All console users are signed out. |
