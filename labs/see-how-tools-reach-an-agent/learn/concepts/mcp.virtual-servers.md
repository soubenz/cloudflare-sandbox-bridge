---
id: mcp.virtual-servers
title: "Virtual servers: one endpoint over many tool servers"
minutes: 3
order: 2
recap: A gateway registers tool servers, discovers their tools, and exposes a chosen set through one virtual server; an agent sees only that set.
---
The last lesson ended with a problem: many tool servers, and an address and credentials for each in every agent. Security's request was one door instead. A tool gateway is that door, and ContextForge, the gateway in this lab, builds it in three steps that are worth keeping apart, because each one has its own list.

::diagram[mcp-virtual-servers]

First, you register a tool server with the gateway. ContextForge calls this a gateway too, which is confusing, so think of it as a registration: a name and a URL. Here there are two, `weather-tools` and `calculator-tools`. The gateway connects, asks the server `tools/list` and remembers the tools it finds. These are the discovered tools. Each gets a gateway-prefixed name, which is why the calculator's `add` becomes `calculator-tools-add`. The prefix means two servers can each have a tool with the same name without colliding.

Second, you create a virtual server: a named bundle of tools chosen from the discovered ones. Here it is `toy-tools`. It gets its own endpoint, of the form `/servers/ID/mcp`, and an agent connected there is speaking MCP to what looks like an ordinary single tool server. It has no idea that its tools come from different servers behind the gateway.

Third, agents connect to the virtual server, not to the tool servers and not to the registry. That is the useful part. A virtual server can hold fewer tools than the gateway has discovered, so different agents can be given different bundles. Support's assistant does not need to see a tool that only Billing should use.

The consequence for a question like "how many tools can an agent see?" is that the registry is the wrong place to count. Discovered tools are everything the gateway knows about, while what an agent can reach is whatever `tools/list` returns from the virtual server's own endpoint. Those two numbers are allowed to differ.

The gateway is also where logging lives. Every call passes through it, so it can record who called what and how it went, without asking any tool server to do it.

In the lab, the **view** tab has a table each for registered gateways, discovered tools and the virtual server. `call_tool.py --list` asks the virtual server itself, which is what an agent would see.
