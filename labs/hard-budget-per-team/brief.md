# Put a hard budget on every team

One LiteLLM gateway sits in front of a model provider for two teams:
`research` and `support-desk`. Each team already has a `max_budget` set on
it -- research's is small, support-desk's is generous -- and LiteLLM does
enforce it. Just not soon enough: research can send a burst of ordinary
calls and end up spending well past its budget before anything refuses it.

## What you have

| Where | What |
|---|---|
| `gateway/config.yaml` | The gateway's one model alias, `assistant`, priced explicitly. |
| `gateway/hooks/budget_guard.py` | Wired into the running gateway already (see `litellm_settings.callbacks` in config.yaml) -- right now its `async_pre_call_hook` does nothing. |
| `gateway/keys.json` | Written automatically once the gateway is up: each team's id and a working key for it. |
| `send_calls.py` | Sends a burst of identical, same-cost calls to one team's key, and prints what each one got back. |
| **view** tab | Read-only: both teams' budget, recorded spend, and their most recent calls with cost. |

Run `python3 -B send_calls.py research 14` (or any team, any count) and
watch the view tab. Notice which call number is the one that actually
pushes a team's spend past its budget, and which call number is the first
one refused.

## Your task

Make `budget_guard.py` actually hold a team to its budget: refuse a call,
before it is sent to the model, whenever that team's own committed spend
plus what this call could cost in the worst case would put it over. A
refusal should say which team, what it had already committed, and what
its budget is.

The alias's price is set in `gateway/config.yaml`. A call's completion can
use up to what it asked for in `max_tokens` -- that, plus the prompt, is
the worst case you have to plan for.

Whatever it takes to answer "has this team already committed to spending
more than its budget allows" quickly and correctly is yours to build.

After you change `gateway/hooks/budget_guard.py`, restart the `litellm`
service from the Services panel for the change to take effect (this takes
around 40 seconds -- the gateway re-runs its own startup, migrations and
all).

## Checking your work

**Run checks** never reads your code. It starts its own copy of this
gateway against a fresh, empty database, points it at your current
`gateway/config.yaml` and `gateway/hooks/budget_guard.py`, and then hits it
with real traffic -- a burst of concurrent calls and a run of ordinary ones
-- exactly the way a real caller would.

| Check | Passes when |
|---|---|
| `no-team-goes-over` | Across every call the traffic actually made, research's real, total committed spend never exceeds its budget -- not even by one call's worth. |
| `teams-in-budget-keep-working` | Every support-desk call that fits its budget goes through, and so does every research call that fits its budget -- refusing early, before a team is actually out of room, fails this just as much as refusing late does. |
| `refusals-say-why` | Every refused call is a client error whose message says which team, what it had already committed, and what its budget is -- not a bare "refused". |

You need all three: the first two are two ways to be wrong about *when* to
refuse, and the third is about whether a refusal is actually useful to
whoever hits it.
