# Authoring a lab

A lab is a directory:

```
<slug>/
  manifest.yaml
  brief.md
  hints.md           (optional)
  workspace/          -> learner-visible starting files
  checks/              -> grader scripts, never sent to the learner
  pressure/            -> scripts for scheduled pressure events (optional)
  solution/            -> reference solution, NEVER published (opalix labs publish excludes it)
```

`opalix labs publish` builds two archives. `workspace.tgz` is the contents
of `workspace/` plus `brief.md` and `hints.md` as siblings, extracted
directly into `/workspace` and chowned to `learner`. `private.tgz` is
`checks/` and `pressure/` only. `solution/` is not put into either archive,
so it never reaches the server.

See `test/fixtures/labs/hello/` for a minimal worked example, and
`src/labs/manifest.ts` for the full schema (zod, so it's the source of
truth — this doc summarizes it).

## manifest.yaml

```yaml
slug: duplicate-emails       # lowercase, hyphenated, 3-64 chars
version: 1.0.0                # semver; you bump this by hand
title: "Customers are getting duplicate emails"
type: break-fix                # build | break-fix | scale
family: agent                  # agent | gateway — which container image/pool this lab uses
timeout_minutes: 90            # 60-120, required
idle_minutes: 10               # 1-60, default 10
env:
  SOME_VAR: "value, may use {{session.id}} etc."
services:                      # at least one
  - name: agent
    argv: ["python3", "agent.py"]
    cwd: /workspace             # default /workspace
    env: {}                     # per-service, wins over the manifest-level env
    port: 8080
    healthcheck: { type: http, path: /health, timeout_s: 30 }
    ui: false
    depends_on: []
  - name: grafana
    argv: ["/usr/sbin/grafana", "server"]
    port: 3000
    ui: true                    # proxied at /sessions/{id}/services/grafana/
pressure:
  - id: burst
    at_minutes: 5
    argv: ["/opt/lab/pressure/burst.sh"]
    title: "Traffic triples"
    message: "..."
checks:                        # at least one
  - name: no-duplicate-sends
    script: no_duplicates.sh
    timeout_s: 30               # default 30, max 300
    weight: 1                   # default 1
    parallel: false             # default false; see below
hints:
  - after_minutes: 10
    text: "..."
egress:
  allow: []                     # extra hostnames, unioned with the base allowlist
```

Defaults and limits worth knowing, since the schema fills them in silently:

| Field | Rule |
|---|---|
| `slug` | `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$` |
| `version` | `N.N.N`. Publishing does **not** bump it — re-publishing the same version overwrites that version's objects in place |
| `title` | 1-200 chars |
| `idle_minutes` | 1-60, default 10 |
| `env` keys (both levels) | must be shell identifiers: `^[A-Za-z_][A-Za-z0-9_]*$` |
| `services[].name` | 1-40 chars |
| `services[].cwd` | default `/workspace` |
| `services[].port` | 1-65535, optional |
| `services[].ui` | default `false` |
| `healthcheck.type` | `http` or `tcp`, **default `tcp`** |
| `healthcheck.path` | default `/` (only meaningful for `type: http`) |
| `healthcheck.timeout_s` | 1-120, default 30 |
| `pressure[].id` | 1-40 chars |
| `checks[].name` | 1-80 chars |
| `checks[].timeout_s` | 1-300, default 30 |
| `checks[].weight` | positive, default 1; `check.finished`'s `score` is pass-weight over total weight |
| `checks[].parallel` | default `false`. Sequential checks run first, in order; every `parallel: true` check then runs at once |

`depends_on` names are resolved at publish time and a bad name is rejected
there. A dependency *cycle* is not caught until the session starts, where it
fails the start. Nothing validates that `checks[].script` exists in
`checks/` — a typo there surfaces as a failing check at run time.

The env key rule matters because the session's env is written to
`/etc/opalix/session.env`, which every login shell sources. A key like
`MY-KEY` would break shell startup and a key containing a backtick would
execute. Values are single-quoted on the way in, so nothing in a value is
expanded.

### Templated strings

`{{session.id}}`, `{{session.base_url}}`, `{{service.prefix}}` and
`{{llm.host}}` are substituted once, at session start. They are substituted
in exactly these places, and nowhere else:

- `env` values (manifest-level)
- `services[].argv` entries, `services[].cwd`, `services[].env` values, and
  `services[].healthcheck.path`
- `pressure[].argv` entries, `pressure[].title`, `pressure[].message`
- `hints[].text`
- `egress.allow` entries

Not templated: every `slug`, `version`, `title` (manifest-level), `type`,
`family`, service and pressure `name`/`id`, `port`, `depends_on`,
`healthcheck.type`, and everything under `checks[]` including `script`. A
`{{...}}` in one of those is stored and used literally.

An unknown variable name is an error, and because rendering happens on the
start path it ends the session rather than failing at publish time.
`{{service.prefix}}` only resolves to a real prefix inside a `services[]`
entry; used anywhere else it renders with an empty service name, giving
`/sessions/{id}/services/`.

### egress.allow

`egress.allow` is unioned with the family's base allowlist — it never
replaces it. The base list is `llm.opalix.ai`, `mirror.opalix.ai` and
`bundles.opalix.internal` (the LLM Worker, the package mirror, and the
lab-bundle server). Containers run with internet disabled otherwise.

Two consequences of how this is applied. An empty `allow` skips the runtime
call entirely, leaving the image's static allowlist in place. And if the
call fails, the session continues on the base allowlist and emits an `alert`
event with `kind: set_allowed_hosts_failed` rather than failing the start —
so a lab that needs its extra host will fail in a confusing way unless the
client surfaces that alert.

### services[].ui

`ui: true` does two things: the service's URL appears in the `urls.services`
map returned by `POST /sessions`, and the service proxy will serve it. A
service with `ui: false` is refused by the proxy with `403 not_exposed` even
for a valid session token, so a port a lab opens for its own internal use is
not reachable from outside. The default is `false`, so exposure is opt-in.

## Design rules (from the product plan)

- **Outcome-based checker.** A check script tests whether the system
  actually works — never greps for a specific command or diff. Exit 0 or
  non-zero; optionally print a JSON line `{"pass": bool, "message": str}`
  as the last line of stdout for a friendlier failure message. Both keys
  must be present or the line is ignored and treated as plain text. When
  the line is present its `pass` overrides the exit code.
- **No stated path.** `brief.md` says what the system should do, never how.
- **Break-fix labs are titled by symptom** ("Customers are getting
  duplicate emails"), never by the concept being taught.
- **Three hints, gated solution — one hint for `difficulty: intro`.** The
  house default is three staged hints, but an intro lab is meant to be
  finished without a walkthrough; a third of the way through it a stall
  usually means one missing fact, not a missing strategy. Ship exactly one
  `hints[]` entry for an intro lab, timed the same way as the others'
  first hint (around the 15–20% mark of `timeout_minutes`). `solution/` is
  never uploaded to the server at all, at any difficulty. The hint half is
  weaker than it sounds: nothing caps `hints[]` at three (or at one), and
  there is no unlock gate — each entry fires on its own `after_minutes`
  timer and is pushed to the event stream as a `hint` event carrying the
  full text. `hints.md`, if present, is shipped into `/workspace` in plain
  text at session start, so anything written there is readable by the
  learner from minute zero.
- **Check scripts are never resident in the container between runs.** They
  are staged fresh from the private bundle at check time and deleted after
  (`src/session/checks.ts`) — don't rely on `checks/` being present at any
  other time, including from a pressure script.

A check script runs as `bash <script>` with `cwd: /workspace`, and sees the
lab's manifest-level `env` plus `OPALIX_CHECK_NAME`. Pressure scripts run
with `cwd: /opt/lab`, see the full session env, and are killed after 30
seconds; they are extracted root-owned and mode 0700, so the learner cannot
read them ahead of time.

## Publishing and testing

```sh
npm run opalix -- labs publish path/to/<slug>
npm run opalix -- labs test path/to/<slug>
```

Both take the lab **directory**, not the slug. `solution/` is never
published, so it exists only in your own lab directory — a slug alone could
never find it.

`labs test` runs the whole loop and is the acceptance gate for a lab:

1. starts a session and waits for it to be running;
2. runs the checks on the untouched workspace, where **at least one must
   fail** — a lab whose checks all pass before the learner does anything has
   no task in it, and `labs test` reports that as a failure of the lab;
3. uploads every file under `solution/` into `/workspace`;
4. runs the checks again, where **every one must pass**;
5. ends the session in a `finally`, so a failure anywhere does not leave a
   container running.

It exits non-zero on any of those, and on a lab with no `solution/` — in
which case it says plainly that the pass case was not verified rather than
reporting success.

Worth running once with a deliberately bad solution too: a grader that
passes a fix which trades one bug for another (deleting the retries to stop
duplicate sends, say) is not yet a grader.
