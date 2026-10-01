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
  solution/            -> reference solution, stored privately, shown to a learner once they have earned it
    _degenerate/       -> author-only wrong answers (optional), never uploaded
```

`opalix labs publish` builds three archives. `workspace.tgz` is the contents
of `workspace/` plus `brief.md` and `hints.md` as siblings, extracted
directly into `/workspace` and chowned to `learner`. `private.tgz` is
`checks/` and `pressure/` only. `solution.tgz` is `solution/`, with its files
at the archive root exactly as they map onto `/workspace`; it is stored
privately, apart from the other two, and is never inside either of them. See
[Solutions](#solutions) for what is and is not uploaded, and when a learner
sees it.

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
# Catalogue placement — all optional (see the table below)
path: ai-platform              # learning path slug
module: 1                      # 1-based module within the path
order: 2                       # 1-based position within the module
prerequisites: [gateway-hello] # lab slugs to do first
tier: free                     # free | pro, default pro
estimated_minutes: 45          # 5-240; the card's "about N min"
archived: false                # default false; true hides the lab from learners
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
    argv:
      ["/usr/sbin/grafana-server", "--homepath=/usr/share/grafana", "--config=/etc/grafana/grafana.ini"]
    cwd: /usr/share/grafana
    env:
      GF_SERVER_ROOT_URL: "{{session.base_url}}{{service.prefix}}/"
      GF_SERVER_SERVE_FROM_SUB_PATH: "true"
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: "Admin"
      GF_AUTH_BASIC_ENABLED: "false"
    port: 3001                  # NOT 3000 — that port is reserved for the sandbox control plane
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
| `version` | `N.N.N`. You bump it by hand; publishing a version that already exists is refused with `409 version_exists` unless you pass `labs publish --force`, which overwrites that version's objects in place. Each publish records the old `current` as `labs/<slug>/previous` |
| `title` | 1-200 chars |
| `idle_minutes` | 1-60, default 10 |
| `path` | optional; the learning path this lab belongs to, a slug (`^[a-z0-9-]+$`) |
| `module` | optional; integer ≥ 1, the module within the path |
| `order` | optional; integer ≥ 1, the lab's position within the module |
| `prerequisites` | optional; lab slugs to do first. A slug that is not published logs a warning in the publish response (`warnings`), it does not fail the publish |
| `tier` | `free` or `pro`, default `pro`; whether the free plan may start the lab |
| `estimated_minutes` | optional; integer 5-240, how long the lab honestly takes (distinct from `timeout_minutes`, the session cap) |
| `archived` | optional boolean, default `false`; `true` hides the lab from learners (see [Archiving a lab](#archiving-a-lab)) |
| catalogue sort | `labs/index.json` is ordered by `(path, module, order, slug)`; a missing `path` sorts as `zz` (last), a missing `module`/`order` as 999. The manifest is the only source of placement — there is no separate paths file |
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

### Archiving a lab

Set `archived: true` for a lab learners should not see: a test fixture, or a lab you have retired. The lab stays published and startable by slug (`POST /sessions`, `/labs/<slug>/session` and the test suites keep working), and `GET /labs` still lists it with `archived: true`. The learner console leaves it out of the launcher, path and module counts, search, suggestions and progress totals; the admin Catalogue tab shows it with an "Archived" chip. Republish the lab for the flag to reach the catalogue index.

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
replaces it. The base list is `gateway.ai.cloudflare.com` (Cloudflare AI
Gateway, the model layer) and `mirror.opalix.ai` (the package mirror); see
`BASE_ALLOWED_HOSTS` in `src/families/egress.ts`. Containers run with
internet disabled otherwise.

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

**The proxy forwards the full path.** A request for the tab reaches the
service as `/sessions/{id}/services/{name}/...`, unchanged. Tools with a
base-path setting take `{{service.prefix}}` there (Grafana's
`GF_SERVER_ROOT_URL`, LiteLLM's `SERVER_ROOT_PATH`). A small page of your
own must strip that prefix itself: pass it in its env (for example
`VIEW_PREFIX: "{{service.prefix}}"`), strip it from the request path,
and keep every link relative. Healthchecks go straight to the port without
the prefix, so answer both. A page that only answers `/` passes every
local test and returns 404 in the console.

**No login.** Every `ui: true` tab must open already signed in; a learner
must never land on a login form. Either the tool has a real anonymous mode
(configure it — Grafana's three `GF_AUTH_*` variables above are the
example), or the tool has no login at all (Prometheus, for example), or the
tool's own UI is not exposed as a tab and the lab ships a small page of its
own instead. An API key the learner uses on purpose, kept in the session
env, is lab material, not a login screen.

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
- **`type: explore` is a guided tour, not a puzzle.** Nothing is broken and
  nothing is missing. The learner runs the system, looks around, and
  answers a few questions listed in `brief.md`, writing the answers to
  `/workspace/answers.json`. Checks compare each answer with what the
  running services actually report — never with a hard-coded guess about
  the learner's own setup. An empty answers file fails, so `labs test`'s
  rule that at least one check must fail on a fresh session holds without
  a special case for this type. Explore labs are usually
  `difficulty: intro`, which means one hint (see below).
- **Three hints, gated solution — one hint for `difficulty: intro`.** The
  house default is three staged hints, but an intro lab is meant to be
  finished without a walkthrough; a third of the way through it a stall
  usually means one missing fact, not a missing strategy. Ship exactly one
  `hints[]` entry for an intro lab, timed the same way as the others'
  first hint (around the 15–20% mark of `timeout_minutes`). `solution/` is
  uploaded and shown to the learner only under the unlock rule (see
  [Solutions](#solutions)), at any difficulty. The hints themselves have no
  gate: nothing caps `hints[]` at three (or at one), and each entry fires on
  its own `after_minutes` timer and is pushed to the event stream as a
  `hint` event carrying the full text. `hints.md`, if present, is shipped into `/workspace` in plain
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

## Learning content

A lab can teach before it tests with a `learn/` folder: a story, lessons,
quiz questions and, for explore labs, the graded fields. It is documented in
[learning-content.md](learning-content.md). `labs learn-check <dir>` validates
it, and `labs publish` refuses a lab whose `learn/` does not compile.

## Lint

`scripts/lint-labs.mjs` checks the mistakes that have shipped in real labs.
It only reads the lab directory.

```sh
npm run opalix -- labs lint path/to/<slug> [more dirs...]
node scripts/lint-labs.mjs [dir...]     # no args: every labs/*/ with a manifest.yaml
```

Each finding prints as `<file>:<line>: <error|warning> <rule>: <message>`,
followed by a summary line. Any error exits 1; warnings never do.
`labs publish` runs the lint first and refuses to publish while there are
errors, with a one-line reason. `labs test` does not lint.

| Rule | Level | Fires when |
|---|---|---|
| `leak` | error | a text file under `workspace/` (binaries and files over 512 KB are skipped) contains `TODO`, `TODO(you)`, `That's the function`, or, case-insensitively, `the bug` or `to fix`. Everything in `workspace/` is readable from minute zero |
| `python-no-B` | error | a `.sh` under `checks/` runs `python3` or `python` (directly, or through a variable set from `command -v python3`) without `-B`, so the check leaves `__pycache__` behind |
| `port-kill` | error | anything under `checks/` uses `fuser -k` or `pkill -f`; a check must observe the system, not kill the learner's processes |
| `port` | warning | a `services[].port`, or an `env` / `services[].env` value that is a bare number under a key named `PORT` or `*_PORT`, is not in the canonical table below |
| `hints-duplicate` | error | `hints.md` contains the first 40 characters (whitespace-normalised) of any manifest `hints[].text`, which un-gates that hint |
| `brief-length` | warning / error | `brief.md` is over 500 words (warning) or 700 words (error), not counting fenced code blocks |
| `pressure-undisclosed` | error | the manifest has a non-empty `pressure[]` and `brief.md` never contains the word "minute" (any case) |
| `lesson-leaks-answer` | warning | a `learn/concepts/*.md` lesson contains, as a whole word (letters, digits, `_` and `-` do not end a word) and ignoring case, a string value of six or more characters from `solution/answers.json`. Numbers, booleans and short values are ignored; a lab with no `solution/answers.json` is skipped |
| `harness-stale-lock` | warning | `checks/_harness.py` mentions a `.lock` file but lacks either a staleness check (`getmtime` / `st_mtime`) or a `try:` / `except Exception` around main |

### Canonical ports

| Service | Port |
|---|---|
| postgres | 5432 |
| litellm | 4000 |
| grader litellm | 4100 |
| provider | 8961 |
| view | 8962 |
| fault-proxy | 8963 |
| contextforge | 4744 |
| jaeger | 16686 |
| otelcol | 4317, 4318 |
| grafana | 3001 |
| prometheus | 9090 |
| qdrant | 6333, 6334 |
| phoenix | 6006 |
| mlflow | 5000 |

A port in this table is fine for any service. Any other port is a `port`
warning naming the service and the port. It is a warning, not an error, for
now.

### x-ports-exempt

A lab that really needs other ports opts out of the `port` rule in
`manifest.yaml`:

```yaml
x-ports-exempt: true
x-ports-exempt-reason: "two providers plus a mock registry need distinct ports"
```

`x-ports-exempt-reason` must be a non-empty string. If `x-ports-exempt` is
present without one, the lint reports a `port` error. (The manifest schema
ignores unknown keys, so these do not affect publishing.)

### --skip-lint

`labs publish <dir> --skip-lint` publishes despite lint errors and prints a
warning that it did so. Use it for a deliberate exception, not to get past a
leak.

## Solutions

`solution/` is the reference answer, laid out as it maps onto `/workspace`
(the same paths `labs test` writes into a fresh session). Publishing a lab
stores it, and the console shows it to the learner as a diff against their
own files once they have made a real attempt. A session has earned it when
it has **passed every check**, or when it has **had every hint delivered and
run the checks at least twice** (a lab with no hints needs only the two
runs). Until then the API answers `403 solution_locked`; a lab with no
`solution/` simply has nothing to show. The exact rule and routes are in
`docs/api.md` (Solution reveal).

What that means for what you put in it:

- **Nothing in `solution/` may be a secret.** It is uploaded to the server
  and returned to any learner who has earned it. It is stored privately (not
  in `workspace.tgz`, not in `private.tgz`, no catalogue route serves it),
  but a learner who unlocks it reads every file in it. Graders, seeds and
  credentials belong in `checks/`, which is never revealed.
- **`_degenerate/` is never uploaded.** A top-level `solution/_degenerate/`
  directory holds the wrong answers that prove your checks discriminate. It
  is excluded from the upload and from `labs test`'s pass case. (A
  `_degenerate` directory nested deeper is an ordinary directory and is
  uploaded.)
- Also left out: `__pycache__`, `*.pyc` / `*.pyo`, any dotfile or dot
  directory (`.DS_Store`, `.pytest_cache`), symlinks, and anything outside
  `solution/`.
- **Only text is shown**, and only up to 40 files, 64 KB each, 512 KB in
  all, paths sorted. A binary file (or any file that is not valid UTF-8, or
  has a NUL byte) is skipped; if a cap drops a file the learner is told the
  list is truncated. Keep the solution to the files a learner has to change.
- **Republishing the lab is what uploads its solution.** Edit `solution/`,
  then run `labs publish` again: a new `version` if you bump it, or
  `--force` to overwrite the current one (a forced publish of a directory
  with no `solution/` removes the solution that version had). A session
  already running keeps the lab version it started on, so it sees the
  solution of that version.

## Publishing and testing

```sh
npm run opalix -- labs publish path/to/<slug>     # lints first; --skip-lint to bypass
npm run opalix -- labs test path/to/<slug>
```

Both take the lab **directory**, not the slug: `labs publish` packs the
files in it, and `labs test` applies your local `solution/` (not the
published one) to a fresh session, so a slug alone could not do either.

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
