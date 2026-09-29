# Onboard a new team in under an hour

Every new team that wants onto the platform needs three things before
anyone on it can do real work: a model key scoped to the right models and
a real budget, and scoped access to whichever internal tools they
actually need. Today that's three separate manual requests to three
different owners, and it takes days.

`platform/onboard.py` is supposed to make it one command:

```bash
python3 -B platform/onboard.py <team-name>
```

`<team-name>` has to already be listed under `teams:` in
`platform/team_catalog.yaml` -- that file is the platform's own record of
which teams exist and what each one should be able to reach. Two teams are
already listed: `growth` and `data-science`.

## What you have

| Where | What |
|---|---|
| `platform/team_catalog.yaml` | Which teams exist, which models and which tools each one should reach, and each one's own budget. You don't edit this to make the lab pass -- you make onboarding actually match it. |
| `platform/onboard.py` | Runs end to end already -- it really does create a LiteLLM team, a budget, a key, register tool servers with ContextForge, and write out `platform/onboarded/<team>/`. It is not a stub. Something in it is still wrong. |
| `services/wiki_server.py`, `services/tickets_server.py` | Two teams' own MCP tool servers, already running. You don't edit these -- they're the given scenario, not the task. |
| **view** tab | Read-only: every LiteLLM team and its budget and allowed models, every key, every ContextForge virtual server and how many tools it bundles, and every tool the gateway has federated. Never a usable key or token. |

## Your task

Run `platform/onboard.py` for both `growth` and `data-science`, and look
at what each one actually ends up able to reach -- through its LiteLLM key,
and through its ContextForge virtual server. Something a new team gets
access to should not be there, and it's not obvious from running the
script once for one team that anything is wrong at all: the example it
writes you really does work.

When it's right:

- Each team has its own LiteLLM team, with exactly the models
  `team_catalog.yaml` lists for it, and its own `max_budget`.
- Each team has one key, scoped to it.
- Each team has one ContextForge virtual server, scoped to exactly the
  tools `team_catalog.yaml` lists for *that* team -- no other team's
  tools, and no tool that isn't listed for any team.
- Each team has one client token, scoped to that one virtual server.
- `platform/onboarded/<team-name>/credentials.json` and
  `platform/onboarded/<team-name>/example.py` both exist, and running the
  example (`python3 -B platform/onboarded/<team-name>/example.py`, exactly
  as it's handed to a new team member) makes one real model call and one
  real tool call, both of which succeed.

Nothing here is undocumented API -- every call `onboard.py` makes is one
LiteLLM's or ContextForge's own management API documents. Try a call by
hand with `curl` first if its shape isn't obvious.

## Checking your work

**Run checks** never reads your code. It starts its own fresh LiteLLM and
its own fresh ContextForge, with its own copies of the tool servers, runs
*your* `platform/onboard.py` unmodified for both teams, and then calls
through with whatever came out -- including actually running the
`example.py` it wrote, exactly the way a new team member would.

| Check | Passes when |
|---|---|
| `onboarded-team-gets-what-it-needs` | `growth`'s key reaches its own models, its token reaches its own tools, and its `example.py` runs end to end. |
| `onboarding-does-not-leak-across-teams` | Neither team's key or token can reach a model, a tool, or a virtual server it was never granted. |
| `each-team-gets-its-own-real-budget` | `growth` and `data-science` each end up with their own, correctly set, distinct budget. |

The second check is the one to pay attention to if the first one already
passes.
