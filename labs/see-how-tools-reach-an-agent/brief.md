# See how tools reach an agent

Nothing is broken here. This is a tour of how a tool actually gets from a
tool server to an agent through a gateway, not a puzzle to fix.

**Part 1 placeholder.** The services below are real and running; the
questions and grading in this brief are scaffolding for part 2 and will be
replaced.

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

(Placeholder for part 2.)

Write your answers into `/workspace/answers.json`.

## Checking your work

(Placeholder for part 2 -- see `checks/gateway-is-up.sh` for what part 1
already proves: the gateway is up, both toy tool servers are registered,
and a real call through the virtual server succeeds.)
