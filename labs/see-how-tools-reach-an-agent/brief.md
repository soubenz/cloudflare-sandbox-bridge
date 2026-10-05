# See how tools reach an agent

Nothing is broken here. This is a tour of how a tool gets from a tool
server to an agent through a gateway, not a puzzle to fix.

## What is running

| Service | What it is doing |
|---|---|
| `weather-tools` | A toy MCP tool server: `get_weather` and `get_forecast` |
| `calculator-tools` | A toy MCP tool server: `add`, `subtract`, `multiply` |
| `contextforge` | The gateway, with both servers registered and their tools exposed through the virtual server `toy-tools` |
| **ContextForge** tab | ContextForge's own admin pages: MCP servers (the registered gateways), virtual servers, tools and metrics |
| **view** tab | A read-only page: registered gateways, discovered tools, the virtual server, and ContextForge's own record of every call |

Both tabs open already signed in. Talk to the gateway with
`call_tool.py`. No key or token is needed.

## Start here

```bash
python3 -B call_tool.py --list
python3 -B call_tool.py calculator-tools-add '{"a": 3, "b": 4}'
python3 -B call_tool.py weather-tools-get-weather '{"city": "Paris"}'
```

Each run prints the request it sent and the response it got back. Every
call adds a row to the log in the **view** tab.

## Answer these

The questions are in the **Questions** tab, next to this brief. Answer them there; your answers are saved for you.

## Checking your work

| Check | Passes when |
|---|---|
| `gateway-is-up` | ContextForge is healthy, both servers are registered, and a call through the virtual server succeeds |
| `answers-match-the-gateway` | Your answers match what the gateway reports right now, checked live |
