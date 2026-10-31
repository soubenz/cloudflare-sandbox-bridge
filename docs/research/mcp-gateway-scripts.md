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
  virtual server is a named pick of them at its own address); the refund tool,
  `issue_refund` on Support's menu, is the worked example (since 2026-10-31 without Priya).
- **Video 4: A**, as a code card: `if resp.status == 200: return resp.result`. Page 2 pays it
  off by 20 s; the Leeds forecast call that came back 200 with `isError` follows as the worked
  example, with Tomas pulling the trace.

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
- **Scenes (all four videos, from 2026-10-31).** A video written in the FLOW format of
  docs/video-prompt.md has three or four SCENES, each one board that keeps building; the board
  is erased only between scenes, so most rows are "same board" and ON SCREEN says what is added
  or changed and where it sits on what is already there. The second column is then SCENE /
  PAGE. Since the second pass on V1 (2026-10-31, after the owner watched the four-scene cut) a
  scene is a **board that answers one question and holds at most four or five things**; a video
  may have five or six such boards, erased when the next question starts, with a spoken bridge
  and one small carried-over anchor (a question chip, a tiny map in a corner) across each
  erase. The board carries short names and real data only; definitions are spoken, and the
  voice never reads an on-screen label aloud (docs/video-prompt.md, FLOW). Since the third pass
  on V1 (2026-10-31, after the owner's note on rushing and missing explanations) every claim a
  newcomer would question carries its reason in the same breath or the next sentence, sourced in
  NOTE, and a `pause:` follows each key reason (see NOTE below). Each VOICE cell picks up the previous page or ends with the question the next page
  answers; those hand-off questions are narrated, the one exception to the no-questions rule
  below. One running example stays on the board from the hook to the recap (V1 the Leeds
  question, V2 the 10 × 20 zoomed to 3 × 5, V3 Support's box and the refund tool, V4 the
  forecast call that came back 200 with `isError`), and the recap is that picture numbered.
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
  the source number from the list at the end. A fact cut from the voice is noted there too. A
  line `pause: 0.8` before or after quoted words asks the render for that much silence at that
  point (the `pause:` beat of `short.yaml`, docs/shorts.md), 0.6-1.0 s, on top of the page
  break; from V1's third pass on, one follows each key "why" so it lands.
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
  calls one by name · **running example** one question, "Is it snowing in Leeds?", followed
  from the chat to the weather server and back · **story** none spoken (no Larkfield, no Ollie:
  one example, six small boards) · **voice** 434 words on 16 pages across 6 boards, 5 erases
  (one of them the lab's layout split), about 2:33 spoken, about 2:50 with the fifteen page
  breaks and the three mid-page pauses (about 153 words a minute overall, silences included).

Rewritten 2026-10-31 (third pass) after the owner's note on the six-board cut: "I feel you
rushed a bit some parts, and also sometimes you are expected to give an explanation but you
don't. For example when you said the request doesn't come from the model, why is that? Why was
that choice made?" Every statement a newcomer would question now carries its reason in the same
breath or the next sentence, each reason grounded in the brief or in a source quoted in NOTE,
and the pace is slowed: a `pause:` (0.8 s) after each key "why", on top of the page breaks, and
the details that did not earn their time are cut (the host label, the `days` default, the
request-and-reply shape of JSON-RPC, the "two hundred connections" of the pointer). The six
boards, the one-question-per-board rule, the show-don't-read rule, the whiteboard voice, the
hook, the lab-real output and the call to action are kept from the second pass (commit bb518b1).

The whys, and where each lands:
- why the model can't look it up itself (page 2): a model only reads and writes text, so it
  fetches nothing; something outside it has to act (brief §1; source 14).
- why a standard (page 6): build a server once and any app that speaks MCP can use it, instead
  of wiring every tool into every app (source 1).
- why the model doesn't talk to the server (page 7): it can't, as page 2 said; the client holds
  the connection (brief §1, §2.2).
- why the menu carries descriptions (page 9): the model picks a tool by reading them (brief
  §7.11; source 14).
- why an input schema (page 10): it tells the model what to fill in and lets the server check
  what arrives (source 4; lab-real, brief §10 A4).
- why the model only writes the request while the app runs it (page 12): it keeps the app in
  control, so it can show you the request and let you say no, hold any keys, and log what was
  called (source 4: human in the loop, show inputs, log usage; source 10 and brief §2.9: the
  client holds the credential).

Board plan (question · things · anchor):
1. **The frozen model** (pages 1-3) · how does a model trained months ago answer about now? ·
   chat window, model chip with its calendar, the dashed "months ago | now" line, the app frame,
   the tool chip with the MCP arrow · none (the hook board).
2. **Who's involved** (pages 4-7) · who is in the picture, and why a standard? · Leeds chip,
   agent box with the model and the MCP client inside it, the line, the weather MCP server with
   two tool chips, two faded "any app" boxes · the Leeds question chip, top-left.
3. **Asking for the menu** (pages 8-10) · what travels along the line, first? · the line drawn
   large with "JSON-RPC" on it, the tools/list packet, the menu card, the input-schema zoom card ·
   the tiny map, top-left.
4. **Making the call** (pages 11-13) · who picks, who runs it, and why that split? · the question
   and the menu going into the model, the request card, the MCP client with its three marks
   (tick-and-cross, key, log line) and the tools/call packet riding to the server, the result
   card, the reply bubble · the tiny map, top-left.
5. **In the lab** (page 14) · what does the same call look like typed? · the terminal, large ·
   the tiny map, bottom-left.
6. **Recap** (pages 15-16) · what just happened? · the whole flow redrawn small and clean, four
   numbered badges, the calendar and the clock, the lab chip · the redraw itself.

| # | SCENE / PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | **S1 The frozen model** · Hook | kicker "INTERVIEW QUESTION", caption "What is MCP?", title "ChatGPT was trained months ago. How does it know today's weather?" (all at 0 s, top of the board); [ChatGPT] chat window "ChatGPT" centre-right: user bubble "Is it snowing in Leeds?", reply bubble "Leeds, right now: 10 °C, cloudy" with a ticking clock "now"; [months ago] white chip "model" left of the chat, under a torn grey calendar chip "months ago"; [where] a "?" on the arrow from the model chip to the reply, pulsing from 0.5 s; [Leeds] ring on "Leeds" in the user bubble | Ask ChatGPT whether it's snowing in Leeds right now, and it can tell you, even though its training ended months ago. So where did that answer come from? Let's trace it. | Owner's hook A (2026-10-26): kicker, title and spoken line unchanged. The chat window is an illustration: nothing is claimed about how ChatGPT fetches weather, and it is not said to use MCP. Board 1 holds the chat window, the model with its calendar, and the "?"; pages 2-3 add two more things. |
| 2 | S1 · The gap | same board; [language model] the model chip pulses and the arrow from it to the reply bubble thickens; [calendar] ring on the calendar chip, then a dashed vertical line drops from it to the bottom of the board, the clock "now" on its right; [look] a thin grey arrow from the model chip towards the clock is drawn and crossed out; [guessing] the "?" on the arrow turns grey | The language model, the part writing the reply, can't know. What it learned stops at that calendar, and it can't go and look: a model only reads and writes text. Alone, it'd be guessing. | **Why it can't look it up itself.** Glossary "language model" (brief §1: "reads text and writes text ... it runs nothing"); source 14: the model "returns a structured call that your application runs", and client tools "run in your application". So the model produces words and nothing else; something outside it has to act (page 3). The definition is spoken, not written. `pause: 0.8` before "Alone", so the reason lands. The dashed line is the gap the rest of the video crosses; it stays until the board is erased. |
| 3 | S1 · A tool | same board; [app] dashed frame "app" around the model chip and the chat window; [tool] cyan chip "tool" right of the dashed line, outside the frame, with an arrow from the frame to it and back to the model chip; [MCP] the word "MCP" written on that arrow; [involved] the grey "?" slides off the chat arrow onto the MCP arrow and pulses | Instead, the app around it asks a tool: a function in another program that fetches live data. MCP is the standard way to plug one in. That's the whole trick. Who's involved? | The honest answer within 20 s (hooks.md §6): the application runs what the model asks for (source 14); MCP is the open standard for connecting AI applications to external systems (source 1). Which tool ChatGPT uses, and whether over MCP, is not claimed. The acronym's expansion (Model Context Protocol) is cut from the voice in this pass for pace; the caption and the concept page carry it. Why a standard at all is answered on page 6, once the server is on the board. The closing question is the one board 2 answers; the "?" travels with it. Board 1 ends with five things: chat window, model with calendar, dashed line, app frame, tool with its arrow. |
| 4 | **S2 Who's involved** · The agent | erase; [Leeds] small orange chip "Is it snowing in Leeds?" in the top-left corner (the carried anchor; it stays for this board); [agent] blue box "Agent" centre-left, a thin arrow from the chip into it; [model] white chip "model" inside the box, lower left | Same Leeds question. The program receiving it is the agent: it keeps the conversation and does what the model decides, so the model sits inside it. | Glossary "agent" (brief §1), spoken. The first three words are the spoken bridge across the erase. This board is kept to page 7. |
| 5 | S2 · The MCP server | same board; [Far right] cyan node titled "Weather MCP server" at the right edge, level with the agent; [get_weather] chip `get_weather` inside it; [get_forecast] chip `get_forecast` under it; [MCP server] the node's title is ringed once | Far right, another program with two functions, get_weather and get_forecast. Each is a tool, and a program offering tools this way is an MCP server. | Sources 1, 3; a server offers one or more tools (brief §7.4). `get_weather` and `get_forecast` are the lab's real tools (`workspace/tools/weather_tool_server.py`). All three terms are spoken; nothing is captioned. |
| 6 | S2 · Why a standard | same board; [once] the server node pulses once; [any app] two faded grey boxes "app", stacked behind the agent box, each with a thin dashed line to the same server; [wiring] the dashed lines settle, then fade to faint | Build it once, and any app that speaks MCP can use it, instead of wiring every tool into every app. | **Why a standard.** Source 1: MCP "is an open-source standard for connecting AI applications to external systems"; "MCP provides a standardized way to connect AI applications to external systems"; "making it easy to build once and integrate everywhere"; for developers it "reduces development time and complexity when building, or integrating with, an AI application or agent" (intro page, re-read 2026-10-31). The grey apps are illustrative. Nuance kept in NOTE: an app still needs the server's address configured (brief §6.6), so the voice says "can use it", not "with no setup". The USB-C analogy stays out: it says nothing about the menu (brief §8). `pause: 0.8` at the end of the page. |
| 7 | S2 · The MCP client | same board; [directly] a dashed arrow from the model chip straight to the server flashes and is crossed out grey, and the grey apps fade further; [MCP client] small blue box "MCP client" inside the agent, right of the model; [this line] a solid line from the client to the server, drawn left to right; [along] the grey "?" from board 1 lands on the line | The model doesn't talk to it directly; it can't, remember. Inside the agent sits the MCP client, which holds the connection, this line. What travels along it? | Sources 2, 3. "It can't, remember" is the callback to page 2's reason; the full "why that split" comes on page 12 once the request exists. The crossed-out arrow is the misconception "the client is the model" (brief §1, §7.1). Cut from the voice in this pass: "exactly one server" (the 1:1 rule, brief §2.2) and "the spec calls the agent the host" (glossary: mention once in video 1), both at the owner's pace note; the concept page keeps them, and the "host" label is off the board since nothing unspoken is drawn. Board 2 ends with five things: Leeds chip, agent (model and client inside), the line, the server with two chips, the faded apps. The closing question is the one board 3 answers. |
| 8 | **S3 Asking for the menu** · tools/list | erase; [Small] tiny map in the top-left corner (the carried anchor; it stays for boards 3, 4 and 5): agent box with a model dot and a client dot, the line, a server dot, the grey "?" on its line; [JSON-RPC] the line redrawn large across the board, client end left, server end right, the small name "JSON-RPC" above its middle; [tools/list] packet "tools/list" rides the line left to right | Small JSON messages, called JSON-RPC. First comes tools/list, the agent asking what's on offer. | Sources 1, 4, 13. The first words answer board 2's question (the spoken bridge). JSON-RPC is named once, plainly; its request-and-reply shape ("a method; back a result or an error") is cut from the voice in this pass and lives here: video 4 draws the error object on its own page 7. Transports stay in NOTE: the lab uses Streamable HTTP (source 7). |
| 9 | S3 · The menu | same board; [Back] card "menu" rides the line right to left and docks under it, nearer the server: `get_weather` · "Get the current made-up weather for a city." / `get_forecast` · "Get a made-up multi-day forecast for a city."; [name] ring on the two names; [description] ring on the two description lines; [reading] the model dot in the tiny map pulses | Back comes the menu: two tools, each a name and a short description, written for the model, not you, because the model picks a tool by reading it. | **Why descriptions.** Real names and descriptions (short.yaml `tlist`). The model reads descriptions like a prompt (brief §7.11); source 14: "Claude determines when to call a tool based on the user's request and the tool's description." `pause: 0.8` at the end of the page. |
| 10 | S3 · The input schema | same board; [third part] a zoom card beside the menu, headed "input schema", with `get_weather` → `city · string · required`; [fill in] a blank slot "city: ___" flashes on the card; [check] the server dot in the tiny map pulses; [picks] the grey "?" hops from the tiny map's line onto the menu card | The third part, the input schema, is what the tool needs: get_weather wants a city. Now the model knows what to fill in, and the server can check what arrives. Who picks? | **Why a schema.** Real schema (short.yaml `tlist`: `city` string required). Source 4: `inputSchema` is a JSON Schema; servers MUST "Validate all tool inputs". Lab-real: `weather-tools-get-weather` with `{}` comes back `isError: true`, "Field required" (brief §10 A4). Cut in this pass: `get_forecast`'s `days` default (the card now shows one line). `pause: 0.8` before "Who picks?". Board 3 ends with five things: the tiny map, the line with its name, the tools/list packet, the menu card, the schema card. The closing question is the one board 4 answers. |
| 11 | **S4 Making the call** · The model picks | erase; [The model does] the tiny map stays top-left, its "?" now on the model dot; the white chip "model" drawn large centre-left; [your question] orange bubble "Is it snowing in Leeds?" above the model, a thin arrow into it; [that menu] the menu card, small, beside the bubble, a second thin arrow into the model; [request] white card out of the model: "call get_weather · city: Leeds" | The model does. Given your question and that menu, it answers with a request: call get_weather, city Leeds. | Illustrative: the lab has no model; the learner plays the agent's client. Model tool use: source 14; tools are model-controlled: source 4. This board is kept to page 13. |
| 12 | S4 · Why the model only writes | same board; [ran nothing] the dashed model → server arrow in the tiny map flashes crossed out; [control] small blue box "MCP client" right of the model, and the request card slides into it and stops; [say no] a small orange user icon beside the client with a tick and a cross; [keys] a key icon inside the client box; [log] a short grey line under the client, `get_weather · Leeds` | It wrote the request and ran nothing. That's deliberate: it keeps the app in control. It can show you the request and let you say no, hold any keys, and log what was called. | **Why the split**, the owner's example. Glossary: the model chooses by writing a request and runs nothing (brief §1, §7.1). The reasons are the spec's own duties for the side that runs tools (source 4): "There SHOULD always be a human in the loop with the ability to deny tool invocations"; clients SHOULD show inputs before calling and "Log tool usage for audit purposes". Keys: the MCP client is the OAuth client and the token rides in its header, and a stdio server takes credentials from the environment (brief §2.9; source 10), so the credential lives with the app and never in the model's text. The three marks are illustrative (the lab has no key; its log is the view tab, video 2). `pause: 0.8` after "ran nothing.", so the surprise lands before the reason, and the page break after "called". |
| 13 | S4 · tools/call and the result | same board; [client's] the client box pulses; [tools/call] packet "tools/call · get_weather · {city: Leeds}" rides a line from the client to the right edge, where the cyan server node with its `get_weather` chip is redrawn; [runs] ring on `get_weather`; [result] packet back along the line, and a green card under the line: `content: "Leeds, 10 °C, cloudy" · isError: false`; [no snow] reply bubble under the user bubble: "No snow. Leeds is 10 °C and cloudy." | Running it is the client's job. It sends tools/call down the line, and get_weather runs. Back comes the result, Leeds, ten degrees, cloudy, and the model writes the reply: no snow. | Source 4 (`tools/call` with `name` and `arguments`; `content`; `isError`). Leeds 10 °C cloudy is the lab's real output (short.yaml `term`); `isError: false` is on the card and left unspoken (video 4 picks it up). The reply bubble is illustrative (no model in the lab; in a real agent the result goes back to the model, which writes the reply: source 14). Board 4 ends with five things: the tiny map, the question with the menu, the model with its request, the client (with its marks) and the line to the server with the packet, the result card and reply. |
| 14 | **S5 In the lab** · The same call, typed | erase to the split layout: terminal (real) fills the right two-thirds and types `python3 -B call_tool.py weather-tools-get-weather '{"city": "Leeds"}'`, show "0-2,5-10"; [client] the tiny map bottom-left (the carried anchor), its client dot ringed; [tools/call] the method highlighted in the request line, and the packet rides the tiny map's line once more; [ten and cloudy] the `temperature_c` and `conditions` lines highlighted; [toy server] small chip "toy" on the tiny map's server dot; [prefix] `weather-tools` highlighted in the command and in the request line, with small text "→ video 2" | In the lab you play the client and send that tools/call yourself. Ten and cloudy again, invented by a toy server. The name has a prefix, weather-tools, which the next video explains. | Real terminal output (short.yaml `term`, source 27). The weather is deterministic from the city name (brief §5); the one-word tag "toy" is on the board and the fact is spoken. The lab call goes through ContextForge, hence the prefix (brief §6.5); the prefix is only named here, not explained (video 2 page 10 pays it). The first words pick up page 13's "the client's job". |
| 15 | **S6 Recap** · One clean picture | erase; [Same picture] the whole flow redrawn small and clean in one stroke: user bubble, agent with model and MCP client, the line, the weather server, the reply bubble; [tools/list] badge "1" on the line, near the client; [writes a request] badge "2" on the model chip; [tools/call] badge "3" on the line, under badge 1; [result] badge "4" on the return arrow into the client; [months ago] the torn calendar chip from board 1 reappears above the model, and the clock "now" beside the reply bubble | Same picture: tools/list fetches the menu, the model writes a request, tools/call runs it, the result comes back. That's how a model trained months ago told you today's weather. | Sources 1, 4. The badges carry only the numbers 1-4; the voice tells the steps in order without counting them aloud. The calendar and the clock close the gap opened on page 2. |
| 16 | S6 · Call to action | same board; [Open the lab] chip "Open the lab · See how tools reach an agent" under the picture; [Next] text "Next: 10 agents × 20 MCP servers" beneath it | Open the lab, See how tools reach an agent, and ask for Leeds yourself. Next time: ten agents, twenty MCP servers. | Pointer to video 2 (its hook numbers; "two hundred connections" is cut from the voice, video 2 says it itself in its first sentence). The lab's title is the one on-screen text the voice repeats, because it is a name the viewer has to search for. |

Left out on purpose (one idea per video): resources and prompts, the `initialize`
handshake (removed in the current spec and not visible in the lab), authorization, the two
transports, the USB-C analogy, the 1:1 client-to-server rule and the word "host" (both cut in
the third pass for pace; the concept page keeps them). Spoken since the third pass, because it
is the reason for a standard: a server built once works with any app that speaks MCP (page 6;
the lab's call still needs the server's address configured, said in NOTE). Dropped from the
voice in earlier cuts: the Larkfield story (the snow that never fell, Ollie), JSON-RPC as a
page of its own, and "content" as a spoken term (it is on the result card); "No snow" in the
reply bubble is the running example's payoff.

---

## Video 2. Why an MCP gateway?

- **id** `mcp-why-a-gateway` · **idea** one proxy in front of many MCP servers gives agents one
  address and the platform team one place for registration, credentials and records ·
  **running example** ten agents and twenty MCP servers, zoomed to three agents (Support,
  Billing, Ops) and five MCP servers (Weather, Calculator, Orders, Docs, Maps) on one board from
  the hook to the recap, then the lab · **story** none spoken (no Larkfield, no Maren) ·
  **voice** 455 words on 13 pages in 4 scenes, 3 erases, about 2:53 (variant B: 472 words).

Rewritten 2026-10-31 in the shape of the new Video 1 (docs/video-prompt.md, FLOW): four scenes,
each one board that keeps building; the board is erased only between scenes; every VOICE cell
picks up the previous page or ends with the question the next page answers. The 14-page cut it
replaces is in git history (commit d16e12a). ON SCREEN says what is added or changed at each
[cue] and where it sits on the existing board.

| # | SCENE / PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | **S1 Two hundred lines** · Hook | kicker "INTERVIEW QUESTION", title "10 agents, 20 MCP servers. How do you manage access?" (both at 0 s, top of the board); [Ten] ten blue agent dots in a column on the left; [twenty] twenty server dots in a column on the right; [wired] lines fan from every agent dot to every server dot from 0.3 s, dense, counter "10 × 20 = 200 connections" under them; [secret] a key icon beside the counter, "200 secrets"; [One box] at about 3 s a violet box drops into the middle, the lines re-route through it and the counter rolls to "10 + 20 = 30" | Ten AI agents, twenty MCP servers, each wired to all: two hundred connections, each with its own secret. One box in the middle, and it needs thirty. So where did the other hundred and seventy go? | Owner's hook A, with variant B's kicker and question as the title (2026-10-26); the first sentence keeps its meaning (two hundred connections, each with a secret; one box makes it thirty). Illustrative numbers: 10 × 20 = 200, 10 + 20 = 30, 200 − 30 = 170 (the viewer's sum, the KodeKloud "600 MB" shape). The box is named on page 4; "manage access" is paid on pages 7 (one credential per agent) and 8 (who asked). The spoken question is the scene's hand-off; it is answered by the end of scene 2. |
| 2 | S1 · Zoom in: three by five | same board; [lift] the violet box lifts off the board and the lines fall back to their direct fan; [frame] a dashed frame closes around three of the agent dots and five of the server dots, and everything outside it fades to grey; [named] inside the frame the dots take labels: agents "Support", "Billing", "Ops", servers "Weather", "Calculator", "Orders", "Docs", "Maps"; [Fifteen] the fifteen lines inside the frame redraw one by one, a small counter "3 × 5 = 15" under the frame | To see where, lift the box out and frame three agents, named Support, Billing and Ops, against five servers: weather, calculator, orders, docs, maps. Fifteen lines, redrawn one by one. | Illustrative names; weather and calculator mirror the lab's two servers, orders, docs and maps are labels only. 3 × 5 = 15. The zoom is a change to the hook board, not a new board: the 200 picture stays grey around the frame until the scene is erased. |
| 3 | S1 · What each line costs | same board; [address] the line Support → Weather thickens and takes two small chips, "address" and [credential] "credential · a secret proving who asks"; [Fifteen] a key chip "×5" appears on each of the three agents, and the counter under the frame becomes "15 credentials"; [sixth] a dashed sixth server joins the right column inside the frame, three dashed lines reach it, and each agent flashes "update" | Each line is an address and a credential, a secret proving who asks, kept in the agent. Fifteen across three agents, and a sixth server changes all three again. Who should hold them instead? | Illustrative. 3 × 5 = 15. "Credential" is defined here and reused in videos 3 and 4. Wired directly, a new server changes every agent; behind one endpoint it changes none (brief §3.1). The hand-off question is the one scene 2 answers. |
| 4 | **S2 One program in the middle** · An MCP gateway | erase; [three agents] blue nodes "Support", "Billing", "Ops" in a column on the left; [five servers] nodes "Weather", "Calculator", "Orders", "Docs", "Maps" in a column on the right; [MCP gateway] violet box "MCP gateway" in the centre, drawn empty, no lines yet; [proxy] label under the box "proxy · receives each call, passes it on" | Between the same three agents and five servers, one program: an MCP gateway. A gateway is a proxy: it receives each call and passes it to the owning server. How does it learn the servers? | Definition synthesised from sources 15-21 (brief §3.1). This board is kept to the end of scene 3; every row after this one adds to it. |
| 5 | S2 · Registration | same board; [operator] a small user icon above the gateway holding a card "name + address", an arrow from the card into the box; [unchanged] grey text "unchanged" on each server; [five lines] five lines draw from the gateway to the five servers, one by one; [tools/list] a "tools/list" packet rides each new line gateway → server, and a small menu card rides back | An operator registers each server once, by name and address, this card; the servers stay unchanged. The gateway connects to each, these five lines, and fetches each menu with tools/list. Where do five menus go? | Registration is the operator's act, not the server's (brief §1, §6.2); in the lab `seed_contextforge.py` does it. Sources 15, 22. |
| 6 | S2 · Catalogue and two faces | same board; [catalogue] the five menu cards slide into the box and merge into one list inside it, titled "catalogue"; [MCP client] label on the servers' side of the box "acts as an MCP client"; [three lines] three lines draw from the agents to the gateway; [one MCP server] label on the agents' side "looks like one MCP server"; [one reply] a "tools/list" packet rides Support → gateway, and a reply "every tool" rides back | Into one list, its catalogue. Towards the servers the gateway acts as an MCP client; towards the agents, wired to it with three lines, it looks like one MCP server. One tools/list from Support returns every tool in one reply. | Sources 15, 16, 17. ContextForge "runs as a fully compliant MCP server" (15) and reaches the real servers with the `mcp` SDK's own client (brief §10 A19). Its separate "MCP Registry" panel is not this catalogue (brief §1). |
| 7 | S2 · One address, one credential | same board; [one address] chip "mcp.larkfield.internal" on top of the gateway box, the three agent lines converging on it; [its own] one badge chip per agent, on its line; [five secrets] five key chips appear inside the gateway on its server side, one per line; [sixth] a dashed sixth server joins the right column with one dashed line from the gateway and nothing changes on the agents; [eight] counter under the board "3 + 5 = 8" | So each agent keeps one address, the gateway's, and one credential, its own badge. The five secrets move in here, and a sixth server is registered once, touching no agent. Three plus five: eight connections, not fifteen. | Illustrative address. 3 + 5 = 8, the same arithmetic as the hook's 10 + 20 = 30. Single endpoint: sources 15, 16, 17. Credential injection: 16, 17; ContextForge stores them encrypted (22). Cut from the voice: "token passthrough is forbidden" (10, 11). The lab has no upstream credentials. |
| 8 | S2 · One place to watch | same board; [that point] the gateway box pulses once; [row] a card "gateway log (illustration)" docks under the box with one row: `18:41 · Ops · orders-get-order · ok · 2400 ms`; rings land in turn on [tool], [time], [how long], [worked]; [who asked] ring on "Ops", with a thin line from the ring up to Ops's badge | Every call crosses that point, so the gateway writes a row for each: the tool, the time, how long it took, whether it worked and, read off the badge, who asked. Here, Ops, 2.4 seconds. | Logging: sources 16, 17, 19, 22. The lab log has no caller column (brief §5; said aloud on page 11). Rate limiting cut from the voice (ContextForge default: on, 100 requests a minute plus a burst of 20 on MCP paths, per IP and per user; the lab turns it off; brief §10 A16). |
| 9 | S2 · What it is not | same board; [no tools] a grey chip "runs the tools" beside the box is crossed out, with an arrow from it to the servers; [chooses none] a grey chip "chooses the tools" is crossed out, with an arrow to a small model chip inside Support; [AI gateway] a separate grey chip at the bottom edge, "AI gateway → language models", pointing off the board | Two things it is not. It runs no tools, the servers do; it chooses none, the model does. Nor an AI gateway: that carries calls to language models. What does one look like in the lab? | Brief §3.3. "Adds a hop, makes nothing faster" (brief §7.12) cut from the voice. The hand-off question opens scene 3. |
| 10 | **S3 In the lab** · One tools/list | layout split: the scene-2 board shrinks into the left third, unchanged; [ContextForge] the gateway box is relabelled "ContextForge"; terminal (real) on the right types `python3 -B call_tool.py --list`, show "0,5-10", clip 50; marks [its address] the url, [five tools] the five names; [prefix] the `weather-tools-` and `calculator-tools-` parts of the names highlighted, and a small label on the diagram "prefix = registered server's name" | In the lab the MCP gateway is ContextForge, IBM's open-source gateway, with two toy MCP servers registered. One tools/list to its address returns five tools, each carrying a prefix, the registered server's name, so two servers' tools never collide. | Real terminal output (short.yaml `tlist`). Source 15. The prefix pays the promise of video 1 page 14 ("which the next video explains"): ContextForge ADR-0011, slug + separator + original name, confirmed in the 1.0.10 source (23; brief §10 A8); the spec tells aggregating proxies to prefix (4). Video 3 reuses it with a reminder. |
| 11 | S3 · One row in the lab | terminal (real) `python3 -B call_tool.py calculator-tools-add '{"a": 17, "b": 25}'`; mark [forty-two] `42.0`; [view tab] chip "view tab: tool · time · success · response time" docked under the diagram's log card; [No caller] the "Ops" column of the illustration log greys out, text "no caller column" | Then calculator-tools-add, seventeen plus twenty-five, returns forty-two, and the view tab shows a new row: tool, time, success, response time. No caller column: every scripted lab call is the same admin identity. | Real output (short.yaml `tadd`); view columns from `workspace/view_service.py` (ContextForge's `tool_metrics`). Every scripted lab call is the same admin identity (manifest `X-Authenticated-User`). The row appears when ContextForge flushes its metrics buffer, up to 60 s after the call, stamped with the call time; record the take after that (brief §10 A7). |
| 12 | **S4 Recap** · Four changes on one picture | erase; [Focus] the scene-2 picture redrawn small and clean in one stroke: three agents, the gateway with its catalogue, five servers, the log card; [One] badge "1 registered once" on the server lines; [Two] badge "2 one address" on the address chip; [Three] badge "3 one credential" on the agents' badges, the five keys inside the gateway; [Four] badge "4 one row per call" on the log card; [thirty] the hook's counter returns above the picture: "10 + 20 = 30, not 200" | Focus on what changed. One, each server registered once. Two, one address per agent. Three, one credential each, the secrets behind the gateway. Four, one row per call. Ten agents, twenty servers: thirty connections, not two hundred. | The payoff of the hook (illustrative numbers): 10 + 20 = 30 against 10 × 20 = 200. The recap is the same diagram, numbered, not a list of chips. |
| 13 | S4 · Call to action | same board; [Open the lab] chip "Open the lab · See how tools reach an agent" under the picture; [Next] text "Next: should every agent see every tool?" beneath it, and the catalogue in the small gateway flashes once | Open the lab, See how tools reach an agent, and find your own calls in the view tab. Next: every agent sees every tool in that catalogue, including one that moves money. | Pointer to video 3 (its hook question is the on-screen text). |

### Hook variants (video 2)

Variant B, for an A/B cut on TikTok. Only pages 1 and 2 differ; pages 3-13 are the main
table's, unchanged, and page 3 builds on this variant's board exactly as on the main one.

| # | SCENE / PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | **S1 Two hundred lines** · Hook: the interview question | kicker "INTERVIEW QUESTION", title "10 agents, 20 MCP servers. How do you manage access?" (both at 0 s); [Ten] ten agent dots in a column on the left; [twenty] twenty server dots on the right; [two hundred] lines fan between them from 0.3 s, counter "10 × 20 = 200 connections"; [secret] key icons flicker along the lines at 1 s; [MCP gateway] at about 3 s a violet box labelled "MCP gateway" drops into the middle | A classic platform interview question, and the answer has a name: an MCP gateway, this violet box. Ten agents times twenty servers is two hundred connections, each with its own secret, before the box arrives. | Owner's hook B. The term comes first on purpose: it is the word people search for; its definition follows on page 4 as in the main cut. Illustrative numbers: 10 × 20 = 200. The first sentence keeps the owner's meaning (a classic question; the answer is an MCP gateway). |
| 2 | S1 · One box, then zoom in | same board; [through the box] the lines re-route through the box and the counter rolls to "10 + 20 = 30"; [lift] the box lifts out again and the lines fall back; [frame] a dashed frame closes around three agent dots and five server dots, the rest fades to grey; [named] labels "Support", "Billing", "Ops" and "Weather", "Calculator", "Orders", "Docs", "Maps"; [Fifteen] the fifteen lines inside the frame redraw one by one, counter "3 × 5 = 15" | Route every line through the box and ten plus twenty makes thirty, not two hundred. To see why, lift it out again and frame three agents, named Support, Billing and Ops, against five servers: weather, calculator, orders, docs, maps. Fifteen lines, redrawn one by one. | Illustrative. 10 + 20 = 30; 3 × 5 = 15. Page 3 of the main table follows on this board unchanged. |

---

## Video 3. Virtual servers: the right tools for each agent

- **id** `mcp-virtual-servers` · **idea** a virtual server is a named bundle of tools picked from
  the gateway's catalogue at its own MCP address, so each agent is offered only what it needs ·
  **running example** Support's bundle, support-tools, and the refund tool it leaves out,
  carried from the hook to the recap, then `toy-tools` in the lab · **story** none spoken (no
  Larkfield, no Priya, no Maren) · **voice** 437 words on 10 pages in 4 scenes, 3 erases,
  about 2:44.

Rewritten 2026-10-31 in the shape of the new Video 1 (docs/video-prompt.md, FLOW). The 14-page
cut it replaces is in git history (commit d16e12a). ON SCREEN says what is added or changed at
each [cue] and where it sits on the existing board.

| # | SCENE / PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | **S1 Support's menu** · Hook | kicker "INTERVIEW QUESTION", caption "MCP virtual servers", title "How do you give each AI agent only the tools it needs?" (all at 0 s, top of the board); [one catalogue] violet gateway box on the left holding a grey list "catalogue · 12 tools"; [three agents] blue nodes "Support", "Billing", "Ops" in a column on the right; [twelve] from 0.5 s a 12-chip menu draws beside each agent, fanned out of the catalogue; [issue_refund] at 1.5 s the bottom chip of Support's menu, `issue_refund`, turns red with a "£" stamp; [separate server] a crossed-out grey stack "one MCP server per agent" at the bottom edge | Each AI agent should see only the tools it needs, without a separate server for each one. Here one catalogue of twelve tools feeds three agents, every menu shows all twelve, and Support can see issue_refund. What should Support's menu look like? | Owner's hook B (2026-10-26); the first sentence keeps its meaning (only its own tools; no server per agent). Illustrative counts: 12 = the 5 lab-like tools plus 7 on the orders, docs and maps servers of video 2. The gateway and its catalogue are reminders of video 2. "INTERVIEW QUESTION" on a question an interviewer could plausibly ask. The spoken question is the hand-off; page 2 answers it within about 20 s. |
| 2 | S1 · A virtual server | same board; [Five] five chips of Support's menu glow, `get_weather`, `get_forecast`, `add`, `subtract`, `multiply`, and the other seven fade; [support-tools] a box "support-tools" is drawn around the five, between the catalogue and Support; [own address] chip `/servers/<id>/mcp` under the box; [one MCP server] the arrow Support → box takes the label "looks like one MCP server"; [outside] the red `issue_refund` chip, left outside the box, greys out | Five of the twelve. Pick the five Support needs into a box named support-tools, with its own address. That is a virtual server: a named pick of the catalogue's tools at its own address, and to Support it looks like one MCP server. issue_refund stays outside. | The answer within 20 s (hooks.md §6). ContextForge definition and endpoint: sources 15, 22; endpoint confirmed live in 1.0.10. Keep `<id>` as a placeholder: the id is a fresh uuid on every install (brief §10 A11, A18). Brief §7.9: a selection plus an address. The five tools match the lab; leaving one out is illustrative. |
| 3 | S1 · Why one chip matters | same board; [model] white model chip drawn inside Support; [wrong choice] a dashed arrow from the model to the greyed `issue_refund`, which flashes red once; [real money] the "£" stamp lands again; [weather tools and the calculator] a ring around the five chips in the box | Because the model inside Support picks from whatever menu it is given, a refund was one wrong choice away, and issue_refund moves real money. Support only ever needed the weather tools and the calculator. Who else needs a box, and can two boxes share a tool? | Tools are model-controlled: source 4. Illustrative: `issue_refund` belongs to the orders server (label only; no orders server in the lab). The Priya story of the old cut is dropped; the stakes are now the red chip itself. |
| 4 | **S2 Two boxes, one catalogue** · Billing's box | erase; [catalogue] the violet gateway box centre-left with the grey list "catalogue · 12 tools"; [support-tools] the box from scene 1 redrawn to its right with its five chips, Support beyond it; [billing-tools] a second box below it holding `add` and `issue_refund`, Billing beyond it; [both] one line from the catalogue's `add` entry forks to both boxes; [copies nothing] text under the two boxes "points at tools · copies nothing · runs nothing" | The catalogue again, support-tools beside it, and a second box for Billing, billing-tools, which does hold issue_refund, next to add. Add sits in both, one line from the same catalogue entry: a virtual server points at tools; it copies nothing and runs nothing. What does Support actually see? | Many-to-many `server_tool_association` in ContextForge, composite key `(server_id, tool_id)` (22; brief §10 A10). Schema evidence; the lab's single virtual server does not show it. This board is kept to the end of scene 3. |
| 5 | S2 · What the agent sees | same board; [Support sees] a column beside Support: "Support sees · one address · names · descriptions · input schemas"; [gateway knows] a column inside the gateway box: "gateway knows · owner server · original name · server address · credential" | Support sees one address and, per tool, the name, description and input schema from the first video. Only the gateway knows the rest: the owner server, the original name, its address and the credential. So how does a call from Support find the weather server? | ContextForge keeps `original_name` and the gateway slug (23). Servers cannot see into each other (source 2). "Credential" as defined in video 2. |
| 6 | S2 · Routing one call | same board; [weather-tools-get-weather] a packet "weather-tools-get-weather · Leeds" rides Support → support-tools → gateway; [prefix] on the gateway the name splits into "weather-tools" (labelled "prefix · registered server") and "get_weather" (labelled "original name"); [looked up] ring on the gateway-knows column; [get_weather] a cyan node "Weather MCP server" appears at the right edge and a packet "get_weather · Leeds" rides from the gateway to it; [never sees] Support's view greys out beyond its own address | Support calls weather-tools-get-weather for Leeds. The gateway splits the name: weather-tools, the prefix from the last video, names the server; get_weather is the original name. Once looked up, the call goes on to the weather server as get_weather, Leeds. Support never sees where. | Source 23 (invocation uses `original_name`); prefix rule confirmed in the 1.0.10 source (brief §10 A8). The prefix was explained in video 2 page 10; here it is a reminder. Not spoken: inside a virtual server ContextForge 1.0.10 also accepts the bare original name (`add` worked live; brief §10 A9). The two-tools-called-search pages of the old cut are dropped. |
| 7 | S2 · A menu is not a lock | same board; [credential] badge on Support "credential: support-tools only"; [directly] a dashed arrow from Support straight to a grey node "Orders MCP server" carrying `issue_refund`, with a red cross on it; [shorter menu] text under Support "shorter menu ≠ lock"; [lab] small text "next: the lab" | One warning. Leaving issue_refund out only shortens Support's menu. It is a lock only if Support's credential is limited to that virtual server and Support cannot reach the orders server directly, this dashed line. A shorter menu is not a lock. What does the lab leave out? | ContextForge server-scoped tokens (24). Brief §3.3, §7.10. Lab evidence: the lab's own ContextForge also lists every tool at `/mcp` and answers calls that carry no identity at all (`AUTH_REQUIRED=false`), so a tool left out of `toy-tools` would still be reachable there (brief §10 A11, A17, S4). |
| 8 | **S3 In the lab** · toy-tools | layout split: the scene-2 board shrinks into the left third, unchanged; terminal (real) on the right types `python3 -B call_tool.py --list`, show "0,5-10"; marks [toy-tools] the "virtual server 'toy-tools'" line, [five] the five names, [prefix] the `weather-tools-` and `calculator-tools-` parts; [same admin] text under the terminal "every scripted call: admin@example.com"; [not the lock] the diagram's dashed direct line and badge grey out | Nothing. The lab's virtual server, toy-tools, holds all five tools of both toy servers, each with its prefix, and every scripted call carries the same admin identity. The lab shows the menu, not the lock. | Real output (short.yaml `tlist`); trusted-proxy header in manifest (brief §2.9). "Every scripted call" is exact: ContextForge would also accept a header-less call as an anonymous, public-only caller, and all five tools are public (brief §10 A17). The view tab lists servers, tools and the virtual server (`view_service.py`). |
| 9 | **S4 Recap** · Four facts on one picture | erase; [Focus] the scene-2 picture redrawn small and clean in one stroke: catalogue, support-tools, billing-tools, Support with its badge, the weather server; [One] badge "1 every tool" on the catalogue; [Two] badge "2 a named pick, own address" on support-tools; [Three] badge "3 points, copies nothing" on the forked `add` line; [Four] badge "4 the details agents never see" on the gateway-knows column; [not a lock] the dashed direct line with its red cross | Focus on what just happened. One, the catalogue holds every tool. Two, a virtual server is a named pick at its own address. Three, it points at tools, copying nothing. Four, the gateway keeps what agents never see; and a shorter menu is not a lock. | The recap is the same diagram, numbered, not a list of chips. |
| 10 | S4 · Call to action | same board; [Open the lab] chip "Open the lab · See how tools reach an agent" under the picture; [Next] text "Next: 200 OK, and still wrong" beneath it | Open the lab, See how tools reach an agent, and count the tools toy-tools offers. Next: a tool call that comes back 200 OK with a failure written inside it, and the one line of code that misses it. | The count is the lab's first question (`learn/questions.yaml`). Pointer to video 4. |

---

## Video 4. When a tool fails

- **id** `mcp-when-a-tool-fails` · **idea** HTTP 200 only says the message arrived; MCP reports
  failure in the body, as a tool execution error or as a protocol error, and the agent must
  read it · **running example** one forecast call for Leeds that came back 200 with `isError`,
  followed from the line of code that missed it, down the chain and back, then the lab's
  `does-not-exist` call · **story** Tomas, the staff engineer, pulls the trace (one line, scene
  2) · **voice** 458 words on 13 pages in 4 scenes, 3 erases, about 2:54.

Rewritten 2026-10-31 in the shape of the new Video 1 (docs/video-prompt.md, FLOW). The 15-page
cut it replaces is in git history (commit d16e12a). ON SCREEN says what is added or changed at
each [cue] and where it sits on the existing board.

| # | SCENE / PAGE | ON SCREEN | VOICE | NOTE |
|---|---|---|---|---|
| 1 | **S1 The line** · Hook | kicker "DEBUGGING QUESTION", caption "MCP · when a tool fails", title "Why does your AI agent make things up when a tool fails?" (all at 0 s, top of the board); [This line] code card `if resp.status == 200: return resp.result` in the centre, a green tick landing on `200` at 0.5 s; [reply] a reply card slides under it at 1.5 s: chip `HTTP 200`, line `"isError": true` in red; [snow] chat bubble on the right "Expect heavy snow in Leeds." with the stamp "GUESS" | This line is why your AI agent makes things up when a tool fails. You have probably written it. Under it, a reply, 200 with isError true, and the snow invented from it. What did that 200 promise? | Owner's hook A (2026-10-26), first sentence verbatim. The code card is an illustration of a common pattern, from no real codebase. The topic is named on the board at 0 s. The spoken question is the hand-off; page 2 answers it. |
| 2 | S1 · Envelope and body | same board; [envelope] an envelope outline is drawn around the reply card's `HTTP 200` chip, label "delivered · answered"; [body] the card opens wide below it: `"result": {"isError": true, "content": text "Weather service timed out"}`; [isError] red ring on `isError`; [never reads] an arrow from the code card's `resp.status == 200` to the envelope only, and a grey cross between the code and the body | Only that the request was delivered and answered: 200 is the envelope. Whether the tool worked is in the body, next to isError: weather service timed out. This line never reads the body. Where did it come from? | The payoff within 20 s (hooks.md §6). Lab-real pattern (`does-not-exist` returns 200 with `isError`). Under the 2026-07-28 spec some protocol errors change the HTTP status (source 8), so the rule taught is "200 is not proof", never "errors are always 200". The message text is illustrative. |
| 3 | **S2 Follow the call** · The chain | erase; [Tomas] small user node "Tomas · staff engineer" top-left; [agent] blue box "Agent" on the left with the code card small inside it; [MCP gateway] violet box in the centre; [weather MCP server] cyan node on the right; [get_forecast] a packet "get_forecast · Leeds" rides agent → gateway → server | Tomas, the staff engineer, pulled the trace: the agent had called get_forecast for Leeds through the MCP gateway, on to the weather MCP server. What happened there? | Illustrative: the lab has no trace view beyond the view tab. Gateway as proxy: video 2. Tomas is the only character spoken in the set; the board is kept to the end of scene 2. |
| 4 | S2 · The far end | same board; [outside service] a cloud node past the server at the right edge, "outside weather service", with a dashed link from the server; [timed out] a clock icon and a red chip "timed out" on the cloud; [far end] a red break mark on the dashed link | It asked an outside service for real data, this cloud past the server, which did not answer in time: timed out. The chain broke at its far end. What came back? | Illustrative: the lab's weather server calls no outside service and never times out. |
| 5 | S2 · The reply | same board; [result] a packet rides back server → gateway → agent along the same lines, with a green chip `HTTP 200` on it; [isError] the reply card from scene 1 docks under the agent: `"result": {"isError": true, "content": text "Weather service timed out"}`; [tool execution error] label under the card | A normal result rides back along the same lines, 200 on the envelope: isError true, weather service timed out. The specification calls this a tool execution error: the tool ran, failed, said so. Did the model read it? | Shape: source 5 (API failures are tool execution errors). The message text is illustrative. |
| 6 | S2 · What went wrong | same board; [the line] the code card inside the agent enlarges; [200] ring on `200`; [unread] the docked card's `isError` line greys out with the label "unread"; [model] white model chip inside the agent, an arrow from the code card to it carrying "result"; [guessed] the chat bubble "Expect heavy snow in Leeds." with "GUESS" returns beside the model | No. The line took 200 as proof and passed the result on unread, so the model saw a weather result with no weather and guessed: heavy snow. Is every failure like this? | Illustrative. The spec says clients SHOULD pass tool execution errors to the model (5). |
| 7 | **S3 Two shapes** · The other kind | erase; [Left] the Leeds reply card redrawn on the left, headed "tool execution error · result with isError"; [Right] on the right a request card `"method": "tools/calll"` and under it `"error": {"code": -32601, "message": "Method not found: tools/calll"}`, headed "protocol error · error object"; [no result] text "no result" under the right card; small unspoken text "2026-07-28 spec: some protocol errors also get 400/404" | No; failure has two shapes. Left, the reply we followed. Right, a protocol error: the server could not handle the request itself, a misspelt method, tools/calll, and replies with an error object, code and message, no result. | JSON-RPC code `-32601` (13). Lab-real: ContextForge 1.0.10 answers `tools/calll` on `/servers/<id>/mcp` with HTTP 200 and exactly this error object, no result (captured 2026-10-25; brief §10 A2). `call_tool.py` cannot send a custom method, so it is not a learner step. Under 2026-07-28 the status would be 404 (8); that nuance is the small text, kept unspoken by design. This board is kept to the end of scene 3. |
| 8 | S3 · Which is which | same board; [failed API] a list under the left card: "failed API · bad input · business rule", with "written for the model"; [unknown tool] a list under the right card: "unknown tool · malformed request", with "for the agent's code" | The specification sorts them. A failed API, a bad input or a broken rule are tool execution errors, written for the model. An unknown tool or a malformed request are protocol errors, for the agent's code. Which does the lab show? | Source 5 (2026-07-28; input validation moved to tool execution errors in 2025-11-25), re-checked 2026-10-25 (brief §10 B1). Lab: `calculator-tools-add` with `"a": "x"` returns `isError: true` (brief §10 A4). The spec's third protocol item, "server errors", is left off the board so nothing unspoken is drawn. |
| 9 | S3 · In the lab | layout split: the two cards shrink into the left third; terminal (real) on the right types `python3 -B call_tool.py does-not-exist '{}'`, show "1-4"; marks [HTTP 200] `HTTP 200`, [isError] `"isError": true`, [Tool not found] `Tool not found: does-not-exist`; [left] ring on the left card; [right] the right card's heading flashes | In the lab, a call to a tool named does-not-exist returns HTTP 200, isError true, and the text Tool not found: the left shape, though the specification files an unknown tool on the right. | Real output (short.yaml `terr`), re-captured 2026-10-25 unchanged; graded by `answers-match-the-gateway`. This call adds no row to the view tab (brief §10 A5). |
| 10 | S3 · Lab versus specification | same layout; [ContextForge] chip under the left card "ContextForge 1.0.10 → isError"; [MCP Python SDK] small text between the cards "MCP Python SDK: any failure in a tool → isError"; [server] chip under the right card "spec: unknown tool → protocol error"; [read the body] a chip across both cards | ContextForge answers left because the MCP Python SDK beneath it turns any failure inside a tool into an isError result. The shape depends on the server; the rule does not: read the body. And then? | Sources 5, 25, 26 (brief §2.6), confirmed with the lab's pinned SDK, `mcp` 1.30.0 (brief §10 A1). Kept so a careful viewer does not learn the wrong rule from the lab. |
| 11 | **S4 A careful agent** · The line rewritten | erase; [Rewrite] the scene-2 chain redrawn small: agent, gateway, server, cloud, the reply docked under the agent, and the code card inside the agent rewritten as two branches; [error object] first branch from the reply: "error object → agent's code: fix the request", with a `tools/list` chip; [isError] second branch: "isError → the text goes to the model"; [fix an input], [retry], [admit] three leaves under it; [Sorry] chat bubble beside the model "Sorry, no forecast for Leeds right now.", and the "GUESS" bubble crossed out | Rewrite the line to branch. On an error object the agent's code steps in, say to fetch the menu again. On isError, the text goes to the model: fix an input, retry, or admit it. Sorry, no forecast for Leeds right now. | Protocol errors are for code, not the model (source 5: "less likely to result in successful recovery"); clients SHOULD give tool execution errors to the model (5). "Fetch the menu again" and "retry" are our advice, not spec rules. The honest bubble is illustrative (no model in the lab). |
| 12 | S4 · Recap | same board; [Focus] the chain pulses once; [One] badge "1 status: delivered" on the `HTTP 200` chip at the agent; [Two] badge "2 body: did it work" on the reply card; [Three] badge "3 two shapes" over the two branches; [Four] badge "4 read, then answer" on the model and its honest bubble | Focus on what just happened. One, the status said it arrived. Two, the body said whether the tool worked. Three, two shapes: isError or an error object. Four, read it, and the agent tells the truth. | The recap is the same chain, numbered, not a list of chips. |
| 13 | S4 · Call to action | same board; [Open the lab] chip "Open the lab · See how tools reach an agent" under the chain; [the set] four small chips "MCP server · MCP gateway · virtual server · failed call" | Open the lab, See how tools reach an agent, and call a tool that does not exist. That closes the set: MCP server, MCP gateway, virtual server, failed call. | Last video of the set; no pointer. |

---

## Read-aloud check (done, redone 2026-10-31 for the four scene cuts)

Checked by script on the tables above (every [cue] in ON SCREEN appears word for word in its
VOICE cell, case and punctuation ignored, the V2 variant table included) and by reading each
video aloud once.

- **Narrated questions.** Each page 1 speaks its hook question once, as hooks.md §7 check 6
  allows (V1 "where did that answer come from?", V2 "where did the other hundred and seventy
  go?", V3 "What should Support's menu look like?", V4 "What did that 200 promise?"), and
  every scene ends on a hand-off question the next page's picture answers (V1: "Who's
  involved?", "What travels along it?", "Who picks?"; V1's boards 5 and 6 instead open by
  picking up the previous board's last words, "In the lab you play the client", "Same
  picture", because board 4 ends on the payoff, "no snow", and a question there would
  undercut it; V2: "Who should
  hold them instead?", "How does it learn the servers?", "Where do five menus go?", "What does
  one look like in the lab?"; V3: "Who else needs a box, and can two boxes share a tool?",
  "What does Support actually see?", "What does the lab leave out?"; V4: "Where did it come
  from?", "What came back?", "Did the model read it?", "Is every failure like this?", "Which
  does the lab show?", "And then?"). No question is answered in the same breath.
- **Page 1** of every video names the topic on the board at 0 s (caption "What is MCP?", title
  "10 agents, 20 MCP servers…", caption "MCP virtual servers", caption "MCP · when a tool
  fails") and anchors on something real: ChatGPT, 10 × 20 = 200, a twelve-tool catalogue, a
  line of code. No fictional company, person, date or place is spoken on any page 1; the only
  character spoken in the set is Tomas (V4 #3).
- **First spoken sentences** keep the owner's approved meaning: V1 "Ask ChatGPT whether it's
  snowing in Leeds right now, and it can tell you, even though its training ended months ago.",
  V2 "Ten AI agents, twenty MCP servers, each wired to all: two hundred connections, each with
  its own secret." (variant B: "A classic platform interview question, and the answer has a
  name: an MCP gateway, this violet box."), V3 "Each AI agent should see only the tools it
  needs, without a separate server for each one.", V4 "This line is why your AI agent makes
  things up when a tool fails." (verbatim). The kickers and titles are the owner's, verbatim.
- **Payoff by page 2:** V1 "the model cannot know; the app calls a tool; MCP is the standard way
  to plug tools in", V2 the 10 × 20 zooms to 3 × 5 (the gateway is named on page 4, about
  40 s, after the cost of the lines is shown), V3 "a virtual server is a named pick of the
  catalogue's tools at its own address", V4 "200 is the envelope; isError is in the body; this
  line never reads it".
- **Terms defined at first use,** after the need is shown: language model (V1 #2), tool and
  MCP (V1 #3), agent (V1 #4), MCP server (V1 #5), MCP client (V1 #7; "host", the 1:1 rule and
  the expansion "Model Context Protocol" are no longer spoken since the third pass), JSON-RPC,
  tools/list and menu (V1 #8), input schema (V1 #10), tools/call and
  result (V1 #13; "content" is on the result card and no longer spoken), credential (V2 #3), MCP gateway and proxy (V2 #4), register
  (V2 #5), catalogue and the two faces (V2 #6), AI gateway (V2 #9), prefix (V2 #10, paying
  V1 #14's promise), virtual server (V3 #2), tool execution error (V4 #5), protocol error and
  error object (V4 #7). Reused with a reminder, not redefined: gateway and catalogue (V3 #1),
  prefix (V3 #6), MCP gateway (V4 #3).
- **Lengths.** VOICE cells are 14-48 words (V1 14-34, V2 30-41, V3 35-48, V4 27-42); totals
  V1 434, V2 458 (variant B 472), V3 437, V4 458; every video is under three minutes at 170
  words a minute (V1 2:33 spoken, about 2:50 with its fifteen page breaks and three mid-page
  pauses, about 153 words a minute overall with the silences counted; V2-V4 2:44 to 2:54).
  V1's third pass aimed at 380-410 words and landed at 434: the six reasons the owner asked
  for cost about 95 words and the cuts recovered about 90; the words that would reach 410 are
  listed in the change log for the owner to decide. The two over the 440 target (V2, V4) are the two with
  thirteen pages; the cut that would bring each under 440 is V2 #9 (what it is not) and
  V4 #10 (lab versus specification), both kept on purpose.
- **Voice.** No jokes, no "okay/so, here's the thing", no narrator "I" (V4's honest bubble is
  "Sorry, no forecast for Leeds right now." for that reason), no "let's dive in", no lists of
  three for rhythm: the three-item lists are real sets (three agents, the spec's own error
  lists, the recap's numbered steps). The voice names what is being drawn while it is drawn
  ("this card", "these five lines", "this cloud past the server", "this dashed line"), so no
  board holds the screen on text alone. Past tense for the V4 trace; present tense for the
  hooks, the mechanism, the lab and the calls to action. V1's second pass (2026-10-31) is
  written in the whiteboard register the owner asked for: "you" throughout, contractions
  (it's, can't, doesn't, that's), one aside ("That's the whole trick."), no counted lists (the
  recap tells the four steps in order while the badges 1-4 appear, and never says "one, two"),
  and no on-screen label read aloud, the one exception being the lab's title in the call to
  action, which is a name the viewer has to search for. Every V1 board was checked against
  the owner's two notes: at most five things, and nothing written that the voice also says.
  The third pass adds the owner's third note: every surprising line carries its reason (V1 #2,
  #6, #7, #9, #10, #12), spoken the way a colleague would give it ("it can't, remember",
  "That's deliberate"), never as a narrated question answered in the same breath, and a
  `pause:` follows each key one.
- **"Tool gateway"** appears in no VOICE or ON SCREEN cell. "MCP gateway" is the term throughout.
- **Arithmetic:** 10 × 20 = 200 direct connections and 10 + 20 = 30 through a gateway, so
  200 − 30 = 170 fewer (V2 #1, #12, variant B); 3 × 5 = 15 direct and 3 + 5 = 8 through the
  gateway (V2 #2, #3, #7); 15 credentials = 3 agents × 5 servers (V2 #3); twelve catalogue
  tools, five picked into support-tools, seven left out, two in billing-tools with `add` shared
  (V3); five lab tools (2 weather + 3 calculator); 17 + 25 = 42.0; Leeds → 10 °C cloudy;
  the log row's 2400 ms is spoken as 2.4 seconds (V1 no longer speaks the `days` default of 3).
- **Lab-real versus illustrative** is stated in every NOTE and, where it matters, aloud: the
  lab log has no caller column (V2 #11), toy-tools leaves nothing out and every scripted call
  is the same admin identity (V3 #8), ContextForge's isError for an unknown tool is SDK
  behaviour and the spec files it as a protocol error (V4 #9-10).

## Owner review summary

One line per board page: the one thing the page teaches.

**Video 1. What is MCP?** (six boards, one question each, 2026-10-31 third pass: every
surprising line carries its reason, and a pause follows each key one)

Board 1, the frozen model (the hook board; up to five things):
1. Hook — ChatGPT's training ended months ago; ask whether it's snowing in Leeds and it knows; where did that come from?
2. The gap — the language model writes the reply but can't know; what it learned stops at the calendar, and it can't go and look, because a model only reads and writes text; alone it'd be guessing. (pause)
3. A tool — the app around it asks a tool, a function in another program that fetches live data; MCP is the standard way to plug one in; who's involved?

Board 2, who's involved (anchor: the Leeds question chip, top-left):
4. The agent — the program receiving the question; keeps the conversation, does what the model decides; the model sits inside it.
5. The MCP server — another program with two functions, get_weather and get_forecast; each is a tool; the program is an MCP server.
6. Why a standard — build it once and any app that speaks MCP can use it, instead of wiring every tool into every app. (pause)
7. The MCP client — the model doesn't talk to the server directly (it can't, remember); the MCP client inside the agent holds the connection; what travels along it?

Board 3, asking for the menu (anchor: a tiny map of agent → line → server, top-left):
8. tools/list — small JSON messages, JSON-RPC; tools/list is the agent asking what's on offer.
9. The menu — two tools, each a name and a short description, written for the model, not you, because the model picks a tool by reading it. (pause)
10. The input schema — the third part, what the tool needs: get_weather wants a city; so the model knows what to fill in and the server can check what arrives; who picks? (pause)

Board 4, making the call (anchor: the tiny map):
11. The model picks — given your question and the menu, it answers "call get_weather, city Leeds".
12. Why the model only writes — it wrote the request and ran nothing (pause); that's deliberate, it keeps the app in control: it can show you the request and let you say no, hold any keys, and log what was called.
13. tools/call and the result — running it is the client's job: tools/call down the line, get_weather runs, the result says Leeds, ten degrees, cloudy; the model writes the reply: no snow.

Board 5, in the lab (anchor: the tiny map, bottom-left; the terminal is large):
14. The same call, typed — you play the client and send that tools/call yourself; ten and cloudy again, invented by a toy server; the name has a prefix the next video explains.

Board 6, recap (the flow redrawn small and clean, badges 1-4):
15. One clean picture — tools/list fetches the menu, the model writes a request, tools/call runs it, the result comes back; a model trained months ago told you today's weather.
16. Call to action — open the lab and ask for Leeds; next time, ten agents, twenty MCP servers.

**Video 2. Why an MCP gateway?** (four scenes, 2026-10-31)

Scene 1, two hundred lines (the hook board keeps building):
1. Hook — ten agents, twenty MCP servers, each wired to all: two hundred connections and secrets; one box makes it thirty; where did the other hundred and seventy go?
2. Zoom in: three by five — the box lifts out; a frame around three named agents and five named servers; fifteen lines redrawn one by one.
3. What each line costs — every line is an address plus a credential kept in the agent; fifteen across three agents; a sixth server changes all three; who should hold them instead?

Scene 2, one program in the middle (one diagram, every step added to it):
4. An MCP gateway — one program between the same agents and servers; a proxy receives each call and passes it to the owning server; how does it learn the servers?
5. Registration — an operator registers each server once by name and address; the servers stay unchanged; the gateway draws five lines and fetches each menu with tools/list.
6. Catalogue and two faces — five menus become one catalogue; an MCP client towards the servers, one MCP server towards the agents; one tools/list returns every tool.
7. One address, one credential — one address and one badge per agent; the five secrets move into the gateway; a sixth server touches no agent; three plus five is eight.
8. One place to watch — every call crosses one point, so one row per call: tool, time, how long, worked, and who asked, read off the badge.
9. What it is not — runs no tools, chooses none, and is not an AI gateway; what does one look like in the lab?

Scene 3, in the lab (the diagram stays beside the terminal):
10. One tools/list — ContextForge with two toy servers; five tools in one reply, each with a prefix, the registered server's name (the promise from video 1).
11. One row in the lab — 17 + 25 = 42.0 appears in the view tab; no caller column, because every scripted call is the same admin identity.

Scene 4, recap (the same diagram, numbered):
12. Four changes on one picture — 1 registered once, 2 one address, 3 one credential, 4 one row per call; ten plus twenty is thirty, not two hundred.
13. Call to action — find your own calls; next, every agent sees every tool, including one that moves money.

Variant B (A/B cut): 1. Hook: the interview question — the answer has a name, an MCP gateway, this violet box; two hundred connections before it arrives. 2. One box, then zoom in — through the box, thirty; lift it out and frame three by five, fifteen lines. Then page 3 on, on the same board.

**Video 3. Virtual servers** (four scenes, 2026-10-31)

Scene 1, Support's menu (the hook board keeps building):
1. Hook — each agent should see only the tools it needs, without a server per agent; one catalogue of twelve feeds three agents and every menu shows all twelve, issue_refund included; what should Support's menu look like?
2. A virtual server — five of the twelve, in a box named support-tools with its own address; a named pick of the catalogue at its own address, one MCP server to Support; issue_refund stays outside.
3. Why one chip matters — the model picks from whatever menu it is given, so a refund was one wrong choice away; Support only needed the weather tools and the calculator; who else needs a box?

Scene 2, two boxes, one catalogue (one diagram, every step added to it):
4. Billing's box — billing-tools holds issue_refund and add; add sits in both boxes from one catalogue entry; a virtual server points at tools, copies nothing, runs nothing.
5. What the agent sees — Support sees one address, names, descriptions, input schemas; only the gateway knows owner, original name, address, credential.
6. Routing one call — weather-tools-get-weather for Leeds splits into the prefix (video 2's reminder) and the original name; the call goes on as get_weather; Support never sees where.
7. A menu is not a lock — leaving a tool out only shortens the menu; a lock needs a credential limited to that virtual server and no direct route; what does the lab leave out?

Scene 3, in the lab (the diagram stays beside the terminal):
8. toy-tools — nothing left out: all five tools with their prefixes; every scripted call is the same admin identity; the lab shows the menu, not the lock.

Scene 4, recap (the same diagram, numbered):
9. Four facts on one picture — 1 every tool, 2 a named pick at its own address, 3 points and copies nothing, 4 the details agents never see; a shorter menu is not a lock.
10. Call to action — count the tools toy-tools offers; next, a call that came back 200 OK with a failure inside it.

**Video 4. When a tool fails** (four scenes, 2026-10-31)

Scene 1, the line (the hook board keeps building):
1. Hook — `if resp.status == 200: return resp.result` is why an agent makes things up when a tool fails; under it a 200 reply with isError true and the snow invented from it; what did that 200 promise?
2. Envelope and body — only that the request was delivered and answered; whether the tool worked is in the body next to isError; this line never reads the body; where did it come from?

Scene 2, follow the call (one chain, every step travels along it):
3. The chain — Tomas pulls the trace: get_forecast for Leeds, agent to MCP gateway to weather MCP server; what happened there?
4. The far end — the server asked an outside service, which timed out; the chain broke at its far end; what came back?
5. The reply — a normal result back along the same lines, 200 on the envelope, isError true; the specification's tool execution error; did the model read it?
6. What went wrong — the line took 200 as proof and passed the result on unread; the model saw no weather and guessed snow; is every failure like this?

Scene 3, two shapes (one board, the lab beside it):
7. The other kind — left, the reply we followed; right, a protocol error for a misspelt method, tools/calll: an error object, code and message, no result.
8. Which is which — failed API, bad input, broken rule are tool execution errors for the model; unknown tool and malformed request are protocol errors for the code; which does the lab show?
9. In the lab — does-not-exist returns 200, isError true, Tool not found: the left shape, though the spec files an unknown tool on the right.
10. Lab versus specification — ContextForge answers left because the MCP Python SDK turns any failure in a tool into isError; the shape depends on the server, the rule does not: read the body.

Scene 4, a careful agent (the same chain, numbered):
11. The line rewritten — on an error object the code steps in, say by fetching the menu again; on isError the text goes to the model: fix an input, retry, or admit it.
12. Recap — 1 status: it arrived, 2 body: did it work, 3 two shapes, 4 read it and tell the truth.
13. Call to action — call a tool that does not exist; the set is complete: MCP server, MCP gateway, virtual server, failed call.

## Change log

**Video 1 given its reasons and a calmer pace, 2026-10-31, third pass** (against commit
bb518b1). The owner watched the six-board cut and wrote: "I feel you rushed a bit some parts,
and also sometimes you are expected to give an explanation but you don't. For example when you
said the request doesn't come from the model, why is that? Why was that choice made, etc." No
research fact changed and no new source was needed: sources 1 and 14, already in the list, were
re-read on 2026-10-31 and the lines now quoted in NOTE were added to their entries. The approved
kicker, title, hook line, six boards, show-don't-read rule, whiteboard voice, lab-real output
and call to action are kept.

- **Reasons added,** each in the same breath or the next sentence, each sourced in NOTE: why
  the model can't look the weather up itself (#2: it only reads and writes text, so it fetches
  nothing; brief §1, source 14); why a standard at all (#6, a new page: build a server once and
  any app that speaks MCP can use it, instead of wiring every tool into every app; source 1);
  why the model doesn't talk to the server (#7: "it can't, remember"); why the menu carries
  descriptions (#9: the model picks a tool by reading them; brief §7.11, source 14); why an
  input schema (#10: the model knows what to fill in, the server can check what arrives;
  source 4, lab-real in brief §10 A4); and the owner's example, why the model only writes the
  request while the app runs it (#12, a new page: it keeps the app in control, so it can show
  you the request and let you say no, hold any keys, and log what was called; source 4's human
  in the loop, show-inputs and log-usage duties, and the client holding the credential, brief
  §2.9, source 10). Reasons not supported by the brief were left out: "the model can be swapped
  without rewiring the tools" (the brief only says MCP does not dictate how applications use
  LLMs, §2.1) and "the app checks the arguments against the schema" (the spec puts input
  validation on the server, not the client).
- **Pace.** A `pause: 0.8` after each key reason (#2 before "Alone", #6 and #9 at the page
  end, #10 before "Who picks?", #12 after "ran nothing"), on top of the 0.8 s page breaks; the
  convention is recorded in "How to read these tables". Two pages were added (why a standard,
  why the model only writes), so 14 pages become 16 and 13 page breaks become 15; the six
  boards and their anchors are unchanged (board 2 trades the host label for two faded "any
  app" boxes; board 4's client box carries three small marks).
- **Cut to make room:** "the spec calls the agent the host" and its label (the glossary asked
  for one mention in video 1; dropped at the owner's pace note, the concept page keeps it);
  "exactly one server"; `get_forecast`'s `days` default and its schema line; JSON-RPC's
  request-and-reply shape (one plain mention stays; video 4 draws the error object itself);
  "MCP means Model Context Protocol"; "two hundred connections" in the pointer (video 2 says
  it in its first sentence); and the small words "fresh board", "cleaned up", "name and
  arguments", "the code holding".
- **Length.** 429 → 434 words on 16 pages (cells 14-34 words), about 2:33 spoken and about
  2:50 with the pauses, about 153 words a minute overall with the silences counted; under three
  minutes, but over the 380-410 word target set for this pass: the six reasons cost about 95
  words and the cuts recovered about 90. To reach 410 without losing a reason the owner can
  drop, in this order: "That's the whole trick." (#3, 4 words), "Alone, it'd be guessing."
  (#2, 4), "it can't, remember" (#7, 3), "so the model sits inside it" (#4, 6), "which the next
  video explains" → "for the next video" (#14, 1), and page 8 folded into page 9 with JSON-RPC
  moved to NOTE (6). All six are voice the second pass was praised for, so they are kept until
  the owner chooses.
- **Rules.** docs/video-prompt.md FLOW gains two rules: every claim a newcomer would question
  gets its reason, in the same breath or the next sentence (why, not just what); calm pace,
  about 150 words a minute overall, pause after each key idea, cut details before you rush.
- Videos 2-4 are unchanged; V2 #10's NOTE now points at V1 page 14 for the prefix promise.

---

**Video 1 split into six boards and rewritten in a spoken register, 2026-10-31, second pass**
(against commit b68fa89). The owner watched the rebuilt four-scene Video 1 and gave two notes:
"there is a lot of context in one window, maybe we need to erase the board and create another"
(the scene-2 board ended with the agent, the model, the MCP client, the host label, a JSON-RPC
caption, the server with two tools, the menu card with schemas, the model's request and several
small explanatory labels all at once), and "sometimes the copy is still robotic, sometimes you
are just reading what is written on the screen". No research fact or source changed; no claim
was added; the approved kicker, title, hook line, terms, lab-real output and call to action are
kept.

- **Boards.** The big scene 2 becomes three boards, each answering one question with at most
  five things: board 2 who's involved (agent with the model and the MCP client inside, the
  line, the weather MCP server with two tools, the host label), board 3 asking for the menu
  (the line drawn large with "JSON-RPC" on it, the tools/list packet, the menu card, the
  input-schema zoom), board 4 making the call (question and menu into the model, the request
  card, tools/call riding to the server, the result card, the reply bubble). Board 1 (the hook),
  board 5 (the lab, terminal large) and board 6 (recap) complete the six. 13 pages in 4 scenes
  with 3 erases become 14 pages on 6 boards with 5 erases. Each erase has a spoken bridge
  ("Same Leeds question, fresh board", "Small JSON messages", "The model does", "In the lab you
  play the client", "Same picture, cleaned up") and one carried-over anchor: the Leeds question
  chip on board 2, a tiny map of agent → line → server in a corner of boards 3, 4 and 5. The
  "Board plan" list under the header records each board's question, things and anchor.
- **Screen versus voice.** Removed from the board every caption that duplicated the narration:
  "language model · reads text, writes text", "alone: a guess", "training data ends: months
  ago", "keeps the conversation · carries out what the model decides", "tool · a named
  function", "MCP server · offers tools", "MCP · Model Context Protocol", "JSON-RPC · request:
  method → reply: result or error", "writes the request · runs nothing", "toy server · numbers
  made up", "tool · live weather". What remains is short names (model, app, tool, MCP, Agent,
  MCP client, host, JSON-RPC, menu, input schema, toy) and real data (the two tool names and
  descriptions, the schema lines, the request, the tools/call packet, the result card, the
  terminal). Every definition is spoken. The voice reads no label aloud; the one on-screen text
  it repeats is the lab's title in the call to action.
- **Human voice.** Every VOICE cell was read aloud and rewritten as a colleague at a whiteboard
  would say it: "you" and contractions throughout, sentences of varied length, plain verbs, one
  aside ("That's the whole trick."). Gone: the counted recap ("One, … Two, …"; the badges show
  the numbers while the voice tells the steps in order), the label-like fragments ("a request
  names a method; the reply is a result or an error" is now "You send a request naming a method
  and get back a result or an error"), stacked colons and semicolons, and "content" as a spoken
  term (it stays on the result card). The hook line is unchanged.
- **Length.** 449 → 429 words (cells 20-38 words), about 2:31 spoken and about 2:44 with
  thirteen page pauses; inside the 380-430 target and under three minutes.
- **Rules.** docs/video-prompt.md FLOW gains three rules: one question per board, four or five
  things at most, erase when a new question starts, carry one anchor; the screen shows and the
  voice explains, never read a label aloud, no sentences on the board; talk like a person at a
  whiteboard. "How to read these tables" records the board rule. Videos 2-4 are unchanged and
  still carry their large scene-2 boards and some caption-style labels; they are the next to
  revise once the owner approves this cut.

---

**Videos 2-4 rewritten for flow, 2026-10-31** (against commit d16e12a). The owner liked the
direction of the new Video 1 (four building scenes, bridged pages), so Videos 2, 3 and 4 and
V2's variant B now follow the same shape. No research fact or source changed; no claim was
added that the brief does not support; the approved kickers, titles and code card are on
screen verbatim, and each first spoken line keeps its approved meaning (V4's is verbatim).

- **Shape.** V2: 14 pages with 13 erases become 13 pages in 4 scenes (S1 two hundred lines,
  the hook board zoomed to a 3 × 5 frame and costed; S2 one program in the middle, drawn once
  and then given registration, catalogue, two faces, address and badges, the log row and the
  "not" chips; S3 the lab beside that diagram; S4 the same diagram numbered), 394 → 458 words,
  about 2:32 → 2:54. V3: 14 pages become 10 pages in 4 scenes (S1 Support's menu, where the
  five are picked out of twelve on the hook board; S2 two boxes on one catalogue, then what
  the agent sees, one routed call and the "not a lock" line; S3 toy-tools; S4 numbered),
  409 → 437 words, about 2:37 → 2:44. V4: 15 pages become 13 pages in 4 scenes (S1 the line,
  with the envelope and body opened on the hook board; S2 one chain followed out to the
  timeout and back; S3 the two shapes side by side with the lab beside them; S4 the chain
  with the line rewritten, then numbered), 418 → 458 words, about 2:41 → 2:54. Three erases
  each, counting the layout split.
- **Running examples.** V2 carries 10 × 20 = 200 → 30 on the board from 0 s, zooms it to
  Support, Billing and Ops against five named servers (3 × 5 = 15 → 3 + 5 = 8) without an
  erase, and scales back up in the recap (200 − 30 = 170 is the viewer's sum, the KodeKloud
  shape). V3 carries support-tools and the red `issue_refund` chip from the hook to the recap.
  V4 carries one forecast call for Leeds: the reply card from the hook docks under the agent
  when the chain brings it back, and the invented snow is crossed out by the honest bubble.
- **Bridges.** Every VOICE cell picks up the previous page or ends with the question the next
  page's picture answers; the hand-offs are listed in the read-aloud check. The voice names
  what is being drawn as it is drawn, and no page is a sentence on an empty board.
- **Prefix moved to V2.** V1 #11 promises "a prefix, which the next video explains"; the old
  V2 never did. V2 #10 now explains it in one sentence on the real `--list` output, and V3's
  two pages on the two tools called `search` are dropped; V3 #6 reuses the prefix with a
  reminder while routing one call.
- **Characters.** Larkfield, Maren and Priya are no longer spoken (V2 and V3 run on the named
  agents and the red chip alone); Tomas remains, in one line of V4 #3, because a trace needs
  someone to pull it. The character names stay in NOTE as dropped, and the Larkfield address
  chip `mcp.larkfield.internal` stays on V2's board as an illustrative hostname.
- **Dropped from the voice.** V2: Larkfield and Maren; "the role each agent played before"
  (the MCP-client face is still spoken). V3: Priya and May; the `search` collision; the
  view-tab sentence. V4: Thursday 08:00; "the chain had broken two hops away"; "server errors"
  is also taken off the board so nothing unspoken is drawn (it stays in NOTE and source 5).
- **Kept.** All lab-real output and its NOTE honesty (no caller column, toy-tools leaves nothing
  out, the SDK's isError for an unknown tool against the spec's protocol error, the 2026-07-28
  status nuance as unspoken small text), the arithmetic, the glossary terms, and a call to
  action that names the next video.
- **Lengths against the 380-440 target.** V3 is inside it; V2 and V4 land at 458 (V1: 449).
  The pages to cut if the owner wants each under 440 are V2 #9 (what it is not) and V4 #10
  (lab versus specification); both are kept because each stops a newcomer learning the wrong
  thing (the gateway is not the model or an AI gateway; the lab's isError is not the spec's
  rule).

---

**Video 1 rewritten for flow, 2026-10-31** (against commit 4602a73). The owner watched the
rendered Video 1 and found the copy disconnected: every page was a separate fact on a freshly
erased board (one page was the single line "writes the request, runs nothing" on an empty
board), so it played like a slide deck. The model to imitate is the KodeKloud reference (one
running example, one canvas that keeps growing, the board cleared twice in 2:49, every
sentence either describing what is being drawn or bridging to the next step with the question
the viewer is already asking). No research fact or source changed; no claim was added.

- **Shape.** 15 pages with 14 erases become 13 pages in 4 scenes with 3 erases: S1 the frozen
  model (the hook board builds: model label, the calendar's dashed line, the app box, the tool,
  MCP on the arrow), S2 one lookup end to end (agent, server, client and host drawn once; then
  tools/list, the menu, the input schema, the model's request, tools/call and the result all
  travel along the same line, and the chat gets "No snow"), S3 in the lab (the S2 diagram
  shrinks beside the real terminal), S4 recap (the same diagram redrawn with the four steps
  numbered on it, then the call to action). 431 → 449 words; about 2:46 → about 2:44, because
  three wipes replace fourteen.
- **Bridges.** Every VOICE cell starts from the previous page or ends with the question the
  next page answers ("What passes between them?", "What travels along that line?", "Who picks
  from it?"); the grey "?" from the hook travels across the board to each of those questions.
  No page is a sentence on an empty board; every label sits beside the thing it names.
- **Kept.** The approved hook (kicker, title, first three spoken sentences), the facts and
  sources, the terms (agent, tool, MCP server, MCP client, host, JSON-RPC, tools/list, input
  schema, tools/call, result), the lab-real output and the call to action. The hook's user
  bubble now reads "Is it snowing in Leeds?" so the running example is on the board from 0 s.
- **Dropped from the voice.** The Larkfield story (Tuesday, the snow that never fell, Ollie);
  JSON-RPC as a page of its own (now one sentence on the tools/list page). "No snow" in the
  reply bubble is the running example's payoff instead.
- **Rules.** docs/video-prompt.md gains a FLOW section (scenes not slides; bridge every page;
  the board is never just text; erase only between scenes; the voice describes what is being
  drawn; a hand-off question per scene). "How to read these tables" records the scene format
  and the SCENE / PAGE column; the read-aloud check carries a note for the new V1. Videos 2-4
  are unchanged and will be rewritten in the same style once the owner approves this cut.

---

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
   https://modelcontextprotocol.io/specification/latest . Re-read 2026-10-31 for V1 #6 (why a
   standard): "MCP provides a standardized way to connect AI applications to external systems";
   "making it easy to build once and integrate everywhere"; for developers, "MCP reduces
   development time and complexity when building, or integrating with, an AI application or
   agent".
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
    calling). https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview . Re-read
    2026-10-31 for V1 #2, #9 and #12: "Claude determines when to call a tool based on the
    user's request and the tool's description. It then returns a structured call that your
    application runs (client tools)"; client tools "run in your application ... Your code runs
    the operation and sends back a `tool_result`".
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
