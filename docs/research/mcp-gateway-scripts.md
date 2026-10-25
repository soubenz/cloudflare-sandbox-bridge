# Proposed scripts: four MCP explainers

For `labs/see-how-tools-reach-an-agent`. Built on the research brief
[mcp-gateway.md](mcp-gateway.md); every factual line traces to a source listed at the end.
Format and writing rules: `docs/shorts.md` and `docs/video-prompt.md`.

## Hook options

The owner rejected the current page-1 hooks (worked example of why:
[hooks.md, section 8](hooks.md#worked-bad-example-our-rejected-hook)). Below are three
replacements per video, written to the [hook checklist](hooks.md#7-hook-checklist-apply-to-every-video).
The tables further down are unchanged until the owner picks; the "Page 2" line says what the
existing page 2 would need so the first piece of the answer lands within about 20 s.

Every option: no names, no Larkfield, no term in the first line; the kicker and title are on
the board at 0 s; the first spoken line is under 12 words (count in brackets). The story
(Ollie, Maren, Priya, Tomasz) starts on page 2 or later. An option that speaks its question
(V1 A) reads the board question aloud once; that needs the "No narrated questions" rule in
"How to read these tables" relaxed for page 1, as the playbook now allows.

### Video 1. What is MCP?

| | Kicker | On-screen question | Picture at 0 s | Spoken (first line, then at most one sentence) | Pattern |
|---|---|---|---|---|---|
| **A (recommended)** | INTERVIEW QUESTION | How does an AI model know today's weather? | Left: model chip under a torn calendar page "trained: months ago" (grey). Right: chat bubble "Leeds, now: 10 °C, cloudy" with a ticking clock "now". Between them an arrow with a "?" that pulses at 0.5 s. | "This AI model stopped learning months ago." (7) "So how can it tell you the weather in Leeds right now?" | Curiosity gap with a concrete contrast (months ago vs now); interview question |
| B | AI QUESTION | Why did the AI invent snow? | Chat bubble "Heavy snow in Leeds today"; beside it a window card "Leeds: 10 °C, cloudy"; a red stamp "NO SNOW" lands at 1 s. | "The AI promised heavy snow in Leeds." (7) "It was ten degrees and cloudy." | Show the failure first (confident and wrong) |
| C | COMMON MYTH | Does the AI call the weather API itself? | Model chip with an arrow to "weather API", crossed out in red at 1 s; an empty dashed box "?" between them. | "The AI model never calls the weather API." (8) "Another program does; the model only asks." | Myth / counterintuitive claim |

- **Page 2.** A: replace the existing voice with "A language model, the part that reads and
  writes text, knows only its training. Alone, it guesses: Larkfield's assistant once promised
  heavy snow in Leeds that never fell." (26 words; the answer starts by about 20 s: alone it
  cannot, it guesses.) Page 3 then ends "Ollie, who built that assistant, put the fix there."
  B: the existing page 2 works unchanged ("so the snow was a guess"). C: unchanged; the
  promise is paid on page 3 (the agent carries out what the model decides) and page 10.
- **Recommended: A**, because it is the one question the whole video answers (live data
  reaches a frozen model through a tool, over MCP), a newcomer can ask it, and "months ago"
  against "now" reads on mute.

### Video 2. Why an MCP gateway?

| | Kicker | On-screen question | Picture at 0 s | Spoken (first line, then at most one sentence) | Pattern |
|---|---|---|---|---|---|
| **A (recommended)** | SYSTEM DESIGN | How does one more box mean 7 fewer connections? | Three agent dots left, five server dots right, 15 lines drawing in by 1 s, counter "15". At about 3 s a violet box drops into the middle, the lines re-route through it, the counter rolls to "8". | "Three AI agents, five servers: fifteen connections to maintain." (9) "Put one box in the middle, and it drops to eight." | Paradox with concrete numbers; show the result first (the KodeKloud 1 GB → 400 MB shape) |
| B | PLATFORM QUESTION | Which agent is flooding this server? | Server node "orders" with a red "slow" chip and a climbing request counter; three agent nodes, each with a "?" and its own small log scroll. | "One server is drowning in calls, and nobody can say who." (11) "Each of three agents keeps its own logs." | Stakes plus a whodunit gap |
| C | SECURITY QUESTION | Where do 15 secret keys live? | Three agent nodes, each holding five key chips; counter "15 keys"; a sixth server appears at 1.5 s and three more keys flicker in. | "Fifteen secret keys, copied across three AI agents." (8) "Add one more server, and all three change again." | Stakes / cost |

- **Page 2.** A: merge the existing pages 2-3 into one: "Each line was an address and a
  credential, a secret proving who asks, kept inside an agent. The box in the middle is an
  MCP gateway." (26 words; the gateway is named by about 20 s.) Page 4 then starts "So Maren,
  Larkfield's platform lead, put one program in the middle"; page 8's "8 connections" becomes
  the callback. B: the answer (one row per call, who asked) arrives on page 9, about 1:35;
  page 2 would have to name the gateway early to pass the 20 s check. C: the keys move into
  the gateway on page 8; page 2 as for A.
- **Recommended: A**, because it has the reference's exact shape: a number that shrinks for a
  reason the viewer cannot yet see, drawn so it reads on mute, and 3 + 5 = 8 is the video's
  idea.

### Video 3. Virtual servers

| | Kicker | On-screen question | Picture at 0 s | Spoken (first line, then at most one sentence) | Pattern |
|---|---|---|---|---|---|
| A | SECURITY QUESTION | Why can the support bot issue refunds? | Chat window "Support bot" with its tool menu; at 1 s the bottom chip `issue_refund` turns red and a "£" stamp lands. | "This support chatbot can send customers refunds." (7) "Nobody chose that; it was handed every tool." | Stakes ("you have this bug") |
| **B (recommended)** | ACCESS QUESTION | It needs 5 tools. Why does it see 12? | Support agent with a 12-chip menu; 5 chips glow green, 7 stay grey; at 1.5 s one grey chip turns red, `issue_refund`, with "£". | "This agent needs five tools, and its menu shows twelve." (10) "One of the extra seven sends refunds." | Concrete numbers plus stakes |
| C | COMMON MISTAKE | Is a hidden tool a blocked tool? | Menu with the refund chip faded to a dashed outline; a dashed arrow sneaks around the menu to the orders server. | "Taking a tool off the menu does not lock it." (10) "Unless the agent's key is limited, it can still reach it." | Myth / common mistake |

- **Page 2.** A and B: the existing page 2 works with its first words changed ("They got
  there because the MCP gateway offered every agent its whole catalogue…"); the virtual server
  that picks five arrives on pages 4-5, about 45-55 s. Priya can ask her question on page 3.
  C: the answer is page 11, about 2:00, which fails the 20 s check; it is better as the hook
  of a later short on credentials.
- **Recommended: B**, because two numbers and one dangerous tool state the problem on mute,
  and "pick five of twelve" is exactly what a virtual server is. It says "see", never "block":
  page 11 explains that a shorter menu is not a lock.

### Video 4. When a tool fails

| | Kicker | On-screen question | Picture at 0 s | Spoken (first line, then at most one sentence) | Pattern |
|---|---|---|---|---|---|
| A | DEBUGGING QUESTION | 200 OK. So why did the tool fail? | Envelope with a green "HTTP 200 OK" chip; under it a reply card whose line `"isError": true` gets a red ring at 1 s. | "The server said 200 OK, and the tool had failed." (10) "The proof was inside the reply." | Paradox (two signals disagree) |
| **B (recommended)** | INTERVIEW QUESTION | Both returned 200 OK. Which one worked? | Two reply cards side by side, each with a green "HTTP 200": left `content: "Leeds, 10 °C, cloudy"`; right `isError: true` · "Weather service timed out". The right card's `isError` line pulses at 1.5 s. | "Both of these tool calls returned 200 OK." (8) "Only one of them worked." | Interview question; spot the difference (a pretest) |
| C | AGENT QUESTION | Every check passed. Why did the AI invent a forecast? | A column of green ticks "HTTP 200"; a chat bubble "Expect heavy snow in Leeds"; a red stamp "NO SNOW" at 1 s. | "Every check passed, and the AI still invented a forecast." (10) "The failure was written in a reply nobody read." | Quiet disaster; callback to video 1 |

- **Page 2.** A and B: bring the existing page 5's point forward: "HTTP 200 only says the
  message arrived and was answered. Whether the tool worked is written in the body, next to
  isError." (22 words.) The Leeds forecast and Tomasz's trace then follow as the worked
  example (the old page-1 story opens page 3), and the old page 5 can be cut or kept as a
  short recap. C: the existing trace page works; the answer lands on pages 4-6, about 40-65 s.
- **Recommended: B**, because any web engineer reads the picture on mute, guessing which call
  worked is a pretest the video answers by page 2, and it stays true to the spec: tool
  execution errors come back as 200 here, without claiming that every error does (the
  2026-07-28 spec changes the status for some protocol errors).

## How to read these tables

- **One board page per row, one idea per page.** A board page is one clean whiteboard with
  3-6 elements (a list of nodes or a terminal counts as one element). Between pages the board
  is erased, with 0.8 s of silence for the wipe. A row marked "same page" keeps the previous
  board and adds to it, only when the picture genuinely builds and stays within 6 elements.
- **ON SCREEN** lists the elements in the order they appear; the word in [square brackets] is
  the cue and appears word for word in VOICE. The voice names what is being drawn while it is
  drawn ("drawn here one by one", "under each name sits ..."), so a page can hold the screen
  for 12-20 s without going quiet.
- **VOICE** is two or three plain sentences, 20-30 words, past tense for the story. Every term
  is defined in the sentence where it first appears, after the viewer has felt the need for it.
  No narrated questions: the hook question is written on the board only. Terms from an earlier
  video are reused with a short reminder, not redefined.
- **NOTE** says what is lab-real (verbatim terminal output from `call_tool.py` against the
  lab's own services, already captured in `learn/short.yaml`) and what is illustrative, with
  the source number from the list at the end. A fact cut from the voice is noted there too.
- **Lengths.** Word counts are for VOICE only. The estimate is words at 170 a minute (the
  Workers AI voice at natural speed), plus 0.8 s of silence at every page break and the
  renderer's 0.3 s lead and 2.5 s tail. The renderer's own beat holds may add a few seconds.

Terms are used exactly as in the brief's glossary: **MCP gateway** (never "tool gateway"),
**MCP server**, **MCP client**, **host**, **tool**, **input schema**, **virtual server**,
**protocol error**, **tool execution error**.

Colours (unchanged from `short.yaml`): agent blue, weather cyan, calculator yellow, gateway
violet, user orange, model white, ok green, bad red, quiet grey. The orders, docs and maps
servers of the Larkfield examples are illustrative actors; give them pink and grey.

The four videos are a mini-course in this order, and each one ends by pointing at the next:
1 what an MCP server, a tool, `tools/list` and `tools/call` are; 2 why and how an MCP gateway;
3 virtual servers and what each agent sees; 4 what a failed tool call looks like.

---

## Video 1. What is MCP?

- **id** `mcp-what-is-mcp` · **idea** an agent asks an MCP server for its menu of tools and
  calls one by name · **running example** the Leeds snow that never fell · **story** Ollie,
  the engineer who built Larkfield's support assistant, finds out why it guessed ·
  **voice** 397 words on 14 pages, about 2:33.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: snow in Leeds | kicker "Agent question"; title "How did the assistant know it was snowing in Leeds?" (both at 0 s); caption "Tuesday 09:00"; [heavy snow] agent node "Support assistant" with bubble "Yes, heavy snow in Leeds."; [No snow] stamp "NO SNOW"; [Ollie] user node "Ollie · built it" | On Tuesday morning, an assistant reported heavy snow in Leeds. No snow fell, and by lunchtime the complaint reached Ollie, the Larkfield engineer who had built it. | Illustrative story (Larkfield and Ollie are our fictional company and engineer). First sentence: 10 words, no name, no term. |
| 2 | The model guessed | erase; [language model] chip "language model · reads text, writes text"; [training] chip "trained months ago"; [guess] stamp "GUESS" on a small copy of the snow bubble | Underneath sat a language model, the part that reads and writes text. It knew only what it had read in training, months earlier, so the snow was a guess. | General fact about training data; brief §7.1 ("the model runs nothing" comes on page 10). |
| 3 | The agent | erase; [agent] node "Agent" drawn around the model chip; [conversation] text "keeps the conversation"; [carries out] text "carries out what the model decides"; [fix] ring on the agent node | Around the model sits the agent, the program that keeps the conversation and carries out what the model decides. Ollie's fix went there, into the agent. | Glossary "agent" (brief §1). |
| 4 | A tool | same page; [tool] chip `get_weather` beside the agent; [another program] dashed box "another program" around the chip; [city] text "city in → weather out" | He gave the agent a tool, a function in another program that the agent can run for the model. This one, get_weather, takes a city and returns today's weather. | `get_weather` is real in the lab (`workspace/tools/weather_tool_server.py`). The application, not the model, runs the tool: source 14. |
| 5 | An MCP server | erase; [MCP server] node "Weather MCP server" holding chips `get_weather`, `get_forecast`; [Model Context Protocol] text "MCP · Model Context Protocol"; [any such program] faint second node "… MCP server" | The program offering get_weather is an MCP server. MCP, the Model Context Protocol, is one shared way to ask any such program for its tools and run them. | Sources 1, 3. A server offers one or more tools (brief §7.4); the lab's weather server offers two. The USB-C analogy is left out of the voice. |
| 6 | The MCP client | same page; [MCP client] box "MCP client" inside the agent; [exactly one] line client → server labelled "MCP"; [host] small label "host" above the agent | Inside the agent, a part called the MCP client holds the connection to exactly one MCP server. The protocol calls the agent itself the host. | Sources 2, 3 (1:1 client-server; host). "Host" is said once in the course, as the brief asks. |
| 7 | Messages: JSON-RPC | erase; [request] card "request" `{"method": "tools/list", "params": {}}`; [result] card "reply" `{"result": …}`; [error] card `{"error": …}` beside it | Client and server exchange JSON documents in a format called JSON-RPC. A request names a method, and the reply carries either a result or an error. Remember that pair. | Sources 1, 13. Video 4 builds on "result or error". Transports (stdio, Streamable HTTP) are left out of the voice; the lab uses Streamable HTTP (source 7, manifest). |
| 8 | The menu: tools/list | erase; packet [tools/list] client → server; [menu] card "menu": `get_weather` · "Get the current made-up weather for a city." / `get_forecast` · "Get a made-up multi-day forecast for a city." | The client asked the server for its menu with tools/list. Back came each tool's name and a description written for the model: Get the current made-up weather for a city. | Real names and descriptions (short.yaml `tlist`). Source 4. The model reads descriptions like a prompt (brief §7.11). |
| 9 | The input schema | same page; [input schema] line under `get_weather`: `city · string · required`; [days] line under `get_forecast`: `days · integer · default 3` | Under each name sits an input schema, the inputs a tool needs and their types. get_weather wants one, city, a string; get_forecast adds days, a whole number, three by default. | Real schemas (short.yaml `tlist`: `city` string required; `days` integer default 3). Source 4. |
| 10 | The model chooses | erase; [question] user bubble "Is it snowing in Leeds?"; [menu] stack of the two tool chips; model chip; [request] chip "call get_weather · city: Leeds"; [ran nothing] text "writes the request, runs nothing" | Then the agent handed the model the question and that menu, and the model answered with a request: call get_weather, city Leeds. It wrote the request; it ran nothing. | Illustrative: the lab has no model; the learner plays the agent's client. Model tool use: source 14; tools are model-controlled: source 4. |
| 11 | The call: tools/call | erase; packet [tools/call] "tools/call · get_weather · {city: Leeds}" client → server; [ran] ring on the server; packet [result] back; card `content: "Leeds, 10 °C, cloudy" · isError: false` | So the client sent tools/call with the tool's name and arguments. The server ran it and replied with a result whose content held the answer: Leeds, ten degrees, cloudy. | Source 4 (`tools/call`, `content`, `isError`). Leeds 10 °C cloudy is the lab's real output (short.yaml `term`). |
| 12 | In the lab | layout split; terminal (real) `python3 -B call_tool.py weather-tools-get-weather '{"city": "Leeds"}'`, show "0-2,5-10"; marks: [tools/call] the method, then the result lines; [toy server] chip "toy server · numbers made up"; [weather-tools] mark on the tool name | In the lab you send this tools/call yourself. A toy server makes the weather up, and the name starts with weather-tools, a prefix the next video explains. | Real terminal output (short.yaml `term`). The weather is invented by the toy server (brief §5). The lab call goes through ContextForge, hence the prefix (brief §6.5). |
| 13 | Recap | layout canvas; erase; four numbered chips: [tools/list] "1 tools/list · the menu", [picked] "2 the model picks", [tools/call] "3 tools/call · run by name", [result] "4 a result" | Focus on what just happened. The client fetched the menu with tools/list, the model picked a tool, the client ran it with tools/call, and the weather returned as a result. | Sources 1, 4. |
| 14 | Call to action | chip "Open the lab · See how tools reach an agent"; [Next] text "Next: one door for many MCP servers" | Open the lab, See how tools reach an agent, and ask for the weather in Leeds yourself. Next, Larkfield wires three agents to four MCP servers. It gets messy. | Pointer to video 2. |

Left out on purpose (one idea per video): resources and prompts, the `initialize`
handshake (removed in the current spec and not visible in the lab), authorization, the two
transports, the USB-C analogy, and "any agent that speaks MCP can use any MCP server" (true,
but a second idea; the lab's call still needs the server's address configured).

---

## Video 2. Why an MCP gateway?

- **id** `mcp-why-a-gateway` · **idea** one proxy in front of many MCP servers gives agents one
  address and the platform team one place for registration, credentials and records ·
  **running example** Larkfield's three agents and their MCP servers, then the lab · **story**
  Maren, the platform lead, cannot tell which agent is flooding the orders server ·
  **voice** 397 words on 14 pages, about 2:33.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: the slow Friday | kicker "Platform question"; title "Three agents, four MCP servers. Who called what?" (at 0 s); caption "Friday 18:40"; [orders server] server node "Orders" with red chip "slow"; [Maren] user node "Maren · platform lead"; [own records] small log icons scattered, one per agent | One Friday evening, the orders server slowed down. Maren, Larkfield's platform lead, asked which agent was flooding it, and nobody knew, because each agent kept its own records. | Illustrative (Larkfield and Maren are fictional). First sentence: 8 words. |
| 2 | The wiring | erase; [three agents] column of agent nodes "Support", "Billing", "Ops" on the left; [four MCP servers] column "Weather", "Calculator", "Orders", "Docs" on the right; [Twelve] 12 lines draw one by one, counter "12 connections" | Larkfield ran three agents, Support, Billing and Ops, each wired straight to four MCP servers: weather, a calculator, orders and docs. Twelve connections, drawn here one by one. | Illustrative; weather and calculator mirror the lab's two servers. 3 × 4 = 12. |
| 3 | What each line costs | erase; the same two columns, compact; [credential] key chip on each agent "×4"; [fifth server] node "Maps" joins the right column, three dashed lines; [fifteen] counter "15 connections" | Each line meant an address and a credential, a secret proving who is asking, kept inside that agent. When a fifth server arrived, every agent changed, and the count hit fifteen. | Illustrative; the fifth server is maps (label only). 3 × 5 = 15. "Credential" is defined here and reused in videos 3 and 4. |
| 4 | An MCP gateway | erase; [MCP gateway] violet node "MCP gateway" in the centre, agents left, servers right; [proxy] text "proxy: receives each call, passes it on"; packet [passes] rides agent → gateway → server | So Maren put one program in the middle: an MCP gateway. A gateway is a proxy, a program that receives each call and passes it on. | Definition synthesised from sources 15-21 (brief §3.1). |
| 5 | Two faces | same page; [single MCP server] label on the agents' side "looks like one MCP server"; [MCP client] label on the servers' side "acts as an MCP client" | To the agents, the gateway looks like a single MCP server. To the real servers it acts as their MCP client, the role each agent played before. | ContextForge "runs as a fully compliant MCP server" (15); it reaches the real servers with the `mcp` SDK's own client (`ClientSession`, `streamablehttp_client`; brief §10 A19). |
| 6 | Registration | erase; [operator] user icon with card "name + URL" → gateway; [did nothing] grey text "unchanged" on each server; packets [tools/list] gateway → each of the five servers | An operator then registered each server with the gateway once, by name and address; the server did nothing. The gateway connected and fetched each menu with tools/list. | Registration is the operator's act, not the server's (brief §1, §6.2); in the lab `seed_contextforge.py` does it. Sources 15, 22. |
| 7 | The catalogue | same page; [catalogue] list inside the gateway titled "catalogue"; [one reply] packet gateway → an agent "tools/list reply: every tool" | The five menus landed in one list inside the gateway, its catalogue. One tools/list to the gateway now returned every tool from every server, in one reply. | Sources 15, 16, 17. ContextForge's separate "MCP Registry" panel is not this catalogue (brief §1). |
| 8 | One address, one credential | erase; [one address] chip "mcp.larkfield.internal" on the gateway; three lines agents → gateway, five lines gateway → servers; [its own] one badge chip per agent; [moved] key chips glide from the agents into the gateway; [eight] counter "8 connections" | So each agent kept one address, the gateway's, and one credential, its own; the servers' secrets moved into the gateway. Three agents plus five servers made eight connections instead of fifteen. | Illustrative address. 3 + 5 = 8. Single endpoint: sources 15, 16, 17. Credential injection: 16, 17; ContextForge stores them encrypted (22). Cut from the voice: "token passthrough is forbidden" (10, 11) and "a sixth server changes nothing on the agents". The lab has no upstream credentials. |
| 9 | One place to watch | erase; [row] card "gateway log (illustration)" `18:41 · Ops · orders-get-order · ok · 2400 ms`; rings in turn on [tool], [time], [how long], [worked]; [who asked] ring on "Ops" | Every call passed through one place, so the gateway wrote a row for each: tool, time, how long it took, whether it worked and, from the credential, who asked. | Logging: sources 16, 17, 19, 22. The lab log has no caller column (brief §5). Rate limiting cut from the voice (ContextForge default: on, 100 requests a minute plus a burst of 20 on MCP paths, per IP and per user; the lab turns it off; brief §10 A16). |
| 10 | What it is not | erase; chip "runs the tools" with a cross at [no tools]; chip "chooses the tools" with a cross at [chooses none]; [AI gateway] chip "AI gateway → language models" | The gateway runs no tools and chooses none; the servers do the work, and the model chooses. An AI gateway is a different thing: it carries calls to language models. | Brief §3.3. "Adds a hop, makes nothing faster" (brief §7.12) cut from the voice. |
| 11 | In the lab | layout split; [ContextForge] gateway node relabelled "ContextForge"; terminal (real) `python3 -B call_tool.py --list`, show "0,5-10", clip 50; marks [its address] the url, [five tools] the names | In the lab the MCP gateway is ContextForge, IBM's open-source gateway, with two toy MCP servers registered. One tools/list to its address returned five tools from both. | Real terminal output (short.yaml `tlist`). Source 15. |
| 12 | The record in the lab | terminal (real) `python3 -B call_tool.py calculator-tools-add '{"a": 17, "b": 25}'`; mark [forty-two] `42.0`; [view tab] chip "view tab: tool · time · success · response time"; [no caller] text "no caller column" | Then add with seventeen and twenty-five returned forty-two, and the view tab showed it as a new row: tool, time, success, response time. There is no caller column. | Real output (short.yaml `tadd`); view columns from `workspace/view_service.py` (ContextForge's `tool_metrics`). Every scripted lab call is the same admin identity (manifest `X-Authenticated-User`). The row appears when ContextForge flushes its metrics buffer, up to 60 s after the call, stamped with the call time; record the take after that (brief §10 A7). |
| 13 | Recap | layout canvas; erase; four chips [registered once], [one address], [credentials], [one place]; [Maren] the log card returns with three "Ops" rows | Focus on what changed. Servers were registered once, agents learned one address, credentials stayed in the gateway, and every call left a row in one place, where Maren found her answer. | The payoff of the hook (illustrative): one table instead of three agents' logs. |
| 14 | Call to action | chip "Open the lab · See how tools reach an agent"; [Next] text "Next: should every agent see every tool?" | Open the lab, See how tools reach an agent, and find your own calls in the view tab. Next, a refund tool shows up on Support's menu. | Pointer to video 3. |

---

## Video 3. Virtual servers: the right tools for each agent

- **id** `mcp-virtual-servers` · **idea** a virtual server is a named bundle of tools at its
  own MCP address, so each agent is offered only what it needs · **running example** Support's
  and Billing's bundles at Larkfield, then `toy-tools` in the lab · **story** Priya finds a
  refund tool on the support assistant's menu · **voice** 396 words on 14 pages, about 2:32.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: the refund tool | kicker "Access question"; title "Should the support assistant see the refund tool?" (at 0 s); caption "May"; [support assistant] agent node with a menu list, red chip `issue_refund` at the bottom; [Priya] user node "Priya · head of Support"; [Maren] user node "Maren" | In May, the support assistant's menu listed a refund tool. Priya, who runs Support at Larkfield, spotted it and asked Maren how it got there. | Illustrative (no orders server in the lab). First sentence: 10 words. |
| 2 | Everyone sees everything | erase; [whole catalogue] gateway node with list "catalogue · 12 tools" fanned out to three agents; [issue_refund] ring on the red chip; [real money] stamp "£" | It got there because the MCP gateway offered every agent its whole catalogue, all twelve tools, and one of them, issue_refund, moved real money. | Illustrative count: 5 lab-like tools plus 7 on the orders, docs and maps servers of video 2. `issue_refund` belongs to the orders server (label only). |
| 3 | One wrong choice away | erase; model chip beside the support agent; [menu] the 12-chip menu; [wrong choice] dashed arrow model → `issue_refund`; [weather tools and the calculator] ring on those five chips | The model picks from whatever menu it is given, so a refund was one wrong choice away. Support only ever needed the weather tools and the calculator. | Tools are model-controlled: source 4. |
| 4 | A virtual server | erase; [catalogue] grey column of 12 tools; [virtual server] empty box "support-tools"; [own MCP address] chip `/servers/<id>/mcp` under the box; [ordinary MCP server] arrow agent → box labelled "looks like one MCP server" | The cure is a virtual server: a named bundle of tools picked from the catalogue, at its own MCP address. To an agent it is an ordinary MCP server. | ContextForge definition and endpoint: sources 15, 22; endpoint confirmed live in 1.0.10. Keep `<id>` as a placeholder: the id is a fresh uuid on every install (brief §10 A11, A18). Brief §7.9: a selection plus an address. |
| 5 | Support's bundle | same page; [five tools] chips `get_weather`, `get_forecast`, `add`, `subtract`, `multiply` glide into the box; [stayed out] stamp "left out" on `issue_refund` | Maren made one, support-tools, and picked five tools into it: get_weather and get_forecast from the weather server, and add, subtract and multiply from the calculator. issue_refund stayed out. | The five tools match the lab; leaving one out is illustrative (the lab's `toy-tools` holds all five). |
| 6 | Billing's bundle | erase; [billing-tools] second box with `add`, `issue_refund`; [both] one line from the catalogue's `add` to both boxes; [copying nothing] text "points at tools · copies nothing · runs nothing" | Billing got its own virtual server, billing-tools, which did include issue_refund. The tool add sits in both, because a virtual server only points at tools, copying nothing and running nothing. | Many-to-many `server_tool_association` in ContextForge, composite key `(server_id, tool_id)` (22; brief §10 A10). Schema evidence; the lab's single virtual server does not show it. |
| 7 | Two tools called search | erase; [docs server] node "Docs" with chip `search`; [orders server] node "Orders" with chip `search`; [Two identical names] both chips slide into one menu with "?" | A second problem appeared when the docs server and the orders server both offered a tool called search. Two identical names on one menu would leave the model guessing. | Illustrative pair; the spec says aggregators MAY meet collisions and SHOULD prefix (4). |
| 8 | Prefixes | same page; [in front] the chips become `docs-search`, `orders-search`; [weather-tools-get-weather] arrow `get_weather` → `weather-tools-get-weather` | So the gateway puts the registered server's name in front of each tool. search became docs-search and orders-search, and in the lab get_weather became weather-tools-get-weather. | ContextForge ADR-0011 (23): slug + separator + original name, confirmed in the 1.0.10 source (separator default `-`; brief §10 A8). The lab name is real output. The prefix is the operator's registration name, not the server's choice (brief §8). |
| 9 | What the agent sees | erase; two columns; [sees] left column "agent sees": "one address", "names", "descriptions", "input schemas"; [Only the gateway] right column "gateway knows": "owner server", "original name get_weather", "server address", "credentials" | From its virtual server, the agent sees one address and the tools' names, descriptions and input schemas. Only the gateway knows each tool's owner, original name, server address and credentials. | ContextForge keeps `original_name` and the gateway slug (23). Servers cannot see into each other (source 2). |
| 10 | Routing one call | same page; packet [called] agent → gateway "weather-tools-get-weather · Leeds"; [looked up] ring on the right column; packet [passed] gateway → weather server "get_weather · Leeds" | When Support called weather-tools-get-weather, the gateway looked up the owner, restored the original name get_weather, and passed the call to the weather server. The agent never saw where it went. | Source 23 (invocation uses `original_name`). Not spoken: inside a virtual server ContextForge 1.0.10 also accepts the bare original name (`add` worked live; brief §10 A9). |
| 11 | A menu is not a lock | erase; support agent; [credential] badge "credential: support-tools only"; [directly] dashed arrow from the agent straight to the orders server with a red cross | Leaving a tool out only shortens a menu. It is a lock only if the agent's credential is limited to that virtual server and the agent cannot reach the servers directly. | ContextForge server-scoped tokens (24). Brief §3.3, §7.10. Lab evidence for the voice: the lab's own ContextForge also lists every tool at `/mcp` and answers calls that carry no identity at all (`AUTH_REQUIRED=false`), so a tool left out of `toy-tools` would still be reachable there (brief §10 A11, A17, S4). |
| 12 | In the lab | layout split; terminal (real) `python3 -B call_tool.py --list`, show "0,5-10"; marks [toy-tools] the "virtual server 'toy-tools'" line, [prefix] the five names; [same admin] text "every call: admin@example.com" | In the lab the virtual server toy-tools holds all five tools of both toy servers, each with its prefix. Nothing is left out, and every call uses the same admin identity. | Real output (short.yaml `tlist`); trusted-proxy header in manifest (brief §2.9). "Every call" means every call the lab's scripts make; ContextForge would also accept a header-less call as an anonymous, public-only caller, and all five tools are public (brief §10 A17). The view tab lists servers, tools and the virtual server (`view_service.py`). |
| 13 | Recap | layout canvas; erase; four chips [catalogue], [picked a few], [prefixes], [details] | Focus on what just happened. The catalogue held every tool, each virtual server picked a few, prefixes kept names apart, and the gateway kept the details agents never saw. | |
| 14 | Call to action | chip "Open the lab · See how tools reach an agent"; [next video] text "Next: 200 OK, and still wrong" | Open the lab, See how tools reach an agent, and count the tools toy-tools offers. The next video follows a call that returned 200 OK and went wrong. | The count is the lab's first question (`learn/questions.yaml`). Pointer to video 4. |

---

## Video 4. When a tool fails

- **id** `mcp-when-a-tool-fails` · **idea** HTTP 200 only says the message arrived; MCP reports
  failure in the body, as a protocol error or as a tool execution error, and the agent must
  read it · **running example** the Leeds forecast that came back with `isError`, then the
  lab's `does-not-exist` call · **story** Tomasz traces why the assistant promised snow again ·
  **voice** 397 words on 14 pages, about 2:33.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: 200 and wrong | kicker "Debugging question"; title "The call returned 200 OK. Why was the forecast wrong?" (at 0 s); [200 OK] green chip "HTTP 200 OK"; caption "Thursday 08:00"; [heavy snow] agent bubble "Expect heavy snow in Leeds."; [Again] stamp "NO SNOW" | The call returned 200 OK, and the forecast was wrong. At eight on Thursday, Larkfield's assistant told a customer to expect heavy snow in Leeds. Again, no snow fell. | Illustrative story; callback to video 1. First sentence: 10 words. |
| 2 | Follow the call | erase; [Tomasz] user node "Tomasz · staff engineer"; chain: agent → [MCP gateway] → [weather MCP server]; packet `get_forecast · Leeds` along each link | Tomasz, the staff engineer, pulled the trace. The assistant had called get_forecast for Leeds through the MCP gateway, which passed it to the weather MCP server. | Illustrative: the lab has no trace view beyond the view tab. Gateway as proxy: video 2. |
| 3 | The far end | same page; [outside weather service] cloud node after the server; [did not answer] clock icon and red chip "timed out" on the cloud | That server asked an outside weather service for its data, and the service did not answer in time. The chain had broken at its far end. | Illustrative: the lab's weather server calls no outside service and never times out. |
| 4 | The reply: a tool execution error | erase; card "the reply" (simplified) `"result": {"isError": true, "content": text "Weather service timed out"}`; marks [isError] and [short text]; [tool execution error] label under the card | The weather server did not crash. It sent a normal result with isError true and a short text: weather service timed out. The specification calls this a tool execution error. | Shape: source 5 (API failures are tool execution errors). The message text is illustrative. |
| 5 | Status and body | erase; [delivered and answered] envelope icon with chip "HTTP 200"; [body] the reply card again, smaller, ring on `isError` | HTTP only reported that the request was delivered and answered, so its status was 200. Whether the tool had worked was written in the body, next to isError. | Lab-real pattern (`does-not-exist` returns 200 with `isError`). Under the 2026-07-28 spec some protocol errors change the HTTP status (source 8), so the rule taught is "200 is not proof", never "errors are always 200". |
| 6 | What went wrong | erase; card "assistant code (illustration)" `if status == 200: use it`; [threw the message away] message chip drops off the board; model chip; [guess] stamp "GUESS" | The assistant's code checked the status, saw 200, and threw the message away. So the model got no forecast and filled the gap as in the first video: with a guess. | Illustrative. The spec says clients SHOULD pass tool execution errors to the model (5). |
| 7 | The other kind: a protocol error | erase; card "request" `"method": "tools/calll"`; [error object] card `"error": {"code": -32601, "message": "Method not found: tools/calll"}`; [no result] text "no result"; [protocol error] label; small unspoken text "2026-07-28 spec: some protocol errors also get 400/404" | The second kind is the protocol error: the server could not handle the request itself, say a misspelt method name. The reply holds an error object, code and message, and no result. | JSON-RPC code `-32601` (13). Lab-real: ContextForge 1.0.10 answers `tools/calll` on `/servers/<id>/mcp` with HTTP 200 and exactly this error object, no result (captured 2026-10-25; brief §10 A2). `call_tool.py` cannot send a custom method, so it is not a learner step. Under 2026-07-28 the status would be 404 (8). |
| 8 | Which is which | erase; two columns. Left "protocol error · error object": [unknown tool], [malformed request], "server error". Right "tool execution error · isError": [failed API], [bad input], [business rule]; [correct itself] text under the right column "written for the model" | The specification sorts them: unknown tool and malformed request are protocol errors. A failed API, a bad input or a business rule are tool execution errors, written for the model to correct itself. | Source 5 (2026-07-28; input validation moved to tool execution errors in 2025-11-25), re-checked 2026-10-25: both lists unchanged in 2026-07-28 (brief §10 B1). Lab: `calculator-tools-add` with `"a": "x"` returns `isError: true` (brief §10 A4). "Server error" is on the board but not spoken. |
| 9 | In the lab | layout split; terminal (real) `python3 -B call_tool.py does-not-exist '{}'`, show "1-4"; marks [HTTP 200] `HTTP 200`, [isError] `"isError": true`, [Tool not found] `Tool not found: does-not-exist` | In the lab, a call to a tool named does-not-exist came back with HTTP 200, isError set to true, and the text: Tool not found. | Real output (short.yaml `terr`), re-captured 2026-10-25 unchanged; graded by `answers-match-the-gateway`. This call adds no row to the view tab (brief §10 A5). |
| 10 | Lab versus specification | two chips beside the terminal: [specification] "spec: unknown tool → protocol error"; [ContextForge] "ContextForge 1.0.10 → isError result"; [MCP Python SDK] text "MCP Python SDK: any failure in a tool → isError"; [depends on the server] chip "read the body" | The specification files an unknown tool under protocol errors. ContextForge reports a tool error, because the MCP Python SDK beneath it turns any failure in a tool into one. The shape depends on the server. | Sources 5, 25, 26 (brief §2.6), confirmed with the lab's pinned SDK, `mcp` 1.30.0 (brief §10 A1). Kept so a careful viewer does not learn the wrong rule from the lab. |
| 11 | A careful agent: the error object | layout canvas; erase; tree from a "reply" node; [error object] branch → "agent's code: fix the request"; [fetching the menu again] chip `tools/list` | So a careful agent reads the body. On an error object, its own code steps in, say by fetching the menu again. | Protocol errors are for code, not the model (source 5: "less likely to result in successful recovery"). "Fetch the menu again" is our advice, not a spec rule. |
| 12 | A careful agent: isError | same page; [isError] branch → "model reads the text" → three leaves [fix an input], [retry once], [admit]; bubble "Sorry, I have no forecast for Leeds right now." | On isError it hands the text to the model, which can fix an input, retry once, or admit it has no forecast. | Source 5 ("Clients SHOULD provide tool execution errors to language models"). "Retry once" is our advice. |
| 13 | Recap | erase; three chips [status], [body], [told the truth] | Focus on what just happened. The status said the message arrived, the body said whether the tool worked, and the agent that read it told the truth instead of guessing. | |
| 14 | Call to action | chip "Open the lab · See how tools reach an agent"; [four videos] four small chips "server · gateway · virtual server · failure" | Open the lab, See how tools reach an agent, and call a tool that does not exist. That closes the four videos: server, gateway, virtual server, failed call. | Last video of the set; no pointer. |

---

## Read-aloud check (done)

- No VOICE cell is a narrated question; hook questions are board titles only.
- First spoken sentences, each under 12 words with no name and no term: V1 "On Tuesday
  morning, an assistant reported heavy snow in Leeds." (10), V2 "One Friday evening, the
  orders server slowed down." (8), V3 "In May, the support assistant's menu listed a refund
  tool." (10), V4 "The call returned 200 OK, and the forecast was wrong." (10).
- Terms defined at first use, after the need for them is shown: language model (V1 #2), agent
  (V1 #3), tool (V1 #4), MCP server and MCP (V1 #5), MCP client and host (V1 #6), JSON-RPC
  (V1 #7), tools/list and menu (V1 #8), input schema (V1 #9), tools/call and result (V1 #11),
  credential (V2 #3), MCP gateway and proxy (V2 #4), register (V2 #6), catalogue (V2 #7),
  AI gateway (V2 #10), virtual server (V3 #4), prefix (V3 #8), tool execution error (V4 #4),
  protocol error and error object (V4 #7). Videos 2-4 reuse earlier terms with a reminder in
  passing ("the role each agent played before").
- Every VOICE cell is 22-35 words and two or three sentences. The longest is V4 #10 (35), kept
  on purpose; the shortest are the two halves of the split "careful agent" page (V4 #11-12).
- Every [cue] in ON SCREEN appears word for word in its VOICE cell (checked by script, case
  and punctuation ignored).
- No jokes, no "okay/so, here's the thing", no narrator "I", no lists of three for rhythm:
  the only three-item lists are real sets (three agents, three calculator tools, the spec's
  own error categories). Past tense for the Larkfield stories; present tense for definitions,
  the lab and the call to action.
- "Tool gateway" appears in no VOICE or ON SCREEN cell.
- Arithmetic: 3 × 4 = 12 and 3 × 5 = 15 direct connections; 3 + 5 = 8 through the gateway;
  five lab tools (2 weather + 3 calculator); 17 + 25 = 42.0; Leeds → 10 °C cloudy; `days`
  defaults to 3.

## Owner review summary

One line per board page: the one thing the page teaches.

**Video 1. What is MCP?**
1. Hook: snow in Leeds — an assistant confidently reported weather it could not know.
2. The model guessed — a language model only knows its training text, so it guessed.
3. The agent — the agent is the program around the model, and the fix goes there.
4. A tool — a tool is a function in another program the agent can run for the model.
5. An MCP server — the program offering tools is an MCP server; MCP is the shared way to ask it.
6. The MCP client — one client inside the agent holds the connection to exactly one server; the agent is the host.
7. Messages: JSON-RPC — a request names a method; the reply is a result or an error.
8. The menu: tools/list — tools/list returns names and descriptions written for the model.
9. The input schema — each tool says which inputs it needs and their types.
10. The model chooses — the model writes the request and runs nothing.
11. The call: tools/call — tools/call runs a tool by name and returns a result with content.
12. In the lab — you send the same tools/call; the weather is a toy's, the name has a prefix.
13. Recap — list, pick, call, result.
14. Call to action — open the lab; next, too many wires.

**Video 2. Why an MCP gateway?**
1. Hook: the slow Friday — nobody can say which agent is calling a server, because records live in each agent.
2. The wiring — three agents times four servers is twelve connections.
3. What each line costs — every line is an address plus a credential; a fifth server makes fifteen.
4. An MCP gateway — one proxy in the middle of every call.
5. Two faces — it looks like one MCP server to agents and acts as an MCP client to servers.
6. Registration — an operator registers each server once; the gateway fetches its menu.
7. The catalogue — all menus in one list; one tools/list returns everything.
8. One address, one credential — three plus five is eight connections; server secrets live in the gateway.
9. One place to watch — one row per call: tool, time, duration, success, who.
10. What it is not — it runs no tools, chooses none, and is not an AI gateway.
11. In the lab — ContextForge, two toy servers, five tools from one tools/list.
12. The record in the lab — the view tab's row for the 42.0 call, with no caller column.
13. Recap — registered once, one address, credentials, one place; Maren's answer was in that table.
14. Call to action — find your own calls; next, who should see what.

**Video 3. Virtual servers**
1. Hook: the refund tool — a dangerous tool is on the wrong menu.
2. Everyone sees everything — the gateway offered its whole catalogue to every agent.
3. One wrong choice away — the model picks from any menu it is given.
4. A virtual server — a named bundle of catalogue tools at its own MCP address.
5. Support's bundle — five tools in, the refund tool out.
6. Billing's bundle — one tool can be in several bundles; a bundle copies and runs nothing.
7. Two tools called search — identical names on one menu need telling apart.
8. Prefixes — the registered server's name goes in front of each tool.
9. What the agent sees — the agent sees names and schemas; the gateway keeps owner, original name, address, credentials.
10. Routing one call — the gateway restores the original name and forwards the call.
11. A menu is not a lock — leaving a tool out is only a control with scoped credentials and no direct route.
12. In the lab — toy-tools holds all five tools; nothing is left out; one admin identity.
13. Recap — catalogue, a few per bundle, prefixes, hidden details.
14. Call to action — count the tools; next, a call that returned 200 and was wrong.

**Video 4. When a tool fails**
1. Hook: 200 and wrong — a successful-looking call produced a false forecast, again.
2. Follow the call — agent, gateway, weather server.
3. The far end — the outside service timed out.
4. The reply: a tool execution error — a normal result with isError true and a text message.
5. Status and body — HTTP 200 means delivered and answered; the body says whether the tool worked.
6. What went wrong — the code checked the status, dropped the body, and the model guessed.
7. The other kind: a protocol error — an error object with a code and message, and no result.
8. Which is which — the spec's two lists.
9. In the lab — does-not-exist returns 200, isError true, Tool not found.
10. Lab versus specification — the spec calls an unknown tool a protocol error; ContextForge's SDK makes it a tool error.
11. A careful agent: the error object — code fixes the request.
12. A careful agent: isError — the model reads the text and fixes, retries or admits.
13. Recap — status, body, truth.
14. Call to action — call a tool that does not exist; the set is complete.

## Change log

Against the previous draft (commit 75f4ae5). The research facts and sources are unchanged;
the edits are to pacing, order and wording.

**Across all four videos**
- Rewrote every VOICE cell to one idea in 20-30 words (the old pages carried 35-45 words and
  two or three new terms). Split the dense pages and dropped most "same page" piling: a row now
  adds to the board only when the picture genuinely builds (agent → tool, server → client,
  gateway → its two faces, menu → schema, error-object branch → isError branch).
- Gave each video a single thread with a named person from the Larkfield cast (Ollie, Maren,
  Priya, Tomasz) and a time, and joined pages with a cause or a time ("No snow fell, and by
  lunchtime...", "So Maren put one program in the middle", "A second problem appeared when").
  The hook is answered inside the video (Maren finds her answer in one table; Tomasz finds the
  dropped message).
- Every video now ends by pointing at the next one's question; video 4 closes the set.
- Removed the rhythm triplets and compressed sentence stacks; added the plain pause line
  "Remember that pair." where a page turns, and kept "Focus on what just happened" for recaps.
- Header word counts and lengths recomputed (170 words a minute, 0.8 s per page break, lead
  and tail); the "How to read" section now states the 20-30 word rule.

**Video 1**
- Cut from the voice: the transports (stdio, Streamable HTTP; now NOTE only), the USB-C
  analogy, "any agent that speaks MCP can use any MCP server", and the customer detail on the
  hook page (replaced by the "no snow fell" turn, which is what makes Ollie look).
- Split "agent and tool" into two pages and "MCP server and MCP client" into two pages; split
  the menu into "names and descriptions" and "input schema" (the schema now uses the lab's
  real `days` default of 3).
- JSON-RPC kept as its own page because video 4 depends on "result or error".

**Video 2**
- Merged the old pages 2-3 (twelve connections, credentials, the Friday note, the fifth
  server) into two pages, and moved "each agent kept its own records" into the hook so the
  problem is clear before the count grows.
- Split the gateway definition into "a proxy" and "its two faces".
- Merged "one address" and "credentials" into one page: each agent keeps one address and one
  credential, the servers' secrets move into the gateway.
- Cut from the voice: the rate limit (ContextForge's default 100 calls a minute), "token
  passthrough is forbidden", "it adds a hop", and "a sixth server changes nothing on the
  agents". All stay in NOTE for the concept page.
- The hook's payoff (Maren reads the answer from one table) is spoken in the recap rather than
  on its own page, to stay inside the word budget.

**Video 3**
- Split "prefixes" into the problem (two tools called search) and the cure.
- Renamed page 9 "A bundle is a menu" to "A menu is not a lock", the one claim a newcomer gets
  wrong, and reworded it in plain terms (credential limited to that virtual server; no direct
  reach to the servers).
- The lab page now says out loud that every lab call is the same admin identity (previously
  NOTE only), so the honesty about enforcement is spoken.
- Cut the view-tab sentence ("lists the registered servers, the discovered tools and the
  virtual server on one page") and "on the orders server" to NOTE.

**Video 4**
- Split "follow the call" into the chain and the far-end timeout, and "what a careful agent
  does" into the error-object branch and the isError branch.
- Made the hook a callback to video 1 ("Again, no snow fell") so the guess has a history.
- "Server error" is shown in the protocol-error column but no longer spoken.
- The "status and body" NOTE now carries the 2026-07-28 nuance (some protocol errors change the
  HTTP status); the voice teaches only "200 is not proof". The protocol-error page shows that
  nuance as unspoken small text.
- Kept the lab-versus-specification page, with the SDK named in the same sentence.

**Moved to UNVERIFIED (NOTE only, not spoken)**
- What HTTP status and body ContextForge 1.0.10 returns for a misspelt method name
  (`tools/calll`); the `-32601` example is marked as an illustration (V4 #7).
- No new factual claim was added. The Larkfield rows (Ops making the calls, the 2400 ms row,
  twelve catalogue tools, two `search` tools) are marked illustrative in NOTE.

**For the owner to decide**
- V2 #8 carries two related facts (one address per agent, one credential per agent) on one
  page to keep the video under 400 words; the alternative is a 15th page and about 2:40.
- V2 cuts the rate limit and the token-passthrough rule from the voice; both are real gateway
  functions in the brief. If one must be spoken, V2 #8 is the page to extend.
- V4 #10 (lab versus specification) is the densest page in the set (35 words). It is kept
  because without it a careful viewer learns the wrong rule from the lab.
- The videos run about 2:33 at 170 words a minute; if the voice lands nearer 160, each is
  about 2:40. Trimming to 2:30 exactly would mean cutting one page per video, most easily the
  "what it is not" page in V2 and the "Billing's bundle" page in V3.

**Verification pass, 2026-10-25** (brief §10: ContextForge 1.0.10 source and a live run of
the lab, the 2026-07-28 spec pages, vendor pages, OWASP). No VOICE cell and no [cue] changed;
no claim in the voice turned out wrong.
- V4 #7: ON SCREEN error card now shows the lab's real message, `"Method not found:
  tools/calll"`; NOTE changed from UNVERIFIED illustration to lab-real (HTTP 200, `-32601`, no
  result). This resolves the item in "Moved to UNVERIFIED" above.
- V4 #8: NOTE records that the 2026-07-28 tools page still files unknown tool as a protocol
  error and input validation as a tool execution error, and adds the lab's real invalid-input
  `isError` result.
- V4 #9: NOTE records the re-capture and that this call adds no view-tab row.
- V4 #10: NOTE names the lab's pinned SDK, `mcp` 1.30.0.
- V2 #5: NOTE now cites the source showing ContextForge uses the `mcp` SDK client upstream.
- V2 #9: NOTE gives ContextForge's real default rate limit (on; 100 a minute plus burst 20,
  per IP and per user) instead of `tool_rate_limit`.
- V2 #12: NOTE warns that the view-tab row appears only after the metrics buffer flushes (up
  to 60 s); "every lab call" narrowed to "every scripted lab call".
- V3 #4: NOTE says the endpoint is confirmed live and the id changes on every install.
- V3 #6: NOTE adds the schema evidence (composite key) and that the lab does not show it.
- V3 #8: NOTE says the prefix rule is confirmed in the 1.0.10 source, separator default `-`.
- V3 #10: NOTE adds (unspoken) that ContextForge also accepts the bare original name inside a
  virtual server.
- V3 #11: NOTE adds lab evidence for "a menu is not a lock": the lab's ContextForge lists every
  tool at `/mcp` and answers calls carrying no identity.
- V3 #12: NOTE says "every call" means every scripted call; a header-less call is accepted as
  anonymous, public-only.
- Sources 15, 20, 22, 25, 26: endpoint confirmed live; agentgateway quote replaced by its own
  page's wording; rate-limit setting name; line numbers; SDK 1.30.0.

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
    tools"; `/servers/<id>/mcp` (confirmed live, brief §10 A11). https://github.com/IBM/mcp-context-forge (README at tag
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
20. agentgateway: "MCP authorization controls which tools, prompts, and resources a client can
    reach". https://agentgateway.dev/ ,
    https://agentgateway.dev/docs/standalone/latest/documentation/mcp/mcp-authz/
21. Azure API Management exposes REST APIs as MCP servers.
    https://learn.microsoft.com/azure/api-management/mcp-server-overview
22. ContextForge 1.0.10 source: `/v1/gateways` registration, admin UI "MCP Servers" /
    "Virtual Servers", `server_tool_association`, `rate_limit_medium_rpm = 100` (formerly `tool_rate_limit`),
    `AUTH_ENCRYPTION_SECRET` "Encryption key for stored credentials", `tool_metrics` columns.
    https://github.com/IBM/mcp-context-forge/tree/v1.0.10 (`mcpgateway/config.py`,
    `mcpgateway/db.py`, `mcpgateway/templates/admin.html`)
23. Tool name = gateway slug + separator + original name; `original_name` used for the call.
    https://ibm.github.io/mcp-context-forge/architecture/adr/011-tool-federation/
24. Server-scoped tokens "restricted to specific MCP servers". ContextForge
    `docs/docs/manage/securing.md` at v1.0.10,
    https://ibm.github.io/mcp-context-forge/manage/securing/
25. ContextForge's Streamable HTTP `call_tool` re-raises tool lookup failures for the MCP SDK
    to convert. `mcpgateway/transports/streamablehttp_transport.py:2132-2136` at
    https://github.com/IBM/mcp-context-forge/tree/v1.0.10
26. MCP Python SDK 1.28.1, and 1.30.0 (the lab's pin), turn an exception in a tool handler into
    an `isError` result (`_make_error_result(str(e))` in `mcp/server/lowlevel/server.py`, lines
    589-590 in 1.30.0). https://pypi.org/project/mcp/1.30.0/
27. Lab facts (Leeds 10 °C cloudy, five tools, 42.0, `does-not-exist` → 200 + `isError`, view
    tab columns): `labs/see-how-tools-reach-an-agent/` (`workspace/`, `learn/short.yaml`
    terminal output, `checks/_harness.py`, `solution/answers.json`).
