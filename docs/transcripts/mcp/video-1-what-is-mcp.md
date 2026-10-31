# Video 1. What is MCP?

429 spoken words, about 2:31 at 170 words a minute (page pauses come on top).

## Scene 1: The frozen model

1. **Hook.** Ask ChatGPT whether it's snowing in Leeds right now, and it can tell you, even though its training ended months ago. So where did that answer come from? Let's trace it.
2. **The gap.** The language model, the part writing the reply, can't know. What it learned stops at that calendar, so alone it'd be guessing.
3. **A tool.** Instead, the app around it asks a tool, a function in another program that fetches live data. MCP is the standard way to plug one in. That's the whole trick. Who's involved?

## Scene 2: Who's involved

4. **The agent.** Same Leeds question, fresh board. The program receiving it is the agent: it keeps the conversation and does whatever the model decides, so the model sits inside it.
5. **The MCP server.** Far right, a separate program with two functions, get_weather and get_forecast. Each one's a tool, and a program offering tools this way is an MCP server. MCP means Model Context Protocol.
6. **The MCP client.** The model doesn't talk to it directly. Inside the agent sits the MCP client, which holds the connection to exactly one server, this line. The spec calls the agent the host. What travels along that line?

## Scene 3: Asking for the menu

7. **tools/list.** Small JSON messages, a format called JSON-RPC. You send a request naming a method and get back a result or an error. First comes tools/list: the agent asking what's on offer.
8. **The menu.** Back comes the menu: two tools, each with a name and a short description written for the model, not you.
9. **The input schema.** Zoom in and there's a third part, the input schema: what the tool needs. get_weather wants a city, a string. get_forecast also takes days, a whole number, three by default. So who picks?

## Scene 4: Making the call

10. **The model picks.** The model does. The agent hands it your question and that menu, and it answers with a request: call get_weather, city Leeds. Notice what it didn't do: it wrote the request and ran nothing.
11. **tools/call and the result.** Running it is the client's job. It sends tools/call down the line, with the name and the arguments. The server runs get_weather and a result comes back: Leeds, ten degrees, cloudy. The model writes the reply: no snow.

## Scene 5: In the lab

12. **The same call, typed.** In the lab you play the client and send that tools/call yourself. Same result, ten and cloudy, from a toy server that invents it. Only the name differs, by a prefix, weather-tools, which the next video explains.

## Scene 6: Recap

13. **One clean picture.** Same picture, cleaned up: tools/list fetches the menu, the model writes a request, tools/call runs it, and the result comes back. That's how a model trained months ago told you today's weather.
14. **Call to action.** Open the lab, See how tools reach an agent, and ask for Leeds yourself. Next time: ten agents, twenty MCP servers, two hundred connections.
