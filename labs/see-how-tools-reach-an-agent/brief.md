# See how tools reach an agent

Nothing is broken here. This is a tour of how a tool actually gets from a
tool server to an agent through a gateway, not a puzzle to fix.

## What is running

| Service | What it is doing |
|---|---|
| `weather-tools` | A toy MCP tool server: `get_weather` and `get_forecast` |
| `calculator-tools` | A toy MCP tool server: `add`, `subtract`, `multiply` |
| `contextforge` | The gateway: both toy servers registered as gateways, their tools exposed through one virtual server, `toy-tools` |
| **view** tab | A read-only page: the registered gateways, the tools ContextForge discovered, the virtual server, and ContextForge's own record of every call that has gone through it |

ContextForge's own admin UI always asks for a login even with auth turned
off, which labs don't do, so it is not a tab -- the **view** tab stands in
for it. You talk to the gateway through `call_tool.py` instead. No key or
token is needed: this ContextForge is booted with `AUTH_REQUIRED=false`
and `ALLOW_UNAUTHENTICATED_ADMIN=true`, so every request from a script
(as opposed to a browser) is automatically treated as the platform admin.

## Start here

```bash
python3 -B call_tool.py --list
python3 -B call_tool.py calculator-tools-add '{"a": 3, "b": 4}'
python3 -B call_tool.py weather-tools-get-weather '{"city": "Paris"}'
```

Each line prints the request it sent and the response it got back. Open
the **view** tab and send a few more -- a new row appears in ContextForge's
own log for each one.

## Answer these

1. How many tools does the virtual server `toy-tools` expose right now?
   (`call_tool.py --list` prints exactly that set.)
2. Call `calculator-tools-add` with exactly `{"a": 17, "b": 25}`. What
   number comes back?
3. Call a tool name that was never registered anywhere -- `does-not-exist`
   is one that isn't -- through the same virtual server, the same way you
   called the other two. The HTTP status is 200 either way; look at the
   JSON-RPC result itself, the way `call_tool.py` prints it. Is it marked
   as an error?

Write your answers into `/workspace/answers.json`, which starts out as:

```json
{
  "virtual_server_tool_count": null,
  "calculator_add_result": null,
  "unregistered_tool_call_is_error": null
}
```

Replace each `null`: the first two with numbers, the third with `true` or
`false`.

## Checking your work

| Check | Passes when |
|---|---|
| `gateway-is-up` | ContextForge reports healthy, both toy tool servers are registered as gateways, and a real call through the virtual server succeeds |
| `answers-match-the-gateway` | Your three answers match what the gateway actually reports right now, checked live |

The second check makes its own `calculator-tools-add` call and its own
call to a tool name that doesn't exist, and reads its own results back off
the gateway -- it never looks at your source, and it never depends on
which tools you personally called first.
