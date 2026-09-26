# Write a tool server the platform can host

ContextForge is up in the **contextforge** tab. It doesn't do anything
interesting yet, because nothing has registered a tool server with it.
That's your job: `workspace/tool_server.py` is a real MCP tool server,
mostly working, with two bugs left in it. Fix them, register it, and
ContextForge will pick up your tools automatically -- their schemas,
their names, everything.

## What you have

| Where | What |
|---|---|
| `dataset.py` | 55 fake orders, `id` 1-55, as a plain Python list. Not a database -- your tool server just reads it. |
| `tool_server.py` | An MCP tool server built on the official `mcp` SDK's `FastMCP` helper (the same one ContextForge itself is built on). Two tools: `get_order` and `list_orders`. Both have bugs -- see the docstrings in the file. |
| `register.py` | Registers your running tool server with ContextForge. Run it once your server is up and correct. |
| **contextforge** tab | The real ContextForge admin UI. After you register, look under Gateways to see your tool server and the tools it reported, then under Virtual Servers / Global Tools to call them by hand. |

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

The grader never reads your code. It talks to your tool server the same
way any real caller would -- directly, and through ContextForge once you
register it -- and checks what actually comes back:

- A call with a bad `order_id` or a nonsensical `page_size`/`cursor`
  comes back `isError: true` with a message that says what was wrong,
  never a wrong answer and never a raw Python exception leaking through.
- Walking `list_orders` forward with the cursor it hands back reaches
  every one of the 55 orders exactly once, in order, with no gaps.
- ContextForge's own Gateways list shows your tool server as reachable,
  with both tools discovered and their input schemas intact.
