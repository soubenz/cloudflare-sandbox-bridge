# Proposed scripts: four MCP explainers

For `labs/see-how-tools-reach-an-agent`. Built on the research brief
[mcp-gateway.md](mcp-gateway.md); every factual line traces to a source listed at the end.
Format and writing rules: `docs/shorts.md` and `docs/video-prompt.md`.

## How to read these tables

- **One board page per row.** A board page is one clean whiteboard with 3-6 elements (a list
  of nodes or a terminal counts as one element). Between pages the board is erased. A row
  marked "same page" keeps the previous board and adds to it, still within 6 elements.
- **ON SCREEN** lists the elements in the order they appear; the word in [square brackets] is
  the cue and appears word for word in VOICE.
- **VOICE** is one or two flowing sentences, at most about 240 characters, past tense for the
  story. Every term is defined in the sentence where it first appears. No narrated questions:
  the hook question is written on the board only.
- **NOTE** says what is lab-real (verbatim terminal output from `call_tool.py` against the
  lab's own services, already captured in `learn/short.yaml`) and what is illustrative, with
  the source number from the list at the end.
- Lengths: word counts are for VOICE only. At 160 words a minute plus the renderer's gaps
  (0.7 s between pages, 2 s tail) each video lands between about 2:35 and 2:50.

Terms are used exactly as in the brief's glossary: **MCP gateway** (never "tool gateway"),
**MCP server**, **MCP client**, **host**, **tool**, **input schema**, **virtual server**,
**protocol error**, **tool execution error**.

Colours (unchanged from `short.yaml`): agent blue, weather cyan, calculator yellow, gateway
violet, user orange, model white, ok green, bad red, quiet grey. The orders and docs servers
of the Larkfield examples are new illustrative actors; give them pink and grey.

---

## Video 1. What is MCP?

- **id** `mcp-what-is-mcp` · **idea** an agent asks an MCP server for its menu of tools and
  calls one by name · **running example** the Leeds weather question · **voice** 407 words,
  about 2:45.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: the snow answer | kicker "Agent question"; title "How did the agent know it was snowing in Leeds?" (both at 0 s); [customer] user bubble "Is it snowing in Leeds?"; [within a second] agent node "Support assistant" and its bubble "Yes, heavy snow."; caption "09:00" | On Tuesday, an assistant reported heavy snow in Leeds. A customer of Larkfield, a delivery software company, had asked it at nine in the morning, and the answer came back within a second. | Story is illustrative (Larkfield is our fictional company). |
| 2 | The model guessed | [language model] chip "model"; [training] chip "trained months ago"; [sky] sun icon with "?"; [guess] stamp "GUESS" | The assistant was built on a language model, the part that reads and writes text, and a model only knows what it read in training, months earlier. It could not see that morning's sky, so the answer was a guess. | General fact about model training data. |
| 3 | Agent and tool | [agent] node "Agent" with the model chip inside it; [tool] chip `get_weather(city)`; [a city in] text "city in → weather out" | An agent is the program around the model: it keeps the conversation and carries out what the model decides. A tool is a function in another system that the agent can run, such as get_weather, with a city in and the weather out. | `get_weather` is real in the lab (`workspace/tools/weather_tool_server.py`). Source 14 for "the application runs the tool". |
| 4 | MCP server and MCP client | erase; [MCP server] node "Weather MCP server" holding chips `get_weather`, `get_forecast`; [host] small label "host" over the agent node; [MCP client] box "MCP client" inside the agent; [exactly one server] line client to server labelled "MCP" | Tools are offered by an MCP server, a program that speaks MCP, the Model Context Protocol. Inside the agent, which the protocol calls the host, an MCP client holds the connection to exactly one server. | Host, client, server and 1:1 client-server: sources 2, 3. |
| 5 | JSON-RPC messages | card "request" `{"method": "tools/list", "params": {}}`; [result or an error] card "reply" `{"result": …}` / `{"error": …}`; [standard input] chip "stdio: a local program"; [HTTP] chip "Streamable HTTP · the lab" | Every MCP message is a small JSON document in the JSON-RPC format: a request names a method, and the reply holds either a result or an error. Messages travel over a local program's standard input and output, or over HTTP, as in the lab. | Sources 1, 7, 13. The lab uses Streamable HTTP (manifest, `mcp.run(transport="streamable-http")`). |
| 6 | The menu: tools/list | packet [tools/list] client to server; card "menu" with `get_weather` · "Get the current made-up weather for a city." · [input schema] `city: string (required)`; second entry `get_forecast` · `city, days (default 3)` at [their types] | First, the client asked the server for its menu with the method tools/list. For each tool the server sent back a name, a plain description and an input schema, the list of inputs the tool needs and their types. | Real: names, descriptions and schemas are copied from the lab's real `tools/list` output (short.yaml `tlist`). Source 4. |
| 7 | The model chooses | erase; [question] user bubble "Is it snowing in Leeds?"; [menu] stack of the two tool chips; model node; [request] chip "get_weather · city: Leeds"; [wrote] small text "writes the request, runs nothing" | The agent gave the model the customer's question together with that menu, and the model answered with a request: call get_weather with the city Leeds. The model only wrote the request; the agent acted on it. | Illustrative: the lab has no model, the learner plays the agent. Model-API tool use: source 14. Flow: source 4 ("Tool Selection"). |
| 8 | The call: tools/call | packet [tools/call] "tools/call · get_weather · {city: Leeds}"; ring on server at [ran]; packet [result] back "10 °C, cloudy"; card (simplified) `"content": text "…10 °C, cloudy", "isError": false` | The client sent tools/call with the tool's name and its arguments. The server ran the function and replied with a result whose content held the weather: ten degrees and cloudy. | Source 4 (`tools/call`, `content`, `isError`). 10 °C cloudy is the lab's real output for Leeds. |
| 9 | In the lab | layout split; terminal (real) `python3 -B call_tool.py weather-tools-get-weather '{"city": "Leeds"}'`, show "0-2,5-10"; marks [tools/call] method, [server's name] `weather-tools-get-weather`, result lines; chip "toy server" at [makes its numbers up] | In the lab you send this tools/call yourself, and the tool's name starts with the server's name, which the next video explains. The lab's weather server is a toy that makes its numbers up; the point is that the answer came from a tool. | Real terminal output (short.yaml `term`). The weather is invented by the toy server (brief §5). |
| 10 | Recap | layout canvas; erase; four numbered chips: [menu] "1 tools/list: the menu", [picked] "2 the model picks", [by name] "3 tools/call", [data] "4 a result" | Focus on what just happened: the client fetched the menu, the model picked a tool, the client called it by name, and the answer came back as data. Any agent that speaks MCP can use any MCP server this way, with no glue code per tool. | Sources 1, 4. "No glue code for one tool": configuration (the server's address) is still needed. |
| 11 | Call to action | chip "Open the lab · See how tools reach an agent" | Open the lab, See how tools reach an agent, and ask for the weather in Leeds yourself. | |

Left out on purpose (one idea per video): resources and prompts, the `initialize`
handshake (removed in the current spec and not visible in the lab), authorization.

---

## Video 2. Why an MCP gateway?

- **id** `mcp-why-a-gateway` · **idea** one proxy in front of many MCP servers gives agents one
  address and the platform team one place for registration, credentials and records ·
  **running example** Larkfield's three agents and their MCP servers, then the lab ·
  **voice** 416 words, about 2:45.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: the tangle | kicker "Platform question"; title "Three agents, four MCP servers. Who called what?" (at 0 s); [Support, Billing and Ops] column of three agent nodes; [four MCP servers] column "Weather", "Calculator", "Orders", "Docs" | By March, three agents each had their own wiring. Larkfield's Support, Billing and Ops agents each connected straight to four MCP servers: weather, a calculator, orders and docs. | Illustrative. Weather and calculator mirror the lab's two servers. |
| 2 | Same page: twelve connections | [twelve connections] 12 lines draw, counter "12 connections"; [credential] key chip on each agent "×4"; [one Friday] note card "orders slow · who was calling?" | That made twelve connections, and each one needed an address and a credential, a secret that proves who is asking, kept inside an agent. When the orders server slowed down one Friday, nobody could say which agent had been calling it. | Illustrative. |
| 3 | Same page: one more server | key chips and note fade; [fifth server] node "Maps"; [all three agents] three dashed lines; [fifteen] counter "15 connections" | When the team added a fifth server for maps, all three agents had to change their configuration, and the count rose to fifteen. | Illustrative. |
| 4 | An MCP gateway | erase; [MCP gateway] violet node in the centre; agents column left, servers column right; [one MCP server] label on the agent side "looks like one MCP server"; [their client] label on the server side "acts as MCP client" | An MCP gateway is a proxy, a program in the middle of every call: to the agents it looks like one MCP server, and to the real MCP servers it acts as their client. | Definition synthesised from sources 15-21; ContextForge "runs as a fully compliant MCP server" (15). |
| 5 | Registration and catalogue | [registered] operator icon with card "name + URL" into the gateway; [tools/list] packets from the gateway to each server; [catalogue] list inside the gateway "catalogue" | An operator registered each MCP server with the gateway once, by name and address. The gateway then asked every server for its menu with tools/list and kept the answers in one catalogue. | The server does nothing to register; in the lab `seed_contextforge.py` does it. Sources 15, 22. |
| 6 | One address | [one address] chip "mcp.larkfield.internal"; lines: three agents to the gateway, gateway to five servers; [eight] counter "8 connections" | Each agent now needed one address, the gateway's, and asking it for the menu returned tools from every server behind it. Three agents and five servers came to eight connections instead of fifteen. | Illustrative address. Single endpoint: sources 15, 16, 17. |
| 7 | Credentials stay inside | [moved] key chips glide from the agents into the gateway; [own credential] one badge chip per agent; [passing on] chip "agent's token → server" with a red cross | The credentials for the real servers moved into the gateway, so each agent held only its own credential for the gateway. The MCP specification also forbids a server from passing on a token that was issued for someone else. | Credential injection: sources 16, 17; ContextForge stores credentials encrypted (22). Token passthrough forbidden: sources 10, 11. Illustrative in the lab (no upstream credentials). |
| 8 | One place to watch | [record] card "gateway log (illustration)": `08:14 · Ops · orders-get-order · ok · 120 ms`; [how long] ring on "120 ms"; [who asked] ring on "Ops"; [limit] chip "limit: 100 calls a minute" | Because every call passed through one place, the gateway could record each one: which tool, when, how long it took, whether it worked and, with a credential per agent, who asked. The same place could also limit how often an agent may call. | Logging: sources 16, 17, 19, 22. 100 a minute is ContextForge's default `tool_rate_limit` (22). The lab log has no caller column and rate limiting is off (brief §5). |
| 9 | What it is not | erase; chip "runs the tools" with cross; chip "chooses the tools" with cross; [AI gateway] chip "AI gateway: calls to language models" | An MCP gateway runs no tools and chooses none: the MCP servers still do the work, and the model still makes the choice. An AI gateway is a different thing, which carries the agents' calls to language models. | Brief §3.3. |
| 10 | In the lab | layout split; [ContextForge] gateway node relabelled "ContextForge"; terminal (real) `python3 -B call_tool.py --list`, show "0,5-10", clip 50; marks [its address] url, [five tools] weather and calculator names | In the lab, the MCP gateway is ContextForge, IBM's open-source gateway, with two toy MCP servers registered. One tools/list sent to its address returned five tools from both servers. | Real terminal output (short.yaml `tlist`). Source 15. |
| 11 | The record in the lab | terminal (real) `calculator-tools-add '{"a": 17, "b": 25}'`; mark [forty-two] `42.0`; [view tab] chip "view tab: tool · time · success · response time" | Calling add with seventeen and twenty-five returned forty-two, and the view tab showed that call as a new row with the tool, the time, whether it worked and how long it took. | Real output (short.yaml `tadd`); view columns from `workspace/view_service.py` (ContextForge's `tool_metrics`). |
| 12 | Recap | layout canvas; erase; four chips [registered once], [one address], [credentials], [record] | Focus on what changed: servers were registered once, agents learned one address, credentials stayed in the gateway, and every call left a record in one place. | |
| 13 | Call to action | chip "Open the lab · See how tools reach an agent" | Open the lab, See how tools reach an agent, and find your own calls in the view tab. | |

---

## Video 3. Virtual servers: the right tools for each agent

- **id** `mcp-virtual-servers` · **idea** a virtual server is a named bundle of tools at its
  own MCP address, so each agent is offered only what it needs · **running example** Support's
  and Billing's bundles at Larkfield, then `toy-tools` in the lab · **voice** 380 words, about
  2:35.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: the refund tool | kicker "Access question"; title "Should the support assistant see the refund tool?" (at 0 s); [support assistant] agent node; [twelve tools] menu list of 12 chips; [moved real money] ring on red chip `issue_refund` | In May, the support assistant's menu listed a refund tool. Larkfield's MCP gateway showed every agent all twelve tools in its catalogue, and one of them, issue_refund on the orders server, moved real money. | Illustrative (no orders server in the lab). |
| 2 | Same page: the model can pick it | model node beside the agent; [by mistake] dashed arrow from the model to `issue_refund`; [weather and the calculator] ring on those chips | The model picks from whatever the menu offers, so any tool on the support menu was one the model could choose by mistake. Support only needed the weather and the calculator. | Tools are model-controlled: source 4. |
| 3 | A virtual server | erase; [catalogue] grey column of 12 tools; [virtual server] box "support-tools"; [own MCP address] chip `/servers/<id>/mcp`; [ordinary MCP server] arrow agent to box, label "looks like one MCP server" | A virtual server is a named bundle of tools picked from the gateway's catalogue, with its own MCP address. To an agent it looks like an ordinary MCP server. | ContextForge definition and endpoint: sources 15, 22. |
| 4 | Same page: Support's bundle | [five tools] chips `get_weather`, `get_forecast`, `add`, `subtract`, `multiply` move into the box; [left out] stamp "left out" on `issue_refund` | The team gave Support a virtual server with five tools: get_weather and get_forecast from the weather server, and add, subtract and multiply from the calculator. issue_refund was left out. | The five tools match the lab; leaving one out is illustrative (the lab's `toy-tools` holds all five, nothing is left out). |
| 5 | Same page: Billing's bundle | [different virtual server] box "billing-tools" with `add`, `issue_refund`; [several] one line from `add` to both boxes | Billing got a different virtual server that did include the refund tool. One tool can sit in several virtual servers, because a virtual server only points at tools; it copies and runs nothing. | Many-to-many `server_tool_association` in ContextForge (22). |
| 6 | Prefixes | erase; [called search] two chips "search" from "Docs" and "Orders" with "?"; [in front] the same chips as `docs-search`, `orders-search`; [weather-tools-get-weather] arrow `get_weather` → `weather-tools-get-weather` | Two MCP servers can each offer a tool called search, so ContextForge, the MCP gateway in our lab, puts the registered server's name in front: get_weather on the server registered as weather-tools became weather-tools-get-weather. | Spec says aggregators SHOULD prefix (4); ContextForge ADR-0011 (23). The lab name is real output. |
| 7 | What the agent sees, what the gateway knows | erase; two columns. [saw] left "agent sees": "one address", "names", "descriptions", "input schemas". [knew] right "gateway knows": "owner MCP server", "original name `get_weather`", "server address", "credentials" | From its virtual server the agent saw one address and a list of names, descriptions and input schemas. Only the gateway knew which MCP server owned each tool, the tool's original name, the server's address and its credentials. | ContextForge keeps `original_name` and the gateway slug (23). |
| 8 | Routing one call | [called] packet agent to gateway "weather-tools-get-weather · Leeds"; [looked up] ring on the gateway; [passed] packet gateway to weather server "get_weather · Leeds" | When Support called weather-tools-get-weather, the gateway looked up the owner, used the original name get_weather, and passed the call to the weather server. | Source 23 (invocation uses `original_name`). |
| 9 | A bundle is a menu | erase; Support agent; [one virtual server] chip "credential: support-tools only"; [direct route] dashed arrow from the agent straight to the orders server, red cross | A virtual server hides tools from a menu, and it works as a control only when the agent's credential is good for that one virtual server and the agent has no direct route to the MCP servers behind it. | ContextForge server-scoped tokens (24). Brief §3.3. In the lab every call uses the same admin identity, so nothing is enforced. |
| 10 | In the lab | layout split; terminal (real) `python3 -B call_tool.py --list`; marks [toy-tools] the "virtual server 'toy-tools'" line, [prefix] the five names | In the lab, the virtual server is called toy-tools and holds all five tools of the two toy servers, each with its prefix. The view tab lists the registered servers, the discovered tools and the virtual server on one page. | Real output (short.yaml `tlist`); view tab tables: `workspace/view_service.py`, brief.md. |
| 11 | Recap | layout canvas; erase; three chips [catalogue], [picked a few], [prefixes]; gateway node at [details] | Focus on what just happened: the catalogue held every tool, each virtual server picked a few under one address, prefixes kept names apart, and the gateway kept the details the agents never saw. | |
| 12 | Call to action | chip "Open the lab · See how tools reach an agent" | Open the lab, See how tools reach an agent, and count the tools toy-tools offers an agent. | The count is the lab's first question (`learn/questions.yaml`). |

---

## Video 4. When a tool fails

- **id** `mcp-when-a-tool-fails` · **idea** HTTP 200 only says the message arrived; MCP reports
  failure in the body, as a protocol error or as a tool execution error, and the agent must
  read it · **running example** the Leeds forecast that came back with `isError`, then the
  lab's `does-not-exist` call · **voice** 385 words, about 2:35.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: 200 and wrong | kicker "Debugging question"; title "The call returned 200 OK. Why was the forecast wrong?" (at 0 s); [HTTP 200] green chip "HTTP 200 OK"; [heavy snow] agent bubble "Expect heavy snow in Leeds."; caption "08:10" | The forecast call came back with HTTP 200. Minutes later, Larkfield's support assistant told a customer to expect heavy snow in Leeds, and no snow fell. | Illustrative story. |
| 2 | Follow the call | erase; chain: agent → [MCP gateway] → [weather MCP server] → [weather service] cloud node; packet `get_forecast · Leeds` along each link; [in time] clock icon and red chip "timed out" on the weather service | The assistant had called get_forecast for Leeds through the MCP gateway, which passed it to the weather MCP server. That server asked an outside weather service for the data, and the service did not answer in time. | Illustrative: the lab's weather server calls no outside service and never times out. |
| 3 | Same page: the reply | packets ride back; card "the reply" (simplified) `"result": {"isError": true, "content": text "Weather service timed out"}`; marks [isError] and [short text message]; [tool execution error] label under the card | The weather server did not crash. It sent back a normal result with isError set to true and a short text message, weather service timed out, which the specification calls a tool execution error. | Shape: source 5 (API failures are tool execution errors). Content illustrative. |
| 4 | Status and body | erase; [delivered and answered] envelope icon with chip "HTTP 200"; [body] the reply card again, ring on `isError` | HTTP only reported that the request was delivered and answered, so its status was 200. Whether the tool worked was written in the body. | Lab-real pattern (`does-not-exist` returns 200 with `isError`). |
| 5 | What went wrong | card "assistant code (illustration)" `if status == 200: use it`; [threw the message away] message chip drops off the board; model node; [guess] stamp "GUESS" | The assistant's code checked only the status and threw the message away, so the model received no forecast and filled the gap with a guess. | Illustrative. The spec says clients SHOULD pass tool execution errors to the model (5). |
| 6 | The other kind: protocol error | erase; card "request" `"method": "tools/calll"`; [error object] card `"error": {"code": -32601, "message": "Method not found"}`; [no result] note "no result"; [protocol error] label | The other kind is a protocol error, for a request the server could not handle at all, such as a misspelt method name. The reply then holds an error object with a code and a message, and no result. | JSON-RPC code `-32601` (13); illustration, not run in the lab (the lab's HTTP status for this case is UNVERIFIED, and under the current spec it would be 404, source 8). |
| 7 | Which is which | erase; two columns. Left "protocol error · error object": [unknown tool] "unknown tool", "malformed request". Right "tool execution error · isError": [failed API] "API failed", "bad input value", "business rule"; [correct itself] note under the right column "written for the model" | The MCP specification lists an unknown tool and a malformed request as protocol errors. A failed API, a bad input value or a broken business rule are tool errors, written so the model can read them and correct itself. | Source 5 (2026-07-28; input validation moved to tool errors in 2025-11-25). |
| 8 | In the lab | layout split; terminal (real) `python3 -B call_tool.py does-not-exist '{}'`, show "1-4"; marks [HTTP 200] `HTTP 200`, [isError] `"isError": true`, [tool not found] `Tool not found: does-not-exist` | In the lab, a call to a tool named does-not-exist came back with HTTP 200, isError set to true, and the message: tool not found. | Real output (short.yaml `terr`); graded by `answers-match-the-gateway`. |
| 9 | Same page: lab vs specification | two chips beside the terminal: [specification] "spec: unknown tool → protocol error"; [ContextForge] "ContextForge 1.0.10 → isError result"; [MCP Python SDK] small text "MCP Python SDK"; [read the body] chip | The specification files an unknown tool under protocol errors; ContextForge reports it as a tool error, because the MCP Python SDK beneath it turns any failure inside a tool call into one. The shape depends on the server, so read the body. | Sources 5, 25, 26 (brief §2.6). |
| 10 | What a careful agent does | layout canvas; erase; decision tree from a "reply" node: [error object] → "agent's code: fix the request, fetch the menu again"; [isError] → "model reads the message" → three branches [fix an input], [retry once], [tell the customer]; bubble "Sorry, I have no forecast for Leeds right now." | A careful agent reads the body. On an error object its own code steps in, for example by fetching the menu again; on isError it hands the message to the model, which can fix an input, retry once, or tell the customer it has no forecast. | Source 5 ("Clients SHOULD provide tool execution errors to language models"). "Retry once" is our advice, not a spec rule. |
| 11 | Recap | three chips [status], [body], [told the truth] | Focus on what just happened: the status said the message arrived, the body said whether the tool worked, and the agent that read the body told the truth instead of guessing. | |
| 12 | Call to action | chip "Open the lab · See how tools reach an agent" | Open the lab, See how tools reach an agent, and call a tool that does not exist. | |

---

## Read-aloud check (done)

- No VOICE cell is a narrated question; hook questions are board titles only.
- First spoken sentences: V1 "On Tuesday, an assistant reported heavy snow in Leeds." (9
  words), V2 "By March, three agents each had their own wiring." (9), V3 "In May, the support
  assistant's menu listed a refund tool." (10), V4 "The forecast call came back with HTTP
  200." (8).
- Terms defined at first use: language model (V1 #2), agent and tool (V1 #3), MCP server,
  MCP, host, MCP client (V1 #4), JSON-RPC (V1 #5), input schema (V1 #6), credential (V2 #2),
  MCP gateway, proxy (V2 #4), catalogue (V2 #5), AI gateway (V2 #9), virtual server (V3 #3),
  tool execution error (V4 #3), protocol error (V4 #6). Videos 2-4 reuse terms from video 1
  with a short reminder in passing.
- No jokes, no "okay/so/here's the thing", no narrator "I". Past tense for the Larkfield
  stories; present tense only for definitions and the call to action.
- "Tool gateway" appears in no VOICE or ON SCREEN cell.

## Claims that depend on a source

Numbers are used in the NOTE columns.

1. MCP is an open standard for connecting AI applications to external systems; "USB-C port"
   analogy; MCP uses JSON-RPC 2.0 messages. https://modelcontextprotocol.io/docs/getting-started/intro ,
   https://modelcontextprotocol.io/specification/latest
2. Hosts, clients, servers; each client talks to exactly one server; the agent application is
   the host. https://modelcontextprotocol.io/specification/2026-07-28/architecture
3. "MCP server refers to the program that serves context data, regardless of where it runs";
   VS Code host example; stdio vs Streamable HTTP; tools/resources/prompts.
   https://modelcontextprotocol.io/docs/learn/architecture
4. `tools/list` returns name, description, `inputSchema`; `tools/call` with name and
   arguments; result `content`, `structuredContent`, `isError`; tools are model-controlled;
   aggregators SHOULD prefix tool names; the list MAY vary by authorization.
   https://modelcontextprotocol.io/specification/2026-07-28/server/tools
5. Protocol errors (unknown tool, malformed request, server error) vs tool execution errors
   (API failures, input validation, business logic); clients SHOULD give tool execution
   errors to the model. https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling ;
   older wording: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
6. Current spec revision 2026-07-28. https://modelcontextprotocol.io/specification/versioning
7. Transports: stdio and Streamable HTTP.
   https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
8. Streamable HTTP: one MCP endpoint, POST, JSON or SSE replies; unknown method → 404 with
   `-32601` in 2026-07-28; headers "so that intermediaries (load balancers, gateways,
   observability tooling) can route and inspect requests".
   https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
9. Handshake-based lifecycle of 2025-11-25 (the lab's era).
   https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
10. Authorization is optional, OAuth 2.1 based; servers "MUST NOT accept or transit any other
    tokens". https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
11. Token passthrough is "explicitly forbidden".
    https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
12. MCP donated to the Agentic AI Foundation (Linux Foundation), 2025-12-09.
    https://anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation
13. JSON-RPC 2.0 error codes (`-32601` Method not found, `-32602` Invalid params).
    https://www.jsonrpc.org/specification
14. The model returns a structured call that the application runs (tool use / function
    calling). https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
15. ContextForge: "registry and proxy that federates tools, agents, and APIs into one clean
    endpoint"; "runs as a fully compliant MCP server"; "Create a virtual server bundling those
    tools"; `/servers/<id>/mcp`. https://github.com/IBM/mcp-context-forge (README at tag
    v1.0.10), https://ibm.github.io/mcp-context-forge/latest/
16. Docker MCP Gateway: single entry point, credential injection, container isolation,
    logging. https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/
17. Cloudflare MCP server portals: single endpoint, namespacing, credentials attached, per-portal
    tool selection, request logs.
    https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/
18. Microsoft MCP Gateway: "a reverse proxy and management layer for MCP servers".
    https://github.com/microsoft/mcp-gateway
19. Kong AI MCP Proxy and per-tool ACLs. https://developer.konghq.com/plugins/ai-mcp-proxy/ ,
    https://developer.konghq.com/mcp/
20. agentgateway: tool access per identity. https://agentgateway.dev/
21. Azure API Management exposes REST APIs as MCP servers.
    https://learn.microsoft.com/azure/api-management/mcp-server-overview
22. ContextForge 1.0.10 source: `/v1/gateways` registration, admin UI "MCP Servers" /
    "Virtual Servers", `server_tool_association`, `tool_rate_limit = 100`,
    `AUTH_ENCRYPTION_SECRET` "Encryption key for stored credentials", `tool_metrics` columns.
    https://github.com/IBM/mcp-context-forge/tree/v1.0.10 (`mcpgateway/config.py`,
    `mcpgateway/db.py`, `mcpgateway/templates/admin.html`)
23. Tool name = gateway slug + separator + original name; `original_name` used for the call.
    https://ibm.github.io/mcp-context-forge/architecture/adr/011-tool-federation/
24. Server-scoped tokens "restricted to specific MCP servers". ContextForge
    `docs/docs/manage/securing.md` at v1.0.10,
    https://ibm.github.io/mcp-context-forge/manage/securing/
25. ContextForge's Streamable HTTP `call_tool` re-raises tool lookup failures for the MCP SDK
    to convert. `mcpgateway/transports/streamablehttp_transport.py` at
    https://github.com/IBM/mcp-context-forge/tree/v1.0.10
26. MCP Python SDK 1.28.1 turns an exception in a tool handler into an `isError` result
    (`_make_error_result(str(e))` in `mcp/server/lowlevel/server.py`).
    https://pypi.org/project/mcp/1.28.1/
27. Lab facts (Leeds 10 °C cloudy, five tools, 42.0, `does-not-exist` → 200 + `isError`, view
    tab columns): `labs/see-how-tools-reach-an-agent/` (`workspace/`, `learn/short.yaml`
    terminal output, `checks/_harness.py`, `solution/answers.json`).
