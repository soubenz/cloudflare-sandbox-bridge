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

See `test/fixtures/labs/hello/` for a minimal worked example, and
`src/labs/manifest.ts` for the full schema (zod, so it's the source of
truth — this doc summarizes it).

## manifest.yaml

```yaml
slug: duplicate-emails       # lowercase, hyphenated
version: 1.0.0                # semver; publishing bumps this
title: "Customers are getting duplicate emails"
type: break-fix                # build | break-fix | scale
family: agent                  # which container image/pool this lab uses
timeout_minutes: 90            # 60-120
idle_minutes: 10
env:
  SOME_VAR: "value, may use {{session.id}} etc."
services:
  - name: agent
    argv: ["python3", "agent.py"]
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
checks:
  - name: no-duplicate-sends
    script: no_duplicates.sh
    timeout_s: 30
    weight: 1
hints:
  - after_minutes: 10
    text: "..."
egress:
  allow: []                     # extra hostnames beyond the LLM Worker and package mirror
```

## Design rules (from the product plan)

- **Outcome-based checker.** A check script tests whether the system
  actually works — never greps for a specific command or diff. Exit 0 or
  non-zero; optionally print a JSON line `{"pass": bool, "message": str}`
  as the last line of stdout for a friendlier failure message.
- **No stated path.** `brief.md` says what the system should do, never how.
- **Break-fix labs are titled by symptom** ("Customers are getting
  duplicate emails"), never by the concept being taught.
- **Three hints, gated solution.** `hints[]` unlock progressively;
  `solution/` is never uploaded to the server at all.
- **Check scripts are never resident in the container between runs.** They
  are staged fresh from the private bundle at check time and deleted after
  (`src/session/checks.ts`) — don't rely on `checks/` being present at any
  other time, including from a pressure script.

## Publishing and testing

```sh
npm run opalix -- labs publish path/to/<slug>
npm run opalix -- labs test <slug>
```

`labs test` starts a session, and is meant to also apply `solution/` and
verify all checks pass, then start fresh and verify the checks fail as
designed — the apply-solution half is not yet automated (see the TODO in
`cli/src/commands/labs.ts`); today it only exercises the fresh-session path.
