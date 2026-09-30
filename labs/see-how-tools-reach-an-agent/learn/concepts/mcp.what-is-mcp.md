---
id: mcp.what-is-mcp
title: What MCP is and why agents use it
minutes: 3
recap: MCP is a JSON-RPC protocol where a client lists a server's tools and calls them by name, so an agent needs no custom code per tool.
---
MCP, the Model Context Protocol, is an agreement about how an agent talks to something that offers tools. Without it, every tool needs its own glue: Search's weather lookup and Billing's calculator would each have their own request format, and each agent would carry code for each of them. With it, an agent speaks one protocol and any server that speaks it can plug in.

The protocol is JSON-RPC 2.0 over HTTP. Each request has a `method` and `params`, and each response has either a `result` or an `error`. Two methods carry most of the weight for an agent:

- `tools/list` asks a server what it offers. The answer is a list where each tool has a `name`, a human-readable `description` and an input schema saying which arguments it takes.
- `tools/call` runs one tool. The request names the tool and gives its arguments, and the response carries the output as a list of content items, mostly text.

The important idea is discovery at runtime. An agent does not have tool names compiled in. It lists, hands the names, descriptions and schemas to the model, and the model decides what to call. The description is what the model reads to choose, so it is closer to a prompt than to a comment. A server that adds a tool needs no agent change.

A request looks like this:

```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
```

In this lab the two toy servers, `weather-tools` and `calculator-tools`, are real MCP servers built with the official Python SDK. They speak MCP over streamable HTTP, which is the transport used for servers reached over a network. They are small on purpose: a few tools each, with made-up deterministic data and nothing that reaches the internet.

`call_tool.py` is a bare-bones agent client. It prints the request it sends and the response it gets, so you can read the protocol directly instead of trusting a summary. Start with `--list` and look at both the request and the shape of each tool it reports.
