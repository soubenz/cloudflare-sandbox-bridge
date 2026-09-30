# See how tools reach an agent

Nothing is broken here. This is a tour of how a tool gets from a tool
server to an agent through a gateway, not a puzzle to fix.

## What is running

| Service | What it is doing |
|---|---|
| `weather-tools` | A toy MCP tool server: `get_weather` and `get_forecast` |
| `calculator-tools` | A toy MCP tool server: `add`, `subtract`, `multiply` |
| `contextforge` | The gateway, with both servers registered and their tools exposed through the virtual server `toy-tools` |
| **view** tab | A read-only page: registered gateways, discovered tools, the virtual server, and ContextForge's own record of every call |

ContextForge's admin UI needs a login, so the **view** tab stands in for
it. Talk to the gateway with `call_tool.py`. No key or token is needed.

## Start here

```bash
python3 -B call_tool.py --list
python3 -B call_tool.py calculator-tools-add '{"a": 3, "b": 4}'
python3 -B call_tool.py weather-tools-get-weather '{"city": "Paris"}'
```

Each run prints the request it sent and the response it got back. Every
call adds a row to the log in the **view** tab.

## Answer these

1. How many tools does the virtual server `toy-tools` expose right now?
2. Call `calculator-tools-add` with exactly `{"a": 17, "b": 25}`. What
   number comes back?
3. Call a tool that was never registered, `does-not-exist`, the same way.
   The HTTP status is 200 either way, so read the JSON-RPC result itself.
   Is the call marked as an error?

Write the answers into `/workspace/answers.json` (two numbers, then
`true` or `false`):

```json
{
  "virtual_server_tool_count": null,
  "calculator_add_result": null,
  "unregistered_tool_call_is_error": null
}
```

## Checking your work

| Check | Passes when |
|---|---|
| `gateway-is-up` | ContextForge is healthy, both servers are registered, and a call through the virtual server succeeds |
| `answers-match-the-gateway` | Your answers match what the gateway reports right now, checked live |
