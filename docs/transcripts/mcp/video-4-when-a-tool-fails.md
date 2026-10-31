# Video 4. When a tool fails

458 spoken words, about 2:42 at 170 words a minute (page pauses come on top).

## Scene 1: The line

1. **Hook.** This line is why your AI agent makes things up when a tool fails. You have probably written it. Under it, a reply, 200 with isError true, and the snow invented from it. What did that 200 promise?
2. **Envelope and body.** Only that the request was delivered and answered: 200 is the envelope. Whether the tool worked is in the body, next to isError: weather service timed out. This line never reads the body. Where did it come from?

## Scene 2: Follow the call

3. **The chain.** Tomas, the staff engineer, pulled the trace: the agent had called get_forecast for Leeds through the MCP gateway, on to the weather MCP server. What happened there?
4. **The far end.** It asked an outside service for real data, this cloud past the server, which did not answer in time: timed out. The chain broke at its far end. What came back?
5. **The reply.** A normal result rides back along the same lines, 200 on the envelope: isError true, weather service timed out. The specification calls this a tool execution error: the tool ran, failed, said so. Did the model read it?
6. **What went wrong.** No. The line took 200 as proof and passed the result on unread, so the model saw a weather result with no weather and guessed: heavy snow. Is every failure like this?

## Scene 3: Two shapes

7. **The other kind.** No; failure has two shapes. Left, the reply we followed. Right, a protocol error: the server could not handle the request itself, a misspelt method, tools/calll, and replies with an error object, code and message, no result.
8. **Which is which.** The specification sorts them. A failed API, a bad input or a broken rule are tool execution errors, written for the model. An unknown tool or a malformed request are protocol errors, for the agent's code. Which does the lab show?
9. **In the lab.** In the lab, a call to a tool named does-not-exist returns HTTP 200, isError true, and the text Tool not found: the left shape, though the specification files an unknown tool on the right.
10. **Lab versus specification.** ContextForge answers left because the MCP Python SDK beneath it turns any failure inside a tool into an isError result. The shape depends on the server; the rule does not: read the body. And then?

## Scene 4: A careful agent

11. **The line rewritten.** Rewrite the line to branch. On an error object the agent's code steps in, say to fetch the menu again. On isError, the text goes to the model: fix an input, retry, or admit it. Sorry, no forecast for Leeds right now.
12. **Recap.** Focus on what just happened. One, the status said it arrived. Two, the body said whether the tool worked. Three, two shapes: isError or an error object. Four, read it, and the agent tells the truth.
13. **Call to action.** Open the lab, See how tools reach an agent, and call a tool that does not exist. That closes the set: MCP server, MCP gateway, virtual server, failed call.
