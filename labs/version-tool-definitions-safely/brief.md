# Version tool definitions and roll changes out safely

A gateway (ContextForge) sits in front of one tool, `lookup_price`, and one
caller already depends on it: `caller.py`, standing in for a real agent
that calls `price-lookup` (the gateway's one stable address) and sums up
what three SKUs cost. Run it right now -- it passes.

A second version of `lookup_price` is also already built and already
running, on its own port, as its own service (`tool-server-v2`) -- but
nothing in ContextForge knows about it yet. v2 changes the shape of what
the tool returns. `caller.py` was written against the old shape and will
never be changed to match the new one -- exactly like a real caller you
don't control and can't ask to redeploy on your schedule.

ContextForge itself has no rollout feature: no canary, no percentage
split, no built-in version history. What it has for real is a handful of
plain primitives -- a gateway registration, a tool's enabled/disabled
state, a virtual server's list of associated tools, and whole-config
export/import. `workspace/rollout/` gives you a starting point (state.yaml,
a bookkeeping file; rollout.py, a skeleton) and leaves the actual staged
rollout and rollback to you.

## Your task

Get v2 live behind `price-lookup` -- and be able to get back to v1, fast,
if it turns out to be a mistake. Three things have to hold the whole time:

1. **Nothing about v2 reaches `caller.py` until you deliberately cut it
   over.** Registering v2, testing it, deciding it's ready -- none of
   that should change what an existing caller sees.
2. **A bad rollout can be undone quickly, with callers working again
   afterward** -- at the *same* address callers already use. A caller
   that has to be told about a new endpoint is not a rollback.
3. **A caller is never left looking at a nonsensical, half-migrated
   answer.** At any moment you could ask "what does `price-lookup` serve
   right now," there is one clear answer.

## What you have

| Where | What |
|---|---|
| `services/tool_server.py` | Both versions of `lookup_price` -- read it, don't need to change it. |
| `caller.py` | The existing caller. Run it any time: `python3 caller.py`. Don't edit it. |
| `contextforge/seed.py` | Already run once at session start -- registered v1, created the `price-lookup` server, wrote `rollout/state.yaml`. |
| `rollout/state.yaml` | Your bookkeeping: the stable server id, v1's ids, and (once you've registered it) v2's. Nothing updates this after the first write except you. |
| `rollout/rollout.py` | A skeleton: `register_v2`, `snapshot`, `cutover_to`, `rollback` -- all `NotImplementedError` right now. |
| **view** tab | Read-only: every registered gateway and tool, and which tool `price-lookup` currently serves. |

## Checking your work

Checks run `caller.py` and read ContextForge's own state directly -- they
never look at your code.
