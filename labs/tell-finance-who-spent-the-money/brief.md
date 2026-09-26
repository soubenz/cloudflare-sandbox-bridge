# Tell finance who spent the money

Three teams -- `team-growth`, `team-platform`, `team-research` -- share one
LiteLLM gateway across three product features -- `onboarding`, `reporting`,
`codegen`. Finance asked for one thing: a dashboard that says who spent
what, broken down both ways. What's running already answers half of that.

## What you have

| Where | What |
|---|---|
| `gateway/config.yaml` | The gateway's one model alias, `assistant`, priced explicitly ($0.002/prompt token, $0.004/completion token). |
| `gateway/keys.json` | Written automatically once the gateway is up: each team's id and a working key for it. |
| **traffic** service | Idle until you (or a grading run) call it. `curl -X POST http://127.0.0.1:8965/run` sends one fixed batch of real calls across all three teams and all three features, through their own team keys, each one tagged with which feature it's for. Do not edit `services/traffic.py` -- it isn't part of your task, and grading calls it directly regardless. |
| **grafana** tab | A real, already-provisioned Grafana, signed in automatically, no login screen. Its one dashboard, "Tell finance who spent the money", is provisioned straight from `dashboard/dashboard.json` -- edit that file and the tab picks it up within about 10 seconds, no restart needed. |

Call the traffic endpoint once, wait about 20 seconds for spend to land,
then open the Grafana tab. "Spend by team" already shows three real
numbers. "Spend by feature" shows one: everything lumped under `unknown`.

## Your task

Fix the "Spend by feature" panel in `dashboard/dashboard.json` so it
breaks spend down by feature the same way the team panel breaks it down
by team -- and make sure neither panel's number can be thrown off by a
call that failed.

Everything you need is in LiteLLM's own spend log table,
`LiteLLM_SpendLogs`, in the same Postgres the gateway itself uses. Look at
what's actually in it -- every column, not just the ones the working panel
already reads -- for one row from a real call before assuming where the
feature you tagged the call with ended up.

A gateway that retries a failed call on its own is also something a
finance dashboard has to survive. Send a burst of traffic more than once
and look at what a call that never got a real answer actually logs.
Whatever number your query treats as a call's cost, make sure it's the
one LiteLLM itself already decided to bill -- not one you reconstruct
yourself from tokens.

## Checking your work

**Run checks** never reads your dashboard's history or your query's
text style. It truncates the spend log, calls the traffic service's own
`/run` once, waits for spend to land, then runs your dashboard's own two
panel queries -- exactly as saved in `dashboard/dashboard.json` -- through
Grafana's own query API, and compares what comes back against its own,
independently-computed bill for that exact traffic.

| Check | Passes when |
|---|---|
| `spend-by-team-matches-the-bill` | Your "Spend by team" panel's own totals, one per team, exactly match what that team really spent. |
| `spend-by-feature-matches-the-bill` | Your "Spend by feature" panel's own totals, one per feature, exactly match what was really spent on that feature -- broken out, not lumped together. |
| `retried-requests-are-not-double-counted` | Neither panel's totals are inflated by a call that failed after using up its retries -- that call cost nothing real, and your query has to agree. |

You need all three: the first two are the two ways spend actually has to
be sliced, and the third is what stops a technically-correct-looking query
from quietly overcounting the moment a real provider hiccups.
