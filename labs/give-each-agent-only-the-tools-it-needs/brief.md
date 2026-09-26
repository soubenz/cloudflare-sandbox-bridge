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

**Run checks** never reads your code. It starts its own ContextForge
against a fresh, empty database, with its own copies of the three tool
servers, re-runs the workspace's own `bootstrap_ungoverned.py` against
that fresh setup to reproduce the same starting state you got, then runs
*your* `platform/setup.py` on top of it -- and calls the result the same
way any real caller would.

| Check | Passes when |
|---|---|
| `each-role-reaches-only-its-tools` | `support-agent`'s own token reaches all 5 reader tools and is refused on all 4 write/admin tools; `ops-agent`'s reaches all 8 reader+writer tools and is refused only on `delete_account`; `admin`'s reaches all 9. |
| `refusal-is-real-not-client-side` | `support-agent`'s and `ops-agent`'s own tokens are refused outright (a real 401/403/tool-not-found) when pointed directly at the admin role's virtual server -- and no role's own token can list the platform's own gateways. |
| `no-token-no-access` | A call to a real virtual server's own MCP endpoint with no token at all comes back a real 401. |

The last two checks exist to stop the first one being satisfied the easy
way: handing every role the same bundle/token (or quietly giving one
role's token a second, unlisted scope "just in case") would otherwise
pass "reaches its own tools" trivially, and if `MCP_REQUIRE_AUTH` weren't
actually in effect, "refused" wouldn't mean anything to begin with. You
need all three. A refusal only counts if ContextForge itself produced it
-- nothing about what a role's own prompt says it will or won't do enters
into any of this.
