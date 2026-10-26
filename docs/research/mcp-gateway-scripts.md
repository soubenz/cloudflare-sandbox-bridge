# Proposed scripts: four MCP explainers

For `labs/see-how-tools-reach-an-agent`. Built on the research brief
[mcp-gateway.md](mcp-gateway.md); every factual line traces to a source listed at the end.
Format and writing rules: `docs/shorts.md` and `docs/video-prompt.md`.

## Hook options

**Decision, 2026-10-26.** The owner rejected the first round of these options (and
[hook-options-2.md](hook-options-2.md)) as vague riddles about abstractions, and set the
rule now in [hooks.md §7](hooks.md#7-hook-checklist-apply-to-every-video): name the topic
plainly (MCP is the word people search for), anchor on a real thing the viewer knows (ChatGPT,
a real number, a line of code they have written, an interview question), and put a plain
question on the board at 0 s that someone would actually type into a search box; no riddles,
no "a box" or "a program", no names or company set-up before the problem. The picks, written
into the tables below:

- **Video 1: A**, reworded. Board: "ChatGPT was trained months ago. How does it know today's
  weather?" Page 2 answers honestly within 20 s (the model cannot know; the app around it
  calls a tool; MCP is the standard way to plug tools in), without claiming ChatGPT uses MCP.
- **Video 2: A and B.** A is page 1 of the main cut, with B's kicker and question above the
  numbers; B is written in full under "Hook variants" after the table, for an A/B cut.
  The video zooms from 10 × 20 to a slice of 3 × 5 on page 2, so the fifteen-to-eight pages
  still work.
- **Video 3: B.** Board: "How do you give each AI agent only the tools it needs?" Page 2
  names the virtual server by 20 s (the gateway's catalogue already holds every tool; a
  virtual server is a named pick of them at its own address); the refund story (Priya,
  `issue_refund`) follows as the worked example.
- **Video 4: A**, as a code card: `if resp.status == 200: return resp.result`. Page 2 pays it
  off by 20 s; the Tomas story follows as the worked example.

The three-per-video tables below are the record of the first round. Every option in them
kept names and terms out of the first line; the owner's rule replaces that with "name the
topic, anchor on something real". The "Page 2" lines say what the existing page 2 would need
so the first piece of the answer lands within about 20 s.

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
  isError." (22 words.) The Leeds forecast and Tomas's trace then follow as the worked
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
  The hook question may be spoken once, on page 1 (hooks.md §7, check 6); no other narrated
  questions. Terms from an earlier video are reused with a short reminder, not redefined.
- **Page 1 names the topic.** The owner's rule (hooks.md §7): the board carries the video's
  topic in plain words at 0 s (a small caption such as "What is MCP?"), the title is a question
  a viewer would type into a search box, and the picture is a real thing the viewer knows (a
  product, a number, a line of code). The story (Larkfield and its people) starts on page 2 at
  the earliest, once the answer has begun, as the worked example.
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
  **voice** 431 words on 15 pages, about 2:46.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: ChatGPT and today's weather | kicker "INTERVIEW QUESTION"; caption "What is MCP?"; title "ChatGPT was trained months ago. How does it know today's weather?" (all at 0 s); [ChatGPT] chat window "ChatGPT": user bubble "What's the weather in Leeds right now?", reply bubble "Leeds, right now: 10 °C, cloudy" with a ticking clock "now"; [months ago] torn calendar chip "training data ends: months ago" (grey) over a model chip; [How] a "?" on the arrow between the model chip and the reply, pulsing from 0.5 s; [Leeds] ring on "Leeds" in the reply | ChatGPT's knowledge stopped months ago. Ask it today's weather, and it still knows. How? Follow one answer, the weather in Leeds, from a weather service into the chat. | Owner's hook A (2026-10-26). The chat window is an illustration: no claim is made about how ChatGPT fetches weather, and it is not said to use MCP. "Trained months ago" is the general fact that a model's training data ends at a cutoff. The topic is named on the board ("What is MCP?") at 0 s. First sentence: 5 words. |
| 2 | The answer: a tool | erase; [model] chip "language model · reads text, writes text"; [cannot know] chip "cannot know · training ended months ago"; [app] dashed box "the app around it" around the model chip; [tool] chip "tool · fetches live data" outside the box, arrow app → tool → back; [MCP] text "MCP · the standard way to plug tools in" | The model, the part that reads and writes text, cannot know. The app around it calls a tool that fetches live data. MCP is the standard way to plug tools in. | The honest answer within 20 s (hooks.md §6). General mechanism: the application runs what the model asks for (source 14); MCP is the open standard for connecting AI applications to external systems (source 1). Which tool ChatGPT uses, and whether over MCP, is not claimed. "Tool" gets its full definition on page 5. |
| 3 | Snow in Leeds | erase; caption "Tuesday 09:00"; [Larkfield's support assistant] agent node "Support assistant" with bubble "Yes, heavy snow in Leeds."; [none fell] stamp "NO SNOW"; [given it a tool] empty dashed tool slot beside the agent, crossed out | Without a tool, a model guesses. Larkfield's support assistant once reported heavy snow in Leeds, and none fell: nobody had given it a tool, so it had only its training. | Illustrative story (Larkfield is our fictional company); the old hook page, now the worked example (hooks.md §7, check 10). |
| 4 | The agent | erase; [agent] node "Agent" drawn around the model chip; [conversation] text "keeps the conversation"; [carries out] text "carries out what the model decides"; [Ollie] user node "Ollie · built it"; [fix] ring on the agent node | Around the model sits the agent, the program that keeps the conversation and carries out what the model decides. Ollie, the engineer who built the assistant, put his fix there. | Glossary "agent" (brief §1). Ollie is our fictional engineer. |
| 5 | A tool | same page; [tool] chip `get_weather` beside the agent; [another program] dashed box "another program" around the chip; [city] text "city in → weather out" | He gave the agent a tool: get_weather, a function in another program that the agent runs for the model. It takes a city and returns today's weather. | `get_weather` is real in the lab (`workspace/tools/weather_tool_server.py`). The application, not the model, runs the tool: source 14. |
| 6 | An MCP server | erase; [MCP server] node "Weather MCP server" holding chips `get_weather`, `get_forecast`; [Model Context Protocol] text "MCP · Model Context Protocol"; [any such program] faint second node "… MCP server" | The program offering get_weather is an MCP server. MCP, the Model Context Protocol, is one shared way to ask any such program for its tools and run them. | Sources 1, 3. A server offers one or more tools (brief §7.4); the lab's weather server offers two. The USB-C analogy is left out of the voice. |
| 7 | The MCP client | same page; [MCP client] box "MCP client" inside the agent; [exactly one] line client → server labelled "MCP"; [host] small label "host" above the agent | Inside the agent, a part called the MCP client holds the connection to exactly one MCP server. The protocol calls the agent itself the host. | Sources 2, 3 (1:1 client-server; host). "Host" is said once in the course, as the brief asks. |
| 8 | Messages: JSON-RPC | erase; [request] card "request" `{"method": "tools/list", "params": {}}`; [result] card "reply" `{"result": …}`; [error] card `{"error": …}` beside it | Client and server exchange JSON documents in a format called JSON-RPC. A request names a method, and the reply carries either a result or an error. Remember that pair. | Sources 1, 13. Video 4 builds on "result or error". Transports (stdio, Streamable HTTP) are left out of the voice; the lab uses Streamable HTTP (source 7, manifest). |
| 9 | The menu: tools/list | erase; packet [tools/list] client → server; [menu] card "menu": `get_weather` · "Get the current made-up weather for a city." / `get_forecast` · "Get a made-up multi-day forecast for a city." | The client asked the server for its menu with tools/list. Back came each tool's name and a description written for the model: Get the current made-up weather for a city. | Real names and descriptions (short.yaml `tlist`). Source 4. The model reads descriptions like a prompt (brief §7.11). |
| 10 | The input schema | same page; [input schema] line under `get_weather`: `city · string · required`; [days] line under `get_forecast`: `days · integer · default 3` | Under each name sits an input schema, the inputs a tool needs and their types. get_weather wants one, city, a string; get_forecast adds days, a whole number, three by default. | Real schemas (short.yaml `tlist`: `city` string required; `days` integer default 3). Source 4. |
| 11 | The model chooses | erase; [question] user bubble "Is it snowing in Leeds?"; [menu] stack of the two tool chips; model chip; [request] chip "call get_weather · city: Leeds"; [ran nothing] text "writes the request, runs nothing" | Then the agent handed the model the question and that menu, and the model answered with a request: call get_weather, city Leeds. It wrote the request; it ran nothing. | Illustrative: the lab has no model; the learner plays the agent's client. Model tool use: source 14; tools are model-controlled: source 4. |
| 12 | The call: tools/call | erase; packet [tools/call] "tools/call · get_weather · {city: Leeds}" client → server; [ran] ring on the server; packet [result] back; card `content: "Leeds, 10 °C, cloudy" · isError: false` | So the client sent tools/call with the tool's name and arguments. The server ran it and replied with a result whose content held the answer: Leeds, ten degrees, cloudy. | Source 4 (`tools/call`, `content`, `isError`). Leeds 10 °C cloudy is the lab's real output (short.yaml `term`). |
| 13 | In the lab | layout split; terminal (real) `python3 -B call_tool.py weather-tools-get-weather '{"city": "Leeds"}'`, show "0-2,5-10"; marks: [tools/call] the method, then the result lines; [toy server] chip "toy server · numbers made up"; [weather-tools] mark on the tool name | In the lab you send this tools/call yourself. A toy server makes the weather up, and the name starts with weather-tools, a prefix the next video explains. | Real terminal output (short.yaml `term`). The weather is invented by the toy server (brief §5). The lab call goes through ContextForge, hence the prefix (brief §6.5). |
| 14 | Recap | layout canvas; erase; four numbered chips: [tools/list] "1 tools/list · the menu", [picked] "2 the model picks", [tools/call] "3 tools/call · run by name", [result] "4 a result" | Focus on what just happened. The client fetched the menu with tools/list, the model picked a tool, the client ran it with tools/call, and the weather returned as a result. | Sources 1, 4. |
| 15 | Call to action | chip "Open the lab · See how tools reach an agent"; [Next] text "Next: 10 agents × 20 MCP servers" | Open the lab, See how tools reach an agent, and ask for the weather in Leeds yourself. Next: ten AI agents, twenty MCP servers, and two hundred connections. | Pointer to video 2 (its hook numbers). |

Left out on purpose (one idea per video): resources and prompts, the `initialize`
handshake (removed in the current spec and not visible in the lab), authorization, the two
transports, the USB-C analogy, and "any agent that speaks MCP can use any MCP server" (true,
but a second idea; the lab's call still needs the server's address configured).

---

## Video 2. Why an MCP gateway?

- **id** `mcp-why-a-gateway` · **idea** one proxy in front of many MCP servers gives agents one
  address and the platform team one place for registration, credentials and records ·
  **running example** ten agents and twenty MCP servers, then Larkfield's three agents and five
  MCP servers, then the lab · **story** Maren, the platform lead, replaces fifteen wires with
  one gateway · **voice** 394 words on 14 pages, about 2:32 (variant B: 396 words).

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: 200 connections | kicker "INTERVIEW QUESTION"; title "10 agents, 20 MCP servers. How do you manage access?" (both at 0 s); [Ten] ten agent dots in a column left; [twenty] twenty server dots right; [two hundred] lines fan between them from 0.3 s, dense, counter "10 × 20 = 200 connections"; [secret] key icon beside the counter "200 secrets"; [One box] at about 3 s a violet box drops into the middle, the lines re-route through it and the counter rolls to "10 + 20 = 30" | Ten AI agents, twenty MCP servers: two hundred connections, each with its own secret. One box in the middle makes it thirty. | Owner's hook A, with variant B's kicker and question as the title (2026-10-26). Illustrative numbers: 10 × 20 = 200, 10 + 20 = 30. The box is named on page 4; "manage access" is paid on pages 8 (one credential per agent) and 9 (who asked). First sentence: 13 words, the owner's wording. |
| 2 | Zoom in: three by five | erase; [three agents] column of agent nodes "Support", "Billing", "Ops" on the left; [five servers] column "Weather", "Calculator", "Orders", "Docs", "Maps" on the right; [fifteen lines] 15 lines draw one by one, counter "3 × 5 = 15" | To see why, take three agents and five servers. Larkfield's Support, Billing and Ops were each wired to weather, calculator, orders, docs and maps: fifteen lines, drawn one by one. | Illustrative (Larkfield is our fictional company); weather and calculator mirror the lab's two servers, orders, docs and maps are labels only. 3 × 5 = 15. |
| 3 | What each line costs | erase; the same two columns, compact; [credential] key chip on each agent "×5"; [Fifteen] counter "15 credentials"; [new server] a dashed sixth node joins the right column, three dashed lines, and each agent flashes "update" | Each line meant an address and a credential, a secret proving who is asking, kept inside that agent. Fifteen credentials, and every new server meant changing all three agents again. | Illustrative. 3 × 5 = 15. "Credential" is defined here and reused in videos 3 and 4. Wired directly, a new server changes every agent; behind one endpoint it changes none (brief §3.1). |
| 4 | An MCP gateway | erase; [Maren] user node "Maren · platform lead"; [MCP gateway] violet node "MCP gateway" in the centre, agents left, servers right; [proxy] text "proxy: receives each call, passes it on"; packet [passes] rides agent → gateway → server | So Maren, Larkfield's platform lead, put one program in the middle: an MCP gateway. A gateway is a proxy, a program that receives each call and passes it on. | Definition synthesised from sources 15-21 (brief §3.1). Maren is our fictional platform lead. |
| 5 | Two faces | same page; [single MCP server] label on the agents' side "looks like one MCP server"; [MCP client] label on the servers' side "acts as an MCP client" | To the agents, the gateway looks like a single MCP server. To the real servers it acts as their MCP client, the role each agent played before. | ContextForge "runs as a fully compliant MCP server" (15); it reaches the real servers with the `mcp` SDK's own client (`ClientSession`, `streamablehttp_client`; brief §10 A19). |
| 6 | Registration | erase; [operator] user icon with card "name + URL" → gateway; [did nothing] grey text "unchanged" on each server; packets [tools/list] gateway → each of the five servers | An operator then registered each server with the gateway once, by name and address; the server did nothing. The gateway connected and fetched each menu with tools/list. | Registration is the operator's act, not the server's (brief §1, §6.2); in the lab `seed_contextforge.py` does it. Sources 15, 22. |
| 7 | The catalogue | same page; [catalogue] list inside the gateway titled "catalogue"; [one reply] packet gateway → an agent "tools/list reply: every tool" | The five menus landed in one list inside the gateway, its catalogue. One tools/list to the gateway now returned every tool from every server, in one reply. | Sources 15, 16, 17. ContextForge's separate "MCP Registry" panel is not this catalogue (brief §1). |
| 8 | One address, one credential | erase; [one address] chip "mcp.larkfield.internal" on the gateway; three lines agents → gateway, five lines gateway → servers; [its own] one badge chip per agent; [moved] key chips glide from the agents into the gateway; [eight] counter "8 connections" | So each agent kept one address, the gateway's, and one credential, its own; the servers' secrets moved into the gateway. Three agents plus five servers made eight connections instead of fifteen. | Illustrative address. 3 + 5 = 8, the same arithmetic as the hook's 10 + 20 = 30. Single endpoint: sources 15, 16, 17. Credential injection: 16, 17; ContextForge stores them encrypted (22). Cut from the voice: "token passthrough is forbidden" (10, 11) and "a sixth server changes nothing on the agents". The lab has no upstream credentials. |
| 9 | One place to watch | erase; [row] card "gateway log (illustration)" `18:41 · Ops · orders-get-order · ok · 2400 ms`; rings in turn on [tool], [time], [how long], [worked]; [who asked] ring on "Ops" | Every call passed through one place, so the gateway wrote a row for each: tool, time, how long it took, whether it worked and, from the credential, who asked. | Logging: sources 16, 17, 19, 22. The lab log has no caller column (brief §5). Rate limiting cut from the voice (ContextForge default: on, 100 requests a minute plus a burst of 20 on MCP paths, per IP and per user; the lab turns it off; brief §10 A16). |
| 10 | What it is not | erase; chip "runs the tools" with a cross at [no tools]; chip "chooses the tools" with a cross at [chooses none]; [AI gateway] chip "AI gateway → language models" | The gateway runs no tools and chooses none; the servers do the work, and the model chooses. An AI gateway is a different thing: it carries calls to language models. | Brief §3.3. "Adds a hop, makes nothing faster" (brief §7.12) cut from the voice. |
| 11 | In the lab | layout split; [ContextForge] gateway node relabelled "ContextForge"; terminal (real) `python3 -B call_tool.py --list`, show "0,5-10", clip 50; marks [its address] the url, [five tools] the names | In the lab the MCP gateway is ContextForge, IBM's open-source gateway, with two toy MCP servers registered. One tools/list to its address returned five tools from both. | Real terminal output (short.yaml `tlist`). Source 15. |
| 12 | The record in the lab | terminal (real) `python3 -B call_tool.py calculator-tools-add '{"a": 17, "b": 25}'`; mark [forty-two] `42.0`; [view tab] chip "view tab: tool · time · success · response time"; [no caller] text "no caller column" | Then add with seventeen and twenty-five returned forty-two, and the view tab showed it as a new row: tool, time, success, response time. There is no caller column. | Real output (short.yaml `tadd`); view columns from `workspace/view_service.py` (ContextForge's `tool_metrics`). Every scripted lab call is the same admin identity (manifest `X-Authenticated-User`). The row appears when ContextForge flushes its metrics buffer, up to 60 s after the call, stamped with the call time; record the take after that (brief §10 A7). |
| 13 | Recap | layout canvas; erase; four chips [registered once], [one address], [one credential], [one place]; [thirty] the hook's counter returns: "10 + 20 = 30" | Focus on what changed. Servers registered once, one address and one credential per agent, one row per call in one place. Ten agents, twenty servers: thirty connections, not two hundred. | The payoff of the hook (illustrative numbers): 10 + 20 = 30 against 10 × 20 = 200. |
| 14 | Call to action | chip "Open the lab · See how tools reach an agent"; [Next] text "Next: should every agent see every tool?" | Open the lab, See how tools reach an agent, and find your own calls in the view tab. Next, a refund tool shows up on Support's menu. | Pointer to video 3. |

### Hook variants (video 2)

Variant B, for an A/B cut on TikTok. Only pages 1 and 2 differ; pages 3-14 are the main
table's, unchanged.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: the interview question | kicker "INTERVIEW QUESTION"; title "10 agents, 20 MCP servers. How do you manage access?" (both at 0 s); [Ten] ten agent dots left; [twenty] twenty server dots right; [two hundred] lines fan between them from 0.3 s, counter "10 × 20 = 200 connections"; [secret] key icons flicker along the lines at 1 s; [MCP gateway] at about 3 s a violet box labelled "MCP gateway" drops into the middle | A classic platform interview question, and the answer has a name: an MCP gateway. Ten agents times twenty servers is two hundred connections, each with its own secret. | Owner's hook B. The term comes first on purpose: it is the word people search for; its definition follows on page 4 as in the main cut. Illustrative numbers: 10 × 20 = 200. First sentence: 14 words, the owner's wording. |
| 2 | One box, then zoom in | the hook board stays for the first sentence: [One box] the lines re-route through the box, counter rolls to "10 + 20 = 30"; erase on "To see why"; [three agents] column "Support", "Billing", "Ops"; [five servers] column "Weather", "Calculator", "Orders", "Docs", "Maps"; [fifteen lines] 15 lines draw one by one, counter "3 × 5 = 15" | One box in the middle, and ten plus twenty makes thirty, not two hundred. To see why, take three agents and five servers: fifteen lines, drawn here one by one. | Illustrative. 10 + 20 = 30; 3 × 5 = 15. In this cut the agent and server names are on the board only, and Larkfield is first spoken on page 4. Page 3 of the main table follows unchanged. |

---

## Video 3. Virtual servers: the right tools for each agent

- **id** `mcp-virtual-servers` · **idea** a virtual server is a named bundle of tools at its
  own MCP address, so each agent is offered only what it needs · **running example** Support's
  and Billing's bundles at Larkfield, then `toy-tools` in the lab · **story** Priya finds a
  refund tool on the support assistant's menu · **voice** 409 words on 14 pages, about 2:37.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: the interview question | kicker "INTERVIEW QUESTION"; caption "MCP virtual servers"; title "How do you give each AI agent only the tools it needs?" (all at 0 s); [one catalogue] grey column "catalogue · 12 tools" on the left; [three agents] three agent nodes on the right; [three different menus] menus of 5, 2 and 12 chips draw beside them from 0.5 s; [separate server] a crossed-out stack "one server per agent" | Each agent should see only its own tools, without running a separate server for each one. One catalogue of twelve tools, three agents, three different menus. | Owner's hook B (2026-10-26). Illustrative counts (12 = the 5 lab-like tools plus 7 on the orders, docs and maps servers of video 2; 5, 2 and 12 are the three menus). "INTERVIEW QUESTION" on a question an interviewer could plausibly ask. The topic is named on the board at 0 s. First sentence: 16 words, the owner's wording. |
| 2 | A virtual server | erase; [MCP gateway] violet gateway node holding the grey list [catalogue] "catalogue · 12 tools"; [virtual server] box "support-tools" beside it with five chips glowing; [own address] chip `/servers/<id>/mcp` under the box; [ordinary MCP server] arrow agent → box labelled "looks like one MCP server" | The MCP gateway holds every tool in its catalogue. A virtual server is a named pick of those tools at its own address; an agent sees it as an ordinary MCP server. | The answer within 20 s (hooks.md §6): the table's old page 4, moved up. ContextForge definition and endpoint: sources 15, 22; endpoint confirmed live in 1.0.10. Keep `<id>` as a placeholder: the id is a fresh uuid on every install (brief §10 A11, A18). Brief §7.9: a selection plus an address. Gateway and catalogue: reminders of video 2. |
| 3 | Everyone sees everything | erase; caption "May"; [whole catalogue] gateway node with list "catalogue · 12 tools" fanned out to three agents; [Priya] user node "Priya · head of Support"; [issue_refund] ring on the red chip at the bottom of the support menu; [real money] stamp "£" | Larkfield learned this the hard way. Its MCP gateway offered every agent the whole catalogue, twelve tools, and Priya, who runs Support, found issue_refund, which moves real money, on her assistant's menu. | Illustrative (Larkfield and Priya are our fictional company and head of Support; no orders server in the lab). The old hook, now the worked example. `issue_refund` belongs to the orders server (label only). |
| 4 | One wrong choice away | erase; model chip beside the support agent; [menu] the 12-chip menu; [wrong choice] dashed arrow model → `issue_refund`; [weather tools and the calculator] ring on those five chips | The model picks from whatever menu it is given, so a refund was one wrong choice away. Support only ever needed the weather tools and the calculator. | Tools are model-controlled: source 4. |
| 5 | Support's bundle | erase; [support-tools] the box from page 2 returns beside the grey catalogue column; [five tools] chips `get_weather`, `get_forecast`, `add`, `subtract`, `multiply` glide into the box; [stayed out] stamp "left out" on `issue_refund` | Maren made Support one, support-tools, and picked five tools into it: get_weather and get_forecast from the weather server, and add, subtract and multiply from the calculator. issue_refund stayed out. | The five tools match the lab; leaving one out is illustrative (the lab's `toy-tools` holds all five). Maren is the platform lead from video 2. |
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
  lab's `does-not-exist` call · **story** Tomas traces why the assistant promised snow again ·
  **voice** 418 words on 15 pages, about 2:41.

| # | BOARD PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | Hook: the line | kicker "DEBUGGING QUESTION"; caption "MCP · when a tool fails"; title "Why does your AI agent make things up when a tool fails?" (all at 0 s); [This line] code card `if resp.status == 200: return resp.result`, a green tick landing on `200` at 0.5 s; [tool fails] a reply card slides under it at 1.5 s with `"isError": true` in red; [makes things up] chat bubble "Expect heavy snow in Leeds." with stamp "GUESS" | This line is why your AI agent makes things up when a tool fails. It looks correct, and you have probably written it yourself. | Owner's hook A (2026-10-26). The code card is an illustration of a common pattern, from no real codebase. The topic is named on the board at 0 s. First sentence: 13 words, the owner's wording. |
| 2 | Status and body | erase; [HTTP 200] envelope icon with green chip "HTTP 200"; [delivered and answered] text under it; [body] the reply card, large: `"result": {"isError": true, "content": text "Weather service timed out"}`; [isError] red ring on `isError`; [never reads] the code card returns small, `resp.status == 200` highlighted, a cross between it and the body | HTTP 200 only says the request was delivered and answered. Whether the tool worked is written in the body, next to isError, and this line never reads it. | The payoff within 20 s (hooks.md §6). Lab-real pattern (`does-not-exist` returns 200 with `isError`). Under the 2026-07-28 spec some protocol errors change the HTTP status (source 8), so the rule taught is "200 is not proof", never "errors are always 200". The message text is illustrative. |
| 3 | Snow in Leeds, again | erase; caption "Thursday 08:00"; [that line] the code card, small, framed "assistant code (illustration)"; [heavy snow] agent bubble "Expect heavy snow in Leeds."; [again] stamp "NO SNOW" | Larkfield's support assistant had that line. At eight one Thursday it told a customer to expect heavy snow in Leeds, and again, no snow fell. | Illustrative story; callback to video 1 (the old hook, now the worked example). |
| 4 | Follow the call | erase; [Tomas] user node "Tomas · staff engineer"; chain: agent → [MCP gateway] → [weather MCP server]; packet `get_forecast · Leeds` along each link | Tomas, the staff engineer, pulled the trace. The assistant had called get_forecast for Leeds through the MCP gateway, which passed it to the weather MCP server. | Illustrative: the lab has no trace view beyond the view tab. Gateway as proxy: video 2. |
| 5 | The far end | same page; [outside weather service] cloud node after the server; [did not answer] clock icon and red chip "timed out" on the cloud | That server asked an outside weather service for its data, and the service did not answer in time. The chain had broken at its far end. | Illustrative: the lab's weather server calls no outside service and never times out. |
| 6 | The reply: a tool execution error | erase; card "the reply" (simplified) `"result": {"isError": true, "content": text "Weather service timed out"}`; marks [isError] and [short text]; [tool execution error] label under the card | The weather server did not crash. It sent a normal result with isError true and a short text: weather service timed out. The specification calls this a tool execution error. | Shape: source 5 (API failures are tool execution errors). The message text is illustrative. |
| 7 | What went wrong | erase; [the line] the code card, large; [200] ring on `200`; [isError] the reply card beside it, its `isError` line crossed out as unread; model chip; [guess] stamp "GUESS" | Tomas found the line from the start. It took 200 as proof and never read isError, so the model never learned the tool had failed, and filled the gap with a guess. | Illustrative. The spec says clients SHOULD pass tool execution errors to the model (5). The old "status and body" page is now page 2. |
| 8 | The other kind: a protocol error | erase; card "request" `"method": "tools/calll"`; [error object] card `"error": {"code": -32601, "message": "Method not found: tools/calll"}`; [no result] text "no result"; [protocol error] label; small unspoken text "2026-07-28 spec: some protocol errors also get 400/404" | The second kind is the protocol error: the server could not handle the request itself, say a misspelt method name. The reply holds an error object, code and message, and no result. | JSON-RPC code `-32601` (13). Lab-real: ContextForge 1.0.10 answers `tools/calll` on `/servers/<id>/mcp` with HTTP 200 and exactly this error object, no result (captured 2026-10-25; brief §10 A2). `call_tool.py` cannot send a custom method, so it is not a learner step. Under 2026-07-28 the status would be 404 (8). |
| 9 | Which is which | erase; two columns. Left "protocol error · error object": [unknown tool], [malformed request], "server error". Right "tool execution error · isError": [failed API], [bad input], [business rule]; [correct itself] text under the right column "written for the model" | The specification sorts them: unknown tool and malformed request are protocol errors. A failed API, a bad input or a business rule are tool execution errors, written for the model to correct itself. | Source 5 (2026-07-28; input validation moved to tool execution errors in 2025-11-25), re-checked 2026-10-25: both lists unchanged in 2026-07-28 (brief §10 B1). Lab: `calculator-tools-add` with `"a": "x"` returns `isError: true` (brief §10 A4). "Server error" is on the board but not spoken. |
| 10 | In the lab | layout split; terminal (real) `python3 -B call_tool.py does-not-exist '{}'`, show "1-4"; marks [HTTP 200] `HTTP 200`, [isError] `"isError": true`, [Tool not found] `Tool not found: does-not-exist` | In the lab, a call to a tool named does-not-exist came back with HTTP 200, isError set to true, and the text: Tool not found. | Real output (short.yaml `terr`), re-captured 2026-10-25 unchanged; graded by `answers-match-the-gateway`. This call adds no row to the view tab (brief §10 A5). |
| 11 | Lab versus specification | two chips beside the terminal: [specification] "spec: unknown tool → protocol error"; [ContextForge] "ContextForge 1.0.10 → isError result"; [MCP Python SDK] text "MCP Python SDK: any failure in a tool → isError"; [depends on the server] chip "read the body" | The specification files an unknown tool under protocol errors. ContextForge reports a tool error, because the MCP Python SDK beneath it turns any failure in a tool into one. The shape depends on the server. | Sources 5, 25, 26 (brief §2.6), confirmed with the lab's pinned SDK, `mcp` 1.30.0 (brief §10 A1). Kept so a careful viewer does not learn the wrong rule from the lab. |
| 12 | A careful agent: the error object | layout canvas; erase; tree from a "reply" node; [error object] branch → "agent's code: fix the request"; [fetching the menu again] chip `tools/list` | So a careful agent reads the body. On an error object, its own code steps in, say by fetching the menu again. | Protocol errors are for code, not the model (source 5: "less likely to result in successful recovery"). "Fetch the menu again" is our advice, not a spec rule. |
| 13 | A careful agent: isError | same page; [isError] branch → "model reads the text" → three leaves [fix an input], [retry once], [admit]; bubble "Sorry, I have no forecast for Leeds right now." | On isError it hands the text to the model, which can fix an input, retry once, or admit it has no forecast. | Source 5 ("Clients SHOULD provide tool execution errors to language models"). "Retry once" is our advice. |
| 14 | Recap | erase; three chips [status], [body], [told the truth] | Focus on what just happened. The status said the message arrived, the body said whether the tool worked, and the agent that read it told the truth instead of guessing. | |
| 15 | Call to action | chip "Open the lab · See how tools reach an agent"; [four videos] four small chips "server · gateway · virtual server · failure" | Open the lab, See how tools reach an agent, and call a tool that does not exist. That closes the four videos: server, gateway, virtual server, failed call. | Last video of the set; no pointer. |

---

## Read-aloud check (done, redone 2026-10-26 for the new hooks)

- The only narrated question in the set is V1's hook, spoken once on page 1 ("How?"), as
  hooks.md §7 check 6 allows. Every other hook question is a board title only.
- Page 1 of every video names the topic on the board at 0 s (caption "What is MCP?", title
  "10 agents, 20 MCP servers…", caption "MCP virtual servers", caption "MCP · when a tool
  fails") and anchors on something real: ChatGPT, 10 × 20 = 200, a twelve-tool catalogue, a
  line of code. No fictional company, person, date or place is spoken before page 2 (V2) or
  page 3 (V1, V3, V4).
- First spoken sentences: V1 "ChatGPT's knowledge stopped months ago." (5), V2 "Ten AI agents,
  twenty MCP servers: two hundred connections, each with its own secret." (13, the owner's
  wording), V3 "Each agent should see only its own tools, without running a separate server
  for each one." (16, the owner's wording), V4 "This line is why your AI agent makes things up
  when a tool fails." (13, the owner's wording). The three over 12 words are the owner's own
  lines, kept verbatim.
- Payoff by page 2: V1 "the model cannot know; the app calls a tool; MCP is the standard way
  to plug tools in", V2 the 10 × 20 zooms to 3 × 5 (the gateway is named on page 4, about
  40 s, after the cost of the lines is shown), V3 "a virtual server is a named pick of the
  catalogue's tools at its own address", V4 "200 says delivered; isError is in the body; this
  line never reads it".
- Terms defined at first use, after the need for them is shown: model and tool, in plain words
  (V1 #2), MCP named (V1 #2) and defined as the Model Context Protocol (V1 #6), agent (V1 #4),
  tool in full (V1 #5), MCP server (V1 #6), MCP client and host (V1 #7), JSON-RPC (V1 #8),
  tools/list and menu (V1 #9), input schema (V1 #10), tools/call and result (V1 #12),
  credential (V2 #3), MCP gateway and proxy (V2 #4), register (V2 #6), catalogue (V2 #7),
  AI gateway (V2 #10), virtual server (V3 #2), prefix (V3 #8), tool execution error (V4 #6),
  protocol error and error object (V4 #8). "MCP servers" is spoken in V2's hook and "MCP
  gateway" in V3 #2 and V4 #4 as terms from the earlier videos.
- Every VOICE cell is 22-35 words and two to four sentences. The longest is V4 #11 (35), kept
  on purpose; the shortest are V2's hook (22) and the two halves of the split "careful agent"
  page (V4 #12-13).
- Every [cue] in ON SCREEN appears word for word in its VOICE cell (checked by script, case
  and punctuation ignored), including the V2 variant table.
- No jokes, no "okay/so, here's the thing", no narrator "I", no lists of three for rhythm:
  the only three-item lists are real sets (three agents, three calculator tools, three menus,
  the spec's own error categories). Past tense for the Larkfield stories; present tense for
  the hooks, definitions, the lab and the call to action.
- "Tool gateway" appears in no VOICE or ON SCREEN cell.
- Arithmetic: 10 × 20 = 200 direct connections and 10 + 20 = 30 through a gateway (V2 #1,
  #13, variant B); 3 × 5 = 15 direct and 3 + 5 = 8 through the gateway (V2 #2, #3, #8);
  twelve catalogue tools, menus of 5, 2 and 12, five picked into support-tools (V3); five lab
  tools (2 weather + 3 calculator); 17 + 25 = 42.0; Leeds → 10 °C cloudy; `days` defaults
  to 3. The old 3 × 4 = 12 is gone.
- Honesty of the hooks: V1 does not say how ChatGPT gets weather or that it uses MCP; V2's
  and V3's numbers are marked illustrative in NOTE; V4's code card is marked an illustration.

## Owner review summary

One line per board page: the one thing the page teaches.

**Video 1. What is MCP?**
1. Hook: ChatGPT and today's weather — a model trained months ago answers about now; how?
2. The answer: a tool — the model cannot know; the app around it calls a tool; MCP is the standard way to plug tools in.
3. Snow in Leeds — without a tool, a model guesses (the worked example begins).
4. The agent — the agent is the program around the model, and Ollie's fix goes there.
5. A tool — a tool is a function in another program the agent runs for the model.
6. An MCP server — the program offering tools is an MCP server; MCP is the shared way to ask it.
7. The MCP client — one client inside the agent holds the connection to exactly one server; the agent is the host.
8. Messages: JSON-RPC — a request names a method; the reply is a result or an error.
9. The menu: tools/list — tools/list returns names and descriptions written for the model.
10. The input schema — each tool says which inputs it needs and their types.
11. The model chooses — the model writes the request and runs nothing.
12. The call: tools/call — tools/call runs a tool by name and returns a result with content.
13. In the lab — you send the same tools/call; the weather is a toy's, the name has a prefix.
14. Recap — list, pick, call, result.
15. Call to action — open the lab; next, ten agents and twenty MCP servers.

**Video 2. Why an MCP gateway?**
1. Hook: 200 connections — ten agents times twenty MCP servers is two hundred connections and secrets; one box makes it thirty.
2. Zoom in: three by five — three agents and five servers: fifteen lines.
3. What each line costs — every line is an address plus a credential; a new server changes every agent.
4. An MCP gateway — one proxy in the middle of every call.
5. Two faces — it looks like one MCP server to agents and acts as an MCP client to servers.
6. Registration — an operator registers each server once; the gateway fetches its menu.
7. The catalogue — all menus in one list; one tools/list returns everything.
8. One address, one credential — three plus five is eight connections; server secrets live in the gateway.
9. One place to watch — one row per call: tool, time, duration, success, who.
10. What it is not — it runs no tools, chooses none, and is not an AI gateway.
11. In the lab — ContextForge, two toy servers, five tools from one tools/list.
12. The record in the lab — the view tab's row for the 42.0 call, with no caller column.
13. Recap — registered once, one address and one credential per agent, one place; ten plus twenty is thirty.
14. Call to action — find your own calls; next, who should see what.

Variant B (A/B cut): 1. Hook: the interview question — the answer has a name, an MCP gateway;
2. One box, then zoom in — ten plus twenty is thirty; three by five is fifteen. Then page 3 on.

**Video 3. Virtual servers**
1. Hook: the interview question — give each agent only its tools, without a server per agent.
2. A virtual server — the gateway's catalogue holds every tool; a virtual server is a named pick of them at its own address.
3. Everyone sees everything — the gateway offered its whole catalogue to every agent, refund tool included (the worked example begins).
4. One wrong choice away — the model picks from any menu it is given.
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
1. Hook: the line — `if resp.status == 200: return resp.result` is why an agent makes things up when a tool fails.
2. Status and body — HTTP 200 means delivered and answered; the body says whether the tool worked; this line never reads it.
3. Snow in Leeds, again — Larkfield's assistant had that line and promised snow again (the worked example begins).
4. Follow the call — agent, gateway, weather server.
5. The far end — the outside service timed out.
6. The reply: a tool execution error — a normal result with isError true and a text message.
7. What went wrong — the code took 200 as proof, never read isError, and the model guessed.
8. The other kind: a protocol error — an error object with a code and message, and no result.
9. Which is which — the spec's two lists.
10. In the lab — does-not-exist returns 200, isError true, Tool not found.
11. Lab versus specification — the spec calls an unknown tool a protocol error; ContextForge's SDK makes it a tool error.
12. A careful agent: the error object — code fixes the request.
13. A careful agent: isError — the model reads the text and fixes, retries or admits.
14. Recap — status, body, truth.
15. Call to action — call a tool that does not exist; the set is complete.

## Change log

**Hooks chosen, 2026-10-26** (against commit e0b5c21). The owner rejected the first two rounds
of hook options as vague riddles about abstractions and set the rule now in hooks.md §7 and
docs/video-prompt.md (name the topic plainly, anchor on a real product, number, line of code or
interview question, a question people would type into a search box, no "a box" or "a program",
no names or company set-up before the problem). No research fact or source changed; no claim
was added that the brief does not support.

- **Every page 1** now carries the topic in plain words at 0 s (a caption or the title), an
  orange genre kicker in capitals, and a real anchor. The fictional story starts on page 2
  (V2) or page 3 (V1, V3, V4) as the worked example. "How to read these tables" relaxes the
  narrated-question rule for page 1 and records the page-1 rule.
- **Video 1 (hook A, 14 → 15 pages, 397 → 431 words, about 2:46).** Page 1 is ChatGPT's
  training cutoff against today's weather. Page 2 answers within 20 s: the model cannot know,
  the app around it calls a tool that fetches live data, MCP is the standard way to plug tools
  in; it does not say which tool ChatGPT uses or that it uses MCP (brief §2.1 and source 14
  support the general mechanism only). The old hook (Tuesday, snow in Leeds, Ollie) is now
  page 3, with the old page 2's "the model guessed" folded in; Ollie is introduced on page 4;
  the tool definition on page 5 is shortened so it is not defined twice. The call to action
  points at video 2's new numbers (ten agents, twenty MCP servers).
- **Video 2 (hook A with B's question; 14 pages, 397 → 394 words, about 2:32).** Page 1 is
  10 × 20 = 200 connections and secrets, then one box and 10 + 20 = 30, under the kicker
  "INTERVIEW QUESTION" and B's question "10 agents, 20 MCP servers. How do you manage access?".
  Page 2 zooms to a slice of three agents and five servers (fifteen lines), so pages 3 and 8
  keep 3 × 5 = 15 and 3 + 5 = 8; the old 3 × 4 = 12 and "a fifth server arrived" are gone,
  and page 3 now says a new server changes all three agents. Maren is introduced on page 4.
  The recap returns to the hook's counter (thirty, not two hundred). The slow-Friday whodunit
  (which agent flooded the orders server) is dropped with the old hook; page 9's "who asked"
  column stays as a fact. Variant B is written in full under "Hook variants" (pages 1-2, 396
  words with the shared pages) for an A/B cut.
- **Video 3 (hook B; 14 pages, 396 → 409 words, about 2:37).** Page 1 is the interview
  question "How do you give each AI agent only the tools it needs?" over one catalogue of
  twelve tools and three menus of 5, 2 and 12. Page 2 is the old page 4 moved up: the gateway's
  catalogue holds every tool; a virtual server is a named pick at its own address, an ordinary
  MCP server to an agent. The old hook (May, Priya, the refund tool) and "everyone sees
  everything" merge into page 3 as the worked example; page 5 draws the support-tools box
  again rather than building on the same page.
- **Video 4 (hook A; 14 → 15 pages, 397 → 418 words, about 2:41).** Page 1 is the code card
  `if resp.status == 200: return resp.result` with the owner's line. Page 2 is the old page 5
  ("status and body") moved up and extended: this line never reads isError. The old hook
  (Thursday, snow again) is page 3; the old page 6 ("what went wrong") is now page 7, told as
  Tomas finding the line from the start. Pages 8-15 are the old 7-14, unchanged.
- The read-aloud check and the owner review summary are redone for the new page numbers; the
  hook-option tables stay as the record of the first round, under a "Decision" note.

---

Against the previous draft (commit 75f4ae5). The research facts and sources are unchanged;
the edits are to pacing, order and wording.

**Across all four videos**
- Rewrote every VOICE cell to one idea in 20-30 words (the old pages carried 35-45 words and
  two or three new terms). Split the dense pages and dropped most "same page" piling: a row now
  adds to the board only when the picture genuinely builds (agent → tool, server → client,
  gateway → its two faces, menu → schema, error-object branch → isError branch).
- Gave each video a single thread with a named person from the Larkfield cast (Ollie, Maren,
  Priya, Tomas) and a time, and joined pages with a cause or a time ("No snow fell, and by
  lunchtime...", "So Maren put one program in the middle", "A second problem appeared when").
  The hook is answered inside the video (Maren finds her answer in one table; Tomas finds the
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
