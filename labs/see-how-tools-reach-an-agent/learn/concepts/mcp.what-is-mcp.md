---
id: mcp.what-is-mcp
title: What MCP is and why agents use it
minutes: 3
order: 1
recap: MCP is a JSON-RPC protocol where a client lists a server's tools and calls them by name, so an agent needs no custom code per tool.
---
A language model only produces text. An **agent** is a program built around a model: it keeps the conversation, asks the model what to do next and carries out the answer. Carrying out usually means using a **tool**, a function in some other system that does one job, such as looking up the weather in a depot's city or adding two numbers. The model cannot run anything itself. It can only say "call `get_weather` with city Paris", and the agent has to do that and report back.

Which raises the question from the story: how does an agent learn what tools exist and how to call them? If Search's weather lookup and Billing's calculator each had their own request format, every agent would carry glue code for each one. **MCP**, the Model Context Protocol, is the agreement that removes it. A **server** offers tools. A **client**, inside the agent, talks to the server. Any client can use any server that speaks MCP.

::diagram[mcp-what-is-mcp]

MCP uses JSON-RPC 2.0 over HTTP. Each request has a `method` and `params`, and each response has either a `result` or an `error`. Two methods do most of the work:

- `tools/list` is discovery. The server returns each tool's `name`, a plain-language `description` and an input schema saying which arguments it takes.
- `tools/call` runs one tool. The request names the tool and gives its arguments, and the response carries the output as content items, mostly text.

A listing request looks like this:

```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
```

The agent does not have tool names compiled in. It lists, gives the model the names, descriptions and schemas, and the model chooses what to call. So the description is closer to a prompt than to a comment, and a server that adds a tool needs no change in any agent.

One server is simple. Ten servers mean ten addresses and ten sets of credentials in every agent. A gateway puts one endpoint in front of them, and a virtual server is the named bundle of tools it shows an agent there. The next lesson covers that.

In the lab, `weather-tools` and `calculator-tools` are real MCP servers with a few tools each and made-up data, and nothing reaches the internet. `call_tool.py` is a bare-bones agent client that prints the request it sends and the response it gets. Start with `--list` and read the request and the shape of each tool.
