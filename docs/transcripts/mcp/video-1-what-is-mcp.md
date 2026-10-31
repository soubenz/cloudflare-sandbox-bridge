# Video 1. What is MCP?

434 spoken words, about 2:33 at 170 words a minute (page pauses come on top).

## Scene 1: The frozen model

1. **Hook.** Ask ChatGPT whether it's snowing in Leeds right now, and it can tell you, even though its training ended months ago. So where did that answer come from? Let's trace it.
2. **The gap.** The language model, the part writing the reply, can't know. What it learned stops at that calendar, and it can't go and look: a model only reads and writes text. Alone, it'd be guessing.
3. **A tool.** Instead, the app around it asks a tool: a function in another program that fetches live data. MCP is the standard way to plug one in. That's the whole trick. Who's involved?

## Scene 2: Who's involved

4. **The agent.** Same Leeds question. The program receiving it is the agent: it keeps the conversation and does what the model decides, so the model sits inside it.
5. **The MCP server.** Far right, another program with two functions, get_weather and get_forecast. Each is a tool, and a program offering tools this way is an MCP server.
6. **Why a standard.** Build it once, and any app that speaks MCP can use it, instead of wiring every tool into every app.
7. **The MCP client.** The model doesn't talk to it directly; it can't, remember. Inside the agent sits the MCP client, which holds the connection, this line. What travels along it?

## Scene 3: Asking for the menu

8. **tools/list.** Small JSON messages, called JSON-RPC. First comes tools/list, the agent asking what's on offer.
9. **The menu.** Back comes the menu: two tools, each a name and a short description, written for the model, not you, because the model picks a tool by reading it.
10. **The input schema.** The third part, the input schema, is what the tool needs: get_weather wants a city. Now the model knows what to fill in, and the server can check what arrives. Who picks?

## Scene 4: Making the call

11. **The model picks.** The model does. Given your question and that menu, it answers with a request: call get_weather, city Leeds.
12. **Why the model only writes.** It wrote the request and ran nothing. That's deliberate: it keeps the app in control. It can show you the request and let you say no, hold any keys, and log what was called.
13. **tools/call and the result.** Running it is the client's job. It sends tools/call down the line, and get_weather runs. Back comes the result, Leeds, ten degrees, cloudy, and the model writes the reply: no snow.

## Scene 5: In the lab

14. **The same call, typed.** In the lab you play the client and send that tools/call yourself. Ten and cloudy again, invented by a toy server. The name has a prefix, weather-tools, which the next video explains.

## Scene 6: Recap

15. **One clean picture.** Same picture: tools/list fetches the menu, the model writes a request, tools/call runs it, the result comes back. That's how a model trained months ago told you today's weather.
16. **Call to action.** Open the lab, See how tools reach an agent, and ask for Leeds yourself. Next time: ten agents, twenty MCP servers.
