---
id: mcp.tool-errors
title: How a tool call fails, and what the agent sees
minutes: 3
recap: An MCP failure is either a JSON-RPC error instead of a result, or a result flagged isError; HTTP 200 can carry either, so read the body.
---
When a tool call goes wrong, the model behind the agent has to find out and decide what to do next. It only sees what the protocol hands back, so it matters where the failure is reported.

::diagram[mcp-tool-errors]

MCP has two places for it, and both can arrive inside an HTTP 200.

The first is a JSON-RPC error. The response has an `error` object, with a code and a message, in place of a `result`. This layer is for protocol-level trouble: a malformed request, a method the server does not have, arguments that do not fit the input schema.

The second is a tool execution error. The response has a normal `result`, but it carries `"isError": true`, and the `content` holds a text message describing what went wrong. This layer is for a call that reached the tool machinery and failed there: the tool raised, an upstream service was down, an input was refused.

Why two? The second kind is designed to be read by the model. The message goes back as ordinary content, so the model can see "that city was not found", correct itself and try again. A JSON-RPC error is more likely to be handled by the agent's framework than shown to the model.

The trap is the HTTP status. Because the transport worked, it is 200 in both cases, and a client that only checks the status will treat a failed call as a success. A careful client checks the status, then whether the body has `error`, then whether the result has `isError`, in that order.

A gateway adds one more wrinkle. It sits between the agent and the tool server, and it reports a failure in one of those two shapes, so which shape you get can depend on where the failure happened and how the gateway maps it. Do not guess from memory. Make the call and read what comes back.

In the lab, `call_tool.py` prints the raw response first. After that it prints `reported an error` when it finds `isError`, or `returned no result` and the error object when the response has no result. So the last line tells you which layer you hit. The **view** tab also has an error column in the gateway's own call log.
