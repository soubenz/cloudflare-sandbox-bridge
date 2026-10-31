# Video 1. What is MCP?

453 spoken words, about 2:40 at 170 words a minute (page pauses come on top).

## Scene 1: The frozen model

1. **Hook.** Ask ChatGPT whether it's snowing in Leeds right now, and it can tell you, even though its training ended months ago. So where did that answer come from? Let's trace it.
2. **The model.** The part writing the reply is the language model: it reads and writes text, and what it knows ends at that calendar. Today's weather lies past it, so alone it can only guess.
3. **The app and a tool.** So the app around the model calls a tool, a function in another program that fetches live data, and hands back the result. MCP is the standard way to plug tools in. What passes between them?

## Scene 2: One lookup, end to end

4. **The agent.** Same question, now with the whole machine drawn. The program receiving it is the agent: it keeps the conversation and carries out what the model decides, so the model sits inside it.
5. **The MCP server.** The weather lives far right, in a separate program with two named functions, get_weather and get_forecast. Each is a tool, and a program offering tools this way is an MCP server. MCP is the Model Context Protocol.
6. **The MCP client.** Who talks to it? Not the model. Inside the agent sits the MCP client, which holds the connection to exactly one server, this line. The protocol calls the agent the host. What travels along that line?
7. **tools/list.** Small JSON messages, a format called JSON-RPC: a request names a method; the reply is a result or an error. First comes tools/list, and back comes the menu: each tool's name and a description written for the model.
8. **The input schema.** Under each name sits what the tool needs, its input schema: get_weather takes one input, city, a string; get_forecast adds days, a whole number, three by default. Who picks from it?
9. **The model picks.** The model does. The agent hands it the question and the menu, and it answers with a request: call get_weather, city Leeds. Notice what it did not do: it wrote the request and ran nothing.
10. **tools/call and the result.** Running is the client's job: it sends tools/call down the same line, with name and arguments. The server runs the tool and replies with a result; its content is the answer, Leeds, ten degrees, cloudy, and the chat answers: no snow.

## Scene 3: In the lab

11. **The same call, typed.** In the lab you send this tools/call yourself, as the client. The result is the same, ten and cloudy, from a toy server that makes the weather up. Only the name differs: a prefix, weather-tools, which the next video explains.

## Scene 4: Recap

12. **Four steps on one picture.** Focus on what just happened. One, tools/list fetched the menu. Two, the model picked and wrote the request. Three, tools/call ran it. Four, the result came back: a model trained months ago had today's weather.
13. **Call to action.** Open the lab, See how tools reach an agent, and ask for the weather in Leeds yourself. Next: ten AI agents, twenty MCP servers, and two hundred connections.
