# Write a tool server the platform can host

ContextForge is up and empty -- nothing has registered a tool server with
it yet. That's your job: `workspace/tool_server.py` is a real MCP tool
server, mostly working, with two bugs left in it. Fix them, register it,
and ContextForge will pick up your tools automatically -- their schemas,
their names, everything.

## What you have

| Where | What |
|---|---|
| `dataset.py` | 55 fake orders, `id` 1-55, as a plain Python list. Not a database -- your tool server just reads it. |
| `tool_server.py` | An MCP tool server built on the official `mcp` SDK's `FastMCP` helper (the same one ContextForge itself is built on). Two tools: `get_order` and `list_orders`. Both have bugs -- see the docstrings in the file. |
| `register.py` | Registers your running tool server with ContextForge. Run it once your server is up and correct. |
| **view** tab | Read-only: every gateway ContextForge has registered (yours, once you run register.py), the tools it discovered on each and their real input schemas, and any virtual server exposing them. |

ContextForge's own admin UI isn't a tab here -- it always redirects a
real browser to a login form, even with anonymous access turned on for
everything else, so `view` stands in for it. You can still talk to
ContextForge's own REST API directly from a terminal with `curl` any
time (`curl http://127.0.0.1:4744/gateways`, `curl .../tools`, and so
on) -- it's specifically a *browser tab* that gets redirected, not a
plain command-line call.

## Your task

`tool_server.py` has two bugs, one in each tool:

1. **`get_order`** treats `order_id` as a position in the list instead of
   the order's own id, so most calls silently return the *wrong* order,
   and an id past the end of the dataset raises a raw Python exception
   instead of a clean one. Fix the lookup, and make a missing id fail
   with a real, readable MCP error -- not a wrong answer and not a
   leaked stack trace.

2. **`list_orders`** ignores its `cursor` argument completely and always
   returns the same first page. There's no way to reach order 40 through
   this tool as it stands, and no bound on `page_size` either. Make it
   page through the full 55-row dataset correctly: no repeated orders,
   nothing skipped, and a clear stopping point once the dataset is
   exhausted. A `page_size` or `cursor` that doesn't make sense should
   come back as a real error, not an empty or truncated page.

Both tools already have typed parameters (`order_id: int`, and so on) --
that's what makes ContextForge (and anything else that calls this server)
able to show a real input schema for each tool instead of guessing at
what a stringly-typed function might accept. Keep it that way; don't
fall back to untyped arguments to sidestep either bug.

Once both are fixed, run:

```bash
python3 -B tool_server.py
```

and, in another terminal:

```bash
python3 -B register.py
```

If `tool_server.py` is broken in a way that crashes the process while
you're testing, that's fine -- restart it from the **Services** panel and
try again. Editing this file does not hot-reload it either way; restart
after every change.

## Checking your work

The grader never reads your code. It starts its own copy of your
`tool_server.py` and its own throwaway ContextForge, registers your tool
server against it exactly the way `register.py` does, and then calls
your tools through ContextForge's own MCP endpoint -- the same path any
real caller would use.

| Check | Passes when |
|---|---|
| `typed-inputs-are-enforced` | A wrong-typed argument to `get_order` and to `list_orders` (a string where an id or a page size is expected) comes back `isError: true` -- not a crash, and not silently accepted. |
| `errors-are-clean-not-leaky` | A missing order id, a nonsensical `page_size`, and an invalid `cursor` each come back `isError: true` with a message that actually explains what was wrong -- never a leaked Python or pydantic exception string, and never a silently wrong answer (`isError: false` with the wrong data). |
| `pagination-is-correct` | Walking `list_orders` forward with the `nextCursor` it hands back visits every one of the 55 orders exactly once -- no repeats, nothing skipped -- and correctly reports no further cursor once the dataset is exhausted. |
| `registers-cleanly` | ContextForge's own registration reports your tool server as reachable, with both `get_order` and `list_orders` discovered and their real (typed) input schemas intact. |

The middle two are the ones worth reading closely if something fails:
`errors-are-clean-not-leaky` is not satisfied by `isError: true` alone --
a message like `list index out of range` or `invalid literal for int()`
is a real Python exception that leaked through unhandled, not something
you wrote on purpose, and it fails this check even though the call did
technically come back as an error.
