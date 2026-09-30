---
id: platform.end-to-end-check
title: Proving a new team works end to end
minutes: 3
recap: A team works only when a real model call and a real tool call both succeed. A tool result flagged isError has failed even on HTTP 200.
---
Configuration can look complete and still fail on the first request. Keys can be scoped to an alias that has no model behind it. A tool server can be registered but empty. A virtual server can exist and offer no tools. The only proof is a request that uses everything that was set up, in the order a real service would use it.

::diagram[platform-end-to-end-check]

For a team like the one in this lab, that is two calls.

**The model half.** Call `/chat/completions` on the gateway with the new key and the alias the team was granted. A 200 with a reply in `choices` means the key, the team, the alias and the provider behind it all lined up.

**The tool half.** Tools are called over MCP, which is JSON-RPC carried on HTTP. You post to the virtual server's address, `/servers/{server id}/mcp`, with a body like `{"method": "tools/call", "params": {"name": ..., "arguments": {...}}}`. The tool name the hub exposes is prefixed with the name of the tool server it came from, so a tool called `get_weather` on a server called `weather-tools` appears as `weather-tools-get-weather`. Getting the prefix wrong is the most common reason a first tool call fails.

Read the answer carefully. A tool call can return HTTP 200 and still have failed: the result carries an `isError` flag, and an agent will treat the call as failed when it is set. Check the status and the flag.

The two halves also fail differently. A refused key gives a 401 or 403 from the gateway. A missing tool gives an error from the hub. Because each half is served by a different component, an end-to-end check that reads only one of them proves half.

Finally, how does anyone know the check itself is honest? The lab's grader does not read what `onboard.py` printed. It runs its own onboarding, with its own names, against the same services, and compares your answers to what actually happened. Do the same yourself. A transcript from an earlier run tells you what was true earlier.

In the lab, step 5 of `onboard.py` performs the whole check and prints a status for each call along with what the model and the tool replied. Read those lines, then decide what your third answer is.
