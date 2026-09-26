# Give each agent only the tools it needs

Three tool servers are registered on one ContextForge gateway: a
knowledge base (`search_kb`, `get_kb_article`), a support-ticket queue
(`list_tickets`, `get_ticket`, `create_ticket`, `update_ticket_status`),
and customer accounts (`get_account`, `issue_refund`,
`delete_account`). Nine tools, three roles that are each supposed to see
a different slice of them -- and right now none of that is true. Every
one of those nine tools, including `delete_account`, sits in a single
virtual server, `ungoverned-bundle`, and the one token that already
exists for it (`platform/ungoverned_token.txt`) can reach every single
one.

Telling an agent "you're a support agent, only use the read tools" in its
system prompt does not change any of that. Nothing stops it calling
`delete_account` anyway except whether the gateway itself will let the
call through.

## What you have

| Where | What |
|---|---|
| `tool_servers/` | The three tool servers, already running, already registered with ContextForge as gateways. Nothing here is broken -- this is the fixture, not the task. |
| `platform/roles.yaml` | The platform's own record of which role should see which tools: `support-agent` (read-only), `ops-agent` (read + write, no admin), `admin` (everything). You don't edit this to make the lab pass -- you make ContextForge match it. |
| `platform/bootstrap_ungoverned.py` | Already ran once, automatically, before you opened this file. It's what put every tool into `ungoverned-bundle` and wrote `platform/ungoverned_token.txt`. Not your job to edit. |
| `platform/setup.py` | Reads `roles.yaml` and is supposed to reconcile ContextForge with it -- one virtual server and one scoped token per role. Its docstring says what it must leave behind; none of it is implemented yet. |
| **view** tab | Read-only: every registered tool server (gateway) and how many tools it reported, and every virtual server with the exact tool names it currently exposes -- refreshes every couple of seconds, so it reflects whatever `setup.py` just did. |

There's no browsable ContextForge admin tab in this lab -- its own admin
UI redirects a real browser to a login form, so it isn't one. `curl`
against `$CONTEXTFORGE_URL` from a terminal works fine with no login at
all, the same way `bootstrap_ungoverned.py` and `setup.py` already talk
to it.

## Your task

Make `platform/setup.py` actually reconcile ContextForge with
`platform/roles.yaml`, then run it:

```bash
python3 -B platform/setup.py
```

When it's done, `platform/keys.json` should have one working token per
role, and:

- `support-agent`'s token reaches all five read-only tools, and is
  refused on every write and on the one admin tool.
- `ops-agent`'s token reaches everything `support-agent` can, plus every
  write -- but is still refused on `delete_account`.
- `admin`'s token reaches all nine tools, including `delete_account`.
- No role's own token can reach anything by pointing at a *different*
  role's virtual server, even though none of those ids are secret.

The `ungoverned-bundle` virtual server and its token can keep existing or
not, once you're done -- that's not what's graded. What's graded is
whether each role's own token, the one recorded in `keys.json`, can ever
reach something outside its own list in `roles.yaml`.

## Checking your work

The real checks aren't built yet (part 2 of this lab) -- `checks/` here
is a placeholder. When they land, they will work the same way every
other build lab's grader does: never reading your code, only calling
ContextForge for real with whatever tokens `platform/keys.json` ends up
holding, and reading back whether the gateway itself let each call
through or refused it. A refusal only counts if ContextForge produced it
-- a 401, a 403, or a tool call that comes back `isError: true` because
the tool was never associated with the server that token is scoped to.
Nothing about what a role's own prompt says it will or won't do enters
into it.
