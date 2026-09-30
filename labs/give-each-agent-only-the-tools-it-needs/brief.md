# Give each agent only the tools it needs

Three tool servers are registered on one ContextForge gateway: a
knowledge base (`search_kb`, `get_kb_article`), a support-ticket queue
(`list_tickets`, `get_ticket`, `create_ticket`, `update_ticket_status`),
and customer accounts (`get_account`, `issue_refund`, `delete_account`).
Nine tools, three roles that should each see a different slice -- and
right now none of that is true. Every tool, including `delete_account`,
sits in one virtual server, `ungoverned-bundle`, and the single token for
it (`platform/ungoverned_token.txt`) reaches all nine.

## What you have

| Where | What |
|---|---|
| `tool_servers/` | The three tool servers, running and registered with ContextForge as gateways. This is the fixture. |
| `platform/roles.yaml` | Which role should see which tools: `support-agent` (read-only), `ops-agent` (read + write, no admin), `admin` (everything). You don't edit it; you make ContextForge match it. |
| `platform/bootstrap_ungoverned.py` | Already ran once, automatically: it built `ungoverned-bundle` and its token. Not yours to edit. |
| **`platform/setup.py`** | Yours. Reads `roles.yaml` and must reconcile ContextForge with it, one virtual server and one scoped token per role. Its docstring says what it must leave behind; none of it is implemented yet. |
| **view** tab | Read-only: every gateway with its tool count, and every virtual server with the tool names it exposes. |

`curl` against `$CONTEXTFORGE_URL` works with no login; its admin UI is
not a tab here.

## Your task

Make `platform/setup.py` reconcile ContextForge with `platform/roles.yaml`,
then run it:

```bash
python3 -B platform/setup.py
```

Afterwards `platform/keys.json` should hold one working token per role:

- `support-agent` reaches all five read-only tools and is refused on every
  write and on the admin tool.
- `ops-agent` reaches everything `support-agent` can, plus every write,
  but is refused on `delete_account`.
- `admin` reaches all nine tools.
- No role's token can reach anything by pointing at a *different* role's
  virtual server, even though those ids are not secret.

`ungoverned-bundle` and its token may stay or go. What is graded is
whether each role's own token from `keys.json` can reach anything outside
its own list in `roles.yaml`.

## Checking your work

**Run checks** never reads your code. It starts its own ContextForge on a
fresh database with its own tool servers, re-runs the workspace's
`bootstrap_ungoverned.py` to reproduce your starting state, runs *your*
`platform/setup.py` on top, and calls the result as any real caller would.

| Check | Passes when |
|---|---|
| `each-role-reaches-only-its-tools` | `support-agent` reaches its 5 reader tools and is refused on the other 4; `ops-agent` reaches all 8 reader and writer tools and is refused only on `delete_account`; `admin` reaches all 9. |
| `refusal-is-real-not-client-side` | `support-agent`'s and `ops-agent`'s tokens are refused outright (a real 401/403/tool-not-found) when pointed at the admin role's virtual server, and no role's token can list the platform's own gateways. |
| `no-token-no-access` | A call to a virtual server's MCP endpoint with no token comes back a real 401. |

The last two stop the first being met the easy way: giving every role the
same bundle or token, or quietly adding an unlisted scope, would pass
"reaches its own tools" trivially. You need all three. A refusal only
counts if ContextForge itself produced it.
