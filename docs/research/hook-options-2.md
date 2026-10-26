# Hook options, round 2: six more per MCP video

Additions to the three options per video (A, B, C) in
[mcp-gateway-scripts.md, "Hook options"](mcp-gateway-scripts.md#hook-options). Written against
the [hook checklist](hooks.md#7-hook-checklist-apply-to-every-video) and the facts in
[mcp-gateway.md](mcp-gateway.md); nothing below claims what the brief does not support.
Written 2026-10-26. The character formerly called Tomasz is Tomas.

How to read each row:

- **Kicker**: the small orange capitals at 0 s, naming the genre.
- **On screen**: the hand-written question or title, at most 8 words, on the board at 0 s.
- **Picture at 0 s**: what is already drawn, and the one thing that moves inside the first
  second.
- **Spoken**: the first line (word count in brackets, always under 12) plus at most one more
  sentence. The hook question may be spoken once; nothing else is a narrated question.
- **Page 2**: how the first real piece of the answer lands within about 20 s, and which
  existing board pages move to make that true.

Every option passes the stranger test: no Larkfield, no Ollie, Maren, Priya or Tomas, no
product name, no "MCP", "gateway" or "virtual server" in the first line. The story starts on
page 2 or later. Options that failed a check are listed under "Dropped" with the reason.

---

## Video 1. What is MCP?

Existing: A "How does an AI model know today's weather?" (interview, months ago vs now),
B "Why did the AI invent snow?" (failure first), C "Does the AI call the weather API itself?"
(myth).

| # | Kicker | On screen | Picture at 0 s | Spoken | Pattern | Page 2 |
|---|---|---|---|---|---|---|
| 1-D | INTERVIEW QUESTION | Who actually ran that tool? | A chat window with the familiar grey status chip "Searching…"; at 0.5 s it ticks over to "Used: weather". Beside it a model chip with a "?" above it and nothing in its hands. | "You have seen this chip in a chatbot: Used weather." (10) "The model did not run it." | You've seen it every day, never questioned it; interview question (misconception 1 in the brief) | "The model wrote a request; the program around it, the agent, ran a function in another program." Existing pages 3-4 (agent, tool) compress into page 2; the model-guesses page becomes page 3. |
| 1-E | AI QUESTION | Same model. Same question. Two answers. | One model chip; above it two bubbles for "Is it snowing in Leeds?": left "Heavy snow in Leeds" (a GUESS stamp lands at 1 s), right "Leeds, 10 °C, cloudy" with a short cable running off the board to a cloud icon. | "Same model, same question, two different answers." (7) "Only one of them was allowed to ask outside." | Paradox (how can both be true?) | "The right answer came through a tool, a function in another program that the agent ran for the model." The 10 °C is the lab's toy weather (NOTE), as on page 11. |
| 1-F | BUILD IT IN YOUR HEAD | Connect a chatbot to live weather. Draw it. | Model chip left, a card "Leeds, now" right, a dashed gap between them. At 0.5 s a pencil draws one arrow across the gap and a red "?" lands on it. | "Connect this chatbot to a live weather service." (8) "One arrow is the wrong picture." | Visual puzzle (a pretest) | Page 2 draws the three boxes the viewer could not: the agent around the model, the tool in another program, the line between them. Pays "wrong picture" off by 20 s; the server and client pages follow as before. |
| 1-G | COMMON MISTAKE | Does adding a tool change the model? | Model chip with a small "unchanged" tag, grey and still. At 1 s a tool chip `get_weather` pops in outside it, inside a dashed box labelled "another program". | "Give an AI a tool, and the model does not change." (11) "The tool lives in another program." | Myth / counterintuitive claim (true as stated: the model's weights are untouched; it is handed a menu as text) | Existing page 4 ("a tool is a function in another program") becomes page 2, then page 3 the agent that runs it. |
| 1-H | REAL OUTPUT | This is all an AI sends for weather | A card "request" already on the board: `call get_weather · city: Leeds`. At 1 s a reply card slides under it: `Leeds, 10 °C, cloudy`. | "This is all an AI sends to check the weather." (10) "One tool name and one city." | Show the result first, then rewind | Page 2: who wrote the request (the model), who sent it (the agent) and who ran it (another program). NOTE: the card is the lab's real `tools/call`, simplified (method and id left off); weather is the toy server's. |
| 1-I | AI QUESTION | Your weather widget beats this AI. Why? | A phone weather widget "Leeds · 10 °C · now" with a ticking clock; beside it a model chip under a torn calendar page "trained months ago" and a bubble "snow?". | "Your phone's weather widget knows more than this AI model." (10) "About today, anyway." | Contrarian take that is still true | "The widget asks a live service every time; the model knows only its training. The fix is to let the model ask a service too." Existing page 2 (the model guessed) works with that extra sentence. Shares the torn-calendar picture with A. |

**Dropped (V1).** "Is MCP just function calling?" (term first; fails the stranger test).
"Does the AI browse the web?" (the same myth as C with a different noun). "A chatbot promised
snow and a customer cancelled a trip" (an invented incident presented as real; hooks.md §4,
"Stakes").

---

## Video 2. Why an MCP gateway?

Existing: A "How does one more box mean 7 fewer connections?" (15 → 8), B "Which agent is
flooding this server?" (whodunit), C "Where do 15 secret keys live?" (stakes).

| # | Kicker | On screen | Picture at 0 s | Spoken | Pattern | Page 2 |
|---|---|---|---|---|---|---|
| 2-D | INTERVIEW QUESTION | Add a server. How many agents change? | Three agent dots left, five server dots right, fifteen lines already drawn. At 1 s a sixth server slides in with a counter "agents to update: ?". | "A sixth server arrives. How many agents must change?" (9) "Today, all three. It can be zero." | Interview question plus a one-number puzzle | "Put one program in the middle that every agent already talks to, and register the new server there once. That program is an MCP gateway." The gateway is named by 20 s; the 15-connections page becomes the worked example on page 3. Fact: single endpoint (brief §3.1); "a sixth server changes nothing on the agents" (V2 #8 NOTE). |
| 2-E | PLATFORM QUESTION | 5 menus. 1 request. How? | One agent sends one packet "list tools" into a single violet box. Out of the back of the box five menu cards fan into one tall list; a counter reads "5 servers · 1 reply". | "One request came back with five servers' menus." (8) "The agent knew only one address." | Paradox with concrete numbers | Existing pages 6-7 (registration, catalogue) move up: the box fetched each menu when an operator registered the servers, and its catalogue answers in one reply (brief: one `tools/list` to the gateway returns every tool). |
| 2-F | SYSTEM DESIGN | You already run this for web traffic | A grey reverse-proxy box in front of three web services, labelled "reverse proxy", already drawn. At 1 s the same shape redraws in violet with agents on the left and tool servers on the right. | "You already put one proxy in front of your web services." (11) "Your agents' tools need the same box." | You've used this every day (for the engineer audience) | Existing page 4 ("a gateway is a proxy, a program that receives each call and passes it on") becomes page 2, with "to agents it looks like one server" from page 5. "Proxy" is general web knowledge, not the term being taught, so the stranger test holds. |
| 2-G | COMMON MISTAKE | Does the middle box make calls faster? | Agent → box → server with a stopwatch on the box reading "+1 hop". At 1 s a red cross lands on the word "faster" in the title. | "A box between agents and tools makes every call slower." (10) "Teams add it anyway." | Myth / contrarian (brief §3.3: it adds a hop, makes nothing faster) | Page 2 names what the hop buys, starting with one address per agent and ending with "the box is an MCP gateway"; the one-credential and one-log pages follow. |
| 2-H | DEBUGGING QUESTION | Who called what? One row answers. | A log card titled "illustration": `18:41 · Ops · orders-get-order · ok · 2400 ms`; above it three agents and five servers. At 1 s the "Ops" cell rings. | "This one row says which agent called which tool, and when." (11) "Three agents, five servers, one table." | Show the result first | "The row exists because every call passes through one place; that place is an MCP gateway." Existing page 9 moves to page 2, the rest stays. Honest: the card says "illustration"; the lab's log has no caller column, which pages 9 and 12 say. |
| 2-I | SYSTEM DESIGN | 3 agents, 5 servers. Fewest wires? | Three dots left, five dots right, fifteen faint lines; a counter "15" and an empty "?" beside it. One line brightens every 0.1 s. | "Three agents, five servers. Fewest wires that connect them all?" (10) "Fifteen is the wrong answer." | Visual puzzle (a pretest version of A) | Page 2 drops the box in and rolls the counter to 8: "each wire was an address and a credential; one box in the middle is an MCP gateway." Existing pages 2-3 become the worked example. |

**Dropped (V2).** "One key leaked. How many places to fix?" (the same stakes as C, with a
leak instead of a sixth server). "What is an MCP gateway?" (term first). "Three reasons
teams run a gateway" (a list hook in a one-idea video).

---

## Video 3. Virtual servers

Existing: A "Why can the support bot issue refunds?" (stakes), B "It needs 5 tools. Why does
it see 12?" (numbers plus stakes), C "Is a hidden tool a blocked tool?" (myth; payoff too late).

| # | Kicker | On screen | Picture at 0 s | Spoken | Pattern | Page 2 |
|---|---|---|---|---|---|---|
| 3-D | INTERVIEW QUESTION | One tool list. Three agents. Three menus. | One grey column of twelve tool chips on the left; three agents on the right with menus of 5, 2 and 12 chips. At 1 s a line from the chip `add` fans out to two of the menus. | "Three agents share one tool list and see three different menus." (11) "No tool was copied." | Interview question plus a paradox | Existing page 4 becomes page 2: "a named pick of tools from the list, at its own address, is a virtual server; to an agent it is an ordinary server." Page 6's "points at tools, copies nothing" is the payoff of "no tool was copied". |
| 3-E | ACCESS QUESTION | Why is a tool menu like a playlist? | A music-library list in grey and a playlist card beside it with five rows glowing. One grey row, `issue_refund`, stays in the library and gets a "£" tag at 1 s. | "A playlist picks songs and deletes nothing from the library." (10) "The same trick keeps a refund tool off a chatbot's menu." | Everyday object as the vehicle (the "banana") | Page 2: the gateway holds every tool; a virtual server is a named playlist of them at its own address. The analogy's break (a playlist does not lock the library) is stated on page 11, as the brief §8 asks. |
| 3-F | COMMON MISTAKE | Why not give the agent every tool? | A twelve-chip menu beside a model chip. A dashed arrow from the model wanders across the menu and stops on `issue_refund` at 1 s; a "£" stamp lands. | "Hand an agent every tool, and one wrong pick moves money." (11) "The model picks from whatever menu it is given." | Common mistake (tools are model-controlled, source 4) | Existing page 3 merges with the first sentence of page 4: "so the cure is a shorter menu with its own address, a virtual server." A shows the symptom; this names the mistake. |
| 3-G | SECURITY QUESTION | A new key. Full delete power. Why? | A menu in which `delete_account` glows red. At 1 s a key chip stamped "NEW" lands beside it with a green "allowed" tick. | "A brand-new key could call delete account on its first day." (11) "Nobody granted that; nothing was scoped." | Stakes (grounded in the sibling lab "Give each agent only the tools it needs": every token, including a brand-new one, can call the tool that permanently deletes an account) | Page 2: "the gateway offered one ungoverned bundle to every key; the cure is a named bundle per role at its own address, with a credential scoped to it." Page 11 ("a menu is not a lock") comes forward one sentence. The call to action should point at that lab. |
| 3-H | BUILD IT IN YOUR HEAD | 12 tools, 3 agents. Who gets what? | A grid of twelve tool chips, three empty agent boxes below. At 1 s the chip `add` glides toward two boxes at once and splits into a dotted pair with a "?". | "Twelve tools, three agents. Sort them, and one tool goes twice." (11) "Copying it would be the wrong move." | Visual puzzle | Page 2 gives the definition with page 6's fact attached: "a virtual server points at tools and copies none, so one tool can sit in several." Schema evidence in the brief (A10). |
| 3-I | PLATFORM QUESTION | One program. Two addresses. Two menus. | A single violet box with two doors, `/servers/…/mcp` and `/servers/…/mcp`, a different short menu beside each; through the box's open side one long list is visible. | "One program answers at two addresses with two different menus." (10) "Nothing behind it was duplicated." | Paradox | Page 2: "each address is a virtual server, a named pick from the one catalogue." Muted, the board reads "one box, two doors". Keep `…` for the id: it is a fresh uuid on every install (brief A18). |

**Dropped (V3).** "Why the long name?" (`get_weather` → `weather-tools-get-weather`): a good
"you've seen it" hook, but its answer is pages 7-8 at about 1:10, so it fails the 20 s check;
keep it for a separate short on prefixes. "Smaller menu, safer agent?": its honest answer
("only with a scoped credential") is C's problem again, and the video's one idea is the menu,
not the credential.

---

## Video 4. When a tool fails

Existing: A "200 OK. So why did the tool fail?" (paradox), B "Both returned 200 OK. Which one
worked?" (interview, spot the difference), C "Every check passed. Why did the AI invent a
forecast?" (quiet disaster).

| # | Kicker | On screen | Picture at 0 s | Spoken | Pattern | Page 2 |
|---|---|---|---|---|---|---|
| 4-D | DEBUGGING QUESTION | if status == 200: trust it? | A code card titled "illustration": `if status == 200: use(reply)`, its tick green. At 1 s a reply card slides underneath showing `isError: true` and gets a red ring; the tick stays green. | "You have written this line, and it threw a failure away." (11) "The failure was inside the 200." | You've written this (everyday code) | Same as A and B: page 5 comes forward, "HTTP 200 only says the message arrived and was answered; whether the tool worked is in the body, next to isError." |
| 4-E | COMMON MISTAKE | No 500. No crash. Still failed. | A reply card with a green "HTTP 200" chip and no stack trace. Inside it the line `isError: true · "Weather service timed out"` pulses at 1 s. | "This tool failed with no 500 and no crash." (9) "It said so, inside a normal reply." | Myth (a failure must look like an exception) | Existing page 4 (the tool execution error: a normal result with isError and a short text) becomes page 2. Honest: the voice says "this tool", never "every error is a 200"; under 2026-07-28 some protocol errors change the status (brief §2.6). |
| 4-F | REAL OUTPUT | The tool doesn't exist. Status: 200. | A real terminal: `python3 -B call_tool.py does-not-exist '{}'`; output lines `HTTP 200` (green) and `Tool not found: does-not-exist`, which rings red at 1 s. | "This tool does not exist, and the call returned 200 OK." (11) "That is the lab's real output." | Paradox plus show the result (lab-real, short.yaml `terr`) | Existing page 9 becomes the worked example on page 2: the status says delivered; "Tool not found" and `isError` are in the body. Page 10's nuance (the spec files an unknown tool as a protocol error; ContextForge's SDK makes it a tool error) stays where it is, so the viewer does not learn the wrong rule. |
| 4-G | INTERVIEW QUESTION | Two failures. The AI should read one. Which? | Two cards side by side: left `"error": { "code": -32601, "message": "Method not found" }`, right `isError: true · "date in wrong format"`. A model chip between them; an arrow flips between the cards and stops on a "?" at 1 s. | "A tool call fails two ways; the model reads only one." (11) "The other is for your code." | Interview question (a pretest; an interviewer could ask it) | Pages 4 and 7 compress into page 2: "a result with isError carries text for the model to correct itself; an error object replaces the result and is for the agent's code." Source 5 (clients SHOULD give tool execution errors to the model). The two careful-agent pages pay it off in full. |
| 4-H | AGENT QUESTION | Show the AI its error. It fixes it. | A reply card `isError: true · "date in wrong format: use YYYY-MM-DD"` (illustration). At 1 s a second request card types a corrected date and gets a green tick. | "Hand the AI its error, and it fixes the call." (10) "This code never handed it over." | Contrarian but true (an error is for the model, not only for a log), show the result first | Page 2: "tool execution errors are written as actionable feedback so the model can retry with adjusted parameters" (spec wording, source 5; "date in wrong format" is the spec's own example). The lab's invalid-argument call (`"a": "x"` → isError, brief A4) is the real example later. |
| 4-I | DEBUGGING QUESTION | Delivered, but failed. Design the reply. | A parcel with a green "delivered" tick. At 1 s it opens and a letter slides out reading, in red, "sorry, out of stock". | "The parcel arrived, and the letter inside said: out of stock." (11) "A tool call fails exactly like that." | Everyday object plus a build-it puzzle (the courier analogy, brief §8) | Page 2: "HTTP 200 is the delivery receipt; isError is the letter." Page 7 later adds the parcel returned "no such address" (the protocol error). NOTE must carry the analogy's break: some protocol errors change the HTTP status in 2026-07-28. |

**Dropped (V4).** "A timeout became a forecast. How?" (the same gap as C; it is the page 3
story, not a new hook). "Every MCP error is a 200" (false under 2026-07-28; brief §2.6).
"Three kinds of error" (there are two, and list hooks promise what one idea does not deliver).

---

## Checklist pass

Each kept option was checked against hooks.md §7, items 1-10. Results that needed a note:

- **Stranger test (1).** 1-D relies on the viewer having seen a "Searching…" or "Used tool"
  chip in a chatbot; that artifact is common in current chat apps, which is the condition
  hooks.md §4 row 8 sets. 2-F uses "proxy", general web knowledge rather than the term taught.
  3-I shows a URL path on screen; muted, the picture still reads as one box with two doors.
- **One number or object (3).** Every option has one: a chip, two answers, one arrow, a
  card, a widget, a counter, a row, a playlist, a key, a grid, two doors, a code line, a
  terminal, two cards, a parcel.
- **A gap the viewer can feel (4).** 1-G and 2-G are stated as contradictions ("does not
  change", "gets slower, teams add it anyway"); both are true as stated, not only "in a sense".
- **Honest (9).** 2-H's log card and 4-D's and 4-H's code cards are titled "illustration";
  4-F and 1-H are real lab output. "INTERVIEW QUESTION" is used only on 1-D, 2-D, 3-D and 4-G,
  each a question an interviewer could plausibly ask. No option uses a statistic.
- **Payoff by about 20 s (8).** Every kept option names which existing page moves to page 2;
  the dropped prefix hook (V3) failed exactly this check.
- **Story after the hook (10).** No option names a person, time or place; Ollie, Maren,
  Priya and Tomas enter on page 2 or 3 as before.

---

## Ranking: top 3 per video, old and new together

**Video 1**
1. **A** "How does an AI model know today's weather?" (interview): the one question the whole
   video answers, and "months ago" against "now" reads on mute.
2. **1-D** "Who actually ran that tool?" (everyday chip): the viewer has seen the artifact, and
   the answer is the brief's misconception 1, which is the video's spine.
3. **1-E** "Same model. Same question. Two answers." (paradox): two bubbles over one chip is
   the whole idea as a picture, and it keeps the Leeds example.

**Video 2**
1. **A** "How does one more box mean 7 fewer connections?" (15 → 8): the reference's exact
   shape, a number that shrinks for a reason the viewer cannot yet see.
2. **2-D** "Add a server. How many agents change?" (interview puzzle): a one-number pretest
   whose answer, zero, is the gateway's reason to exist.
3. **2-F** "You already run this for web traffic" (everyday for engineers): the audience's own
   reverse proxy is the "banana"; the gateway is named by 20 s.

**Video 3**
1. **B** "It needs 5 tools. Why does it see 12?" (numbers plus stakes): two numbers and one
   dangerous tool state the problem on mute, and "pick 5 of 12" is what a virtual server is.
2. **3-G** "A new key. Full delete power. Why?" (stakes): real in the sibling lab, and it
   makes the credential half of the answer (page 11) impossible to skip.
3. **3-I** "One program. Two addresses. Two menus." (paradox): the definition drawn as a
   picture, with nothing illustrative to apologise for.

**Video 4**
1. **B** "Both returned 200 OK. Which one worked?" (interview, spot the difference): any web
   engineer reads it on mute, and the pretest is answered by page 2.
2. **4-F** "The tool doesn't exist. Status: 200." (paradox, real output): the lab's own
   terminal is the hook, and the same command is the call to action.
3. **4-D** "if status == 200: trust it?" (everyday code): the viewer's own line is the bug,
   so the payoff ("read the body") is something they will change tomorrow.
