# Put every tool server behind one endpoint

Three teams each built their own MCP tool server, with no platform involved:

| Team | Server | What it exposes |
|---|---|---|
| Inventory | `services/inventory_server.py` | `lookup_stock` -- how many units of a SKU are in stock |
| Billing | `services/billing_server.py` | `charge_lookup` (read-only) **and** `refund_charge` (moves money, built for on-call use only) |
| Search | `services/search_server.py` | `search_docs` -- search a small fixed document set |

All three are up right now, each on its own port. ContextForge is up too,
but nothing is registered with it: no gateway, no virtual server, no
token. There is no single endpoint any caller can reach these tools
through, and billing's `refund_charge` sits right next to its safe
`charge_lookup` tool on the exact same server -- nothing about the wire
format marks it as dangerous.

`platform/setup.py` is supposed to fix all of that by reconciling
ContextForge with `platform/catalogue.yaml`. As shipped, it does nothing.

## What you have

| Where | What |
|---|---|
| `platform/catalogue.yaml` | The platform's own record of what should exist: which tool servers, and exactly which tools from them belong in the one public bundle. You don't edit this to make the lab pass -- you make the gateway match it. |
| `platform/setup.py` | Reads catalogue.yaml and is supposed to reconcile ContextForge with it, then write `platform/client.json`. Its docstring says what it must leave behind; none of it is implemented yet. |
| `services/*.py` | The three teams' own tool servers. You don't edit these either -- they're the given scenario, not the task. |
| ContextForge **admin** tab | Its real dashboard -- gateways, virtual servers, tools, tokens. Everything `setup.py` needs to do, you can also see (and try by hand) here first. |

`CONTEXTFORGE_URL`, `INVENTORY_URL`, `BILLING_URL`, and `SEARCH_URL` are
all in your environment -- `setup.py` reads them, and so can you, from a
terminal, with `curl`.

## Your task

Make `platform/setup.py` actually reconcile ContextForge with
`platform/catalogue.yaml`, then run it:

```bash
python3 -B platform/setup.py
```

When it's done:

- Every tool server in `catalogue.yaml` is registered with the gateway.
- Exactly **one** virtual server exists, bundling exactly the tools
  `catalogue.yaml`'s `public_bundle` names -- `lookup_stock`,
  `charge_lookup`, and `search_docs`. Billing's `refund_charge` is not in
  it.
- Exactly one client token exists, scoped to that one virtual server. It
  can call the three bundled tools through the virtual server's own
  endpoint. It is refused for `refund_charge` -- even called through that
  same endpoint, even though the tool is right there on the gateway,
  federated from billing. It is refused for anything that belongs to
  ContextForge's own admin plane (listing every gateway, minting another
  token, creating a second virtual server), and refused against any
  virtual server other than the one it was scoped to.
- `platform/client.json` reflects all of it, in the shape `setup.py`'s own
  docstring describes.

Nothing here is undocumented API. Every call `setup.py` needs to make is
one the admin dashboard itself makes -- try it by hand there first if a
call's shape isn't obvious.

## Checking your work

**Run checks** never reads your code. It starts its own ContextForge
against a fresh, empty database, with its own copies of the three tool
servers, runs *your* `platform/setup.py` against that fresh setup, and
then calls it with whatever came out -- the same way any real caller
would.

| Check | Passes when |
|---|---|
| `bundle-reaches-exactly-its-tools` | The virtual server's own `tools/list` returns exactly three tools, and the client token can successfully call all three. |
| `excluded-tool-stays-out` | Billing's `refund_charge` is not in the bundle, and a direct call for it through the virtual server's own endpoint is refused. |
| `client-token-cannot-escalate` | The client token cannot list every gateway, cannot create a second virtual server, and cannot reach a *different* virtual server than the one it was scoped to. |

The third check exists to stop the first two being satisfied the easy way
-- handing out a token that can do more than this lab asks for (say, one
that happens to work everywhere) would otherwise pass "reaches its
tools" trivially. You need all three.
