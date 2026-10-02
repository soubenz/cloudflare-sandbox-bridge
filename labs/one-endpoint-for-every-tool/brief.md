# Put every tool server behind one endpoint

Three teams each built their own MCP tool server, with no platform involved:

| Team | Server | What it exposes |
|---|---|---|
| Inventory | `services/inventory_server.py` | `lookup_stock` -- units of a SKU in stock |
| Billing | `services/billing_server.py` | `charge_lookup` (read-only) **and** `refund_charge` (moves money, built for on-call use only) |
| Search | `services/search_server.py` | `search_docs` -- search a small fixed document set |

All three are up on their own ports. ContextForge is up too, but
nothing is registered with it: no gateway, no virtual server, no token.
No single endpoint reaches these tools, and billing's `refund_charge`
sits next to the safe `charge_lookup` on the same server, with nothing on
the wire marking it as dangerous.

`platform/setup.py` is supposed to reconcile ContextForge with
`platform/catalogue.yaml`. As shipped, it does nothing.

## What you have

| Where | What |
|---|---|
| `platform/catalogue.yaml` | What should exist: which tool servers, and exactly which tools belong in the one public bundle. You don't edit it; you make the gateway match it. |
| **`platform/setup.py`** | Yours. Reads catalogue.yaml, must reconcile ContextForge with it, then write `platform/client.json`. Its docstring says what it must leave behind; none of it is implemented yet. |
| `services/*.py` | The teams' own tool servers: the given scenario, not yours to edit. |
| **ContextForge** tab | Its own admin pages, already signed in. Management calls (`setup.py`, `curl`) send `X-Authenticated-User: admin@example.com` instead |
| **view** tab | Read-only: every registered gateway, the virtual server(s) and what each bundles, and every client token (never a usable secret). |

`CONTEXTFORGE_URL`, `INVENTORY_URL`, `BILLING_URL` and `SEARCH_URL` are in
your environment; `setup.py` reads them, and so can you with `curl`.

## Your task

Make `platform/setup.py` reconcile ContextForge with
`platform/catalogue.yaml`, then run it:

```bash
python3 -B platform/setup.py
```

When it's done:

- Every tool server in `catalogue.yaml` is registered with the gateway.
- Exactly **one** virtual server exists, bundling exactly the tools
  `public_bundle` names: `lookup_stock`, `charge_lookup`, `search_docs`.
  `refund_charge` is not in it.
- Exactly one client token exists, scoped to that virtual server. It can
  call the three bundled tools through the virtual server's own endpoint.
  It is refused for `refund_charge` even through that same endpoint, even
  though the tool is federated on the gateway. It is refused for the
  admin plane (listing every gateway, minting another token, creating a
  second virtual server) and against any other virtual server.
- `platform/client.json` reflects all of it, in the shape `setup.py`'s
  docstring describes.

## Checking your work

**Run checks** never reads your code. It starts its own ContextForge on a
fresh database with its own tool servers, runs *your* `platform/setup.py`
against it, and calls the result as any real caller would.

| Check | Passes when |
|---|---|
| `bundle-reaches-exactly-its-tools` | The virtual server offers exactly three tools, and the client token can call all three. |
| `excluded-tool-stays-out` | `refund_charge` is not among what the virtual server offers, and calling it through that server is refused. |
| `client-token-cannot-escalate` | The token cannot list every gateway, cannot create a second virtual server, and cannot reach a *different* virtual server than its own. |

The third check stops the first two being met the easy way: a token that
works everywhere would pass them trivially. You need all three.
