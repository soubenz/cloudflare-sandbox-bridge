# Onboard a new team in under an hour

Every new team needs three things before anyone on it can do real work: a
model key scoped to the right models with a real budget, and scoped access
to whichever internal tools they need. Today that's three manual requests
to three owners, and it takes days.

`platform/onboard.py` is supposed to make it one command:

```bash
python3 -B platform/onboard.py <team-name>
```

`<team-name>` has to be listed under `teams:` in
`platform/team_catalog.yaml`, the platform's own record of which teams exist
and what each should reach. Two are listed: `growth` and `data-science`.

## What you have

| Where | What |
|---|---|
| `platform/team_catalog.yaml` | Which teams exist, which models and tools each should reach, and each one's budget. You don't edit this to pass -- you make onboarding match it. |
| `platform/onboard.py` | Runs end to end already: it creates a LiteLLM team, budget and key, registers tool servers with ContextForge, and writes `platform/onboarded/<team>/`. It is not a stub. Something in it is still wrong. |
| `services/wiki_server.py`, `services/tickets_server.py` | Two teams' own MCP tool servers, already running. Given scenario, not the task. |
| **view** tab | Read-only: every LiteLLM team with its budget and models, every key, every ContextForge virtual server and its tool count, and every federated tool. Never a usable key or token. |

## Your task

Run `platform/onboard.py` for both `growth` and `data-science`, and look at
what each ends up able to reach, through its LiteLLM key and its
ContextForge virtual server. Something a new team can access should not be
there, and running the script once for one team won't show it: the example
it writes really does work.

When it's right:

- Each team has its own LiteLLM team, with exactly the models
  `team_catalog.yaml` lists for it, and its own `max_budget`.
- Each team has one key, scoped to it.
- Each team has one ContextForge virtual server, scoped to exactly the
  tools listed for *that* team -- no other team's tools, and no tool listed
  for no team.
- Each team has one client token, scoped to that one virtual server.
- `platform/onboarded/<team-name>/credentials.json` and `example.py` both
  exist, and running the example
  (`python3 -B platform/onboarded/<team-name>/example.py`, as handed to a
  new team member) makes one real model call and one real tool call, both
  succeeding.

Every call `onboard.py` makes is documented by LiteLLM's or ContextForge's
own management API. Try one by hand with `curl` if its shape isn't obvious
(ContextForge's admin calls need `X-Authenticated-User: admin@example.com`).

## Checking your work

**Run checks** never reads your code. It starts its own fresh LiteLLM and
ContextForge with their own copies of the tool servers, runs *your*
`platform/onboard.py` unmodified for both teams, and calls through with
whatever came out, including running the `example.py` it wrote.

| Check | Passes when |
|---|---|
| `onboarded-team-gets-what-it-needs` | `growth`'s key reaches its own models, its token reaches its own tools, and its `example.py` runs end to end. |
| `onboarding-does-not-leak-across-teams` | Neither team's key or token can reach a model, tool or virtual server it was never granted. |
| `each-team-gets-its-own-real-budget` | `growth` and `data-science` each end up with their own, correctly set, distinct budget. |

The second check is the one to watch if the first already passes.
