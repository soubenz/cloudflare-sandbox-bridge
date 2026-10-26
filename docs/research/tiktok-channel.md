# TikTok channel starter plan for Opalix

A concise plan for a TikTok channel (cross-posted to YouTube Shorts and Instagram Reels) built
from our whiteboard explainers. Platform behaviour is only stated as fact where
[hooks.md](hooks.md) documents it with a source; everything else about how the platforms
behave is marked **UNVERIFIED**. Hook writing follows the
[hook checklist](hooks.md#7-hook-checklist-apply-to-every-video); the MCP hooks come from
[mcp-gateway-scripts.md](mcp-gateway-scripts.md#hook-options) and
[hook-options-2.md](hook-options-2.md). Format rules: [`docs/shorts.md`](../shorts.md).
Written 2026-10-26.

---

## 1. Positioning

**Who it is for.** Working engineers (backend, platform, ML, SRE) who are being asked to run
AI in production: a gateway in front of the model, tools behind MCP, retrieval, tracing and
cost, and the controls that keep teams and data apart. Not beginners to programming, not
researchers.

**The promise, in one line.** *One production-AI idea per video, drawn on a whiteboard,
answered honestly, with a lab you can run afterwards.*

**What makes it different from the explainer channels we studied.** Every video ends in a
real lab with real terminal output (the renderer only allows real output), so the channel can
say "go and do it" instead of "subscribe for more". Fictional incidents are labelled as
illustrations; numbers are real or marked.

## 2. Channel name ideas

| Name | Why | Risk |
|---|---|---|
| **Opalix** (`@opalix`) | The product name; the bio link and end card already say "opalix". | The plain handle may be taken. |
| **Opalix Labs** (`@opalixlabs`) | Says what the channel is (labs) and keeps the brand. | Longer to say aloud. |
| **AI Platform Interview** (`@aiplatforminterview`) | Names the strongest series; people search for interview prep. | Narrows the channel to one format. |
| **Production AI, Explained** (`@productionai`) | States the promise. | Generic; weak brand recall. |
| **One Idea AI** (`@oneideaai`) | Names the method (one idea per video). | Says nothing about platforms or engineering. |

**Caveat.** Handle availability was not checked; check the same handle on TikTok, YouTube
and Instagram before choosing, and prefer one that is free on all three so the end card and
the pinned comment can say one name.

## 3. Content pillars, mapped to the course

| Pillar | Course modules and labs it draws on | Example questions |
|---|---|---|
| **Gateways and access** | AI platform module 1 (What an AI gateway is; one endpoint, one key; hard budget per team; keep answering when a provider fails; locked out in credit) | Why put a proxy in front of a model API? Which call should a budget refuse? |
| **Tools and MCP** | Module 2 (See how tools reach an agent; one endpoint for every tool; give each agent only the tools it needs; write a tool server; version tool definitions) and Agent security (the code tool read the secrets file) | How does a frozen model know today's weather? 15 wires → 8. Needs 5 tools, sees 12. 200 OK and still failed. |
| **Retrieval as a service** | Module 3 (see why a document matched; retrieval service teams don't build; ingestion pipeline; hybrid search and reranking; fresh index without downtime) | Closer to what? Keyword found it, vector missed it. |
| **Observability and cost** | Module 4 (follow one request through the stack; one trace across services; telemetry without losing the errors; tell finance who spent the money) and Agent builder (the $4,000 weekend) | Four services, three seconds, who took it? Keep 10% of traces, lose every error? |
| **Governance and sovereignty** | Module 7 (keep EU data on EU routes; strip personal data; prove where one request's data went; control what can leave; retention that runs) | EU provider down, where did the data go? Redaction worked, only in English. |

Modules 5 (runtime) and 6 (self-service) feed the backlog once the channel has a baseline.

## 4. Three repeatable series formats

Each series has a fixed kicker colour and wording, so one frame tells a returning viewer what
kind of video this is (hooks.md §1, point 5).

| Series | Kicker | Shape | Length | Source of material |
|---|---|---|---|---|
| **AI PLATFORM INTERVIEW QUESTION** | INTERVIEW QUESTION / SYSTEM DESIGN | A plausible interview question on the board at 0 s, a concrete number or picture, the mechanism explained on one running example, the term named last, one lab to open. | 90-150 s | The concept videos of each lab (`learn/short.yaml`), the four MCP explainers first. |
| **THIS BROKE IN PRODUCTION** | DEBUGGING QUESTION | A quiet failure that looks like success (a 200, a full shelf, a bill nobody caused), the trace to the cause, the fix, what the viewer checks in their own system. Incidents are Larkfield's and labelled illustrative; numbers come from the labs. | 90-180 s | The incident labs (Agent builder path, modules 1, 4, 7). |
| **COMMON MISTAKE** | COMMON MISTAKE | One belief most newcomers hold, stated in the first line, corrected by 20 s, with the one case where the belief is right. Shortest format. | 60-90 s | The "misconceptions" sections of the research briefs (mcp-gateway.md §7 has twelve). |

"Explained in 2 minutes" is not a separate series: every video is one idea in 1.5-3 minutes,
so the label would add nothing.

## 5. Four-week plan: the first 12 videos

Three videos a week (our choice of cadence; no platform source says what cadence is best).
Each week carries one video from each series, and the four MCP explainers run one a week in
course order so a viewer who finds one can follow the thread. Hooks are the top-ranked option
per video (MCP) or new ones grounded in what the lab teaches. Numbers marked *illustrative*
must be checked or replaced with the lab's real output before recording.

| # | Week | Series | Video (lab) | Kicker · on screen · spoken first line | Payoff |
|---|---|---|---|---|---|
| 1 | 1 | Interview | What is MCP? (See how tools reach an agent) | INTERVIEW QUESTION · *How does an AI model know today's weather?* · "This AI model stopped learning months ago." | A tool is a function in another program; the agent runs it over MCP. |
| 2 | 1 | Common mistake | Six copies of one key (What an AI gateway is; Give every team one endpoint and one key) | COMMON MISTAKE · *Six apps share one secret. Who holds it?* · "Six apps, six copies of the same provider key. One of them leaked." | One front door holds the provider key; each team gets its own key and models. The leaked key is the gateway-warm-up story, illustrative. |
| 3 | 1 | Broke in production | The $4,112 weekend (The $4,000 weekend) | DEBUGGING QUESTION · *Nobody worked. The weekend cost $4,112.* · "Nobody worked this weekend, and the AI bill hit $4,112. One agent kept asking until the model said done." | A loop with no ceiling and retries at two layers; cap turns and spend, measure. The number is the lab's; the story is Larkfield's. |
| 4 | 2 | Interview | Why an MCP gateway? | SYSTEM DESIGN · *How does one more box mean 7 fewer connections?* · "Three AI agents, five servers: fifteen connections to maintain." | 3 + 5 = 8 through one proxy; one address, one credential, one log. |
| 5 | 2 | Common mistake | A budget that is only a number (Put a hard budget on every team) | COMMON MISTAKE · *Budget $100. Bill $140. Why?* · "The budget said one hundred dollars; the bill said one-forty. The limit was written down, never enforced." | A budget is a check the gateway runs before each call; the call that passes the line is the one refused. Numbers illustrative. |
| 6 | 2 | Interview | Closer to what? (See why a document matched) | INTERVIEW QUESTION · *Which document is "closer"? Closer to what?* · "This search ranks documents by distance. Distance to what?" | Text becomes a point; nearer means more alike; the trace shows the scores. Use the lab's real pgvector scores on the board. |
| 7 | 3 | Interview | Virtual servers (Give each agent only the tools it needs) | ACCESS QUESTION · *It needs 5 tools. Why does it see 12?* · "This agent needs five tools, and its menu shows twelve." | A named pick of tools at its own address; a shorter menu is not a lock without a scoped credential. |
| 8 | 3 | Broke in production | Where did the time go? (Follow one request through the stack) | DEBUGGING QUESTION · *4 services. 3 seconds. Who took it?* · "One request, four services, three seconds. Each one says not me." | One trace shows all four hops nested with durations; the long bar names the culprit. Replace "3 seconds" with the lab's real trace total. |
| 9 | 3 | Common mistake | Failover did what it was told (Keep EU data on EU routes) | COMMON MISTAKE · *EU provider down. Where did the data go?* · "The EU model went down, so failover sent EU data abroad. Failover did exactly what it was told." | Failover is per alias; the EU-only alias must fail closed while the others keep failing over. Scenario illustrative. |
| 10 | 4 | Interview | When a tool fails | INTERVIEW QUESTION · *Both returned 200 OK. Which one worked?* · "Both of these tool calls returned 200 OK. Only one of them worked." | The status says delivered; the body, next to isError, says whether the tool worked. Real lab output: `does-not-exist` → 200. |
| 11 | 4 | Common mistake | Sampling threw the errors away (Collect telemetry without losing the errors) | COMMON MISTAKE · *Keep 10% of traces. Lose every error?* · "Keeping one trace in ten also threw away the errors. The sampler could not tell them apart." | Sample successes, keep every error: the sampler must see the outcome before it decides. "10%" illustrative. |
| 12 | 4 | Broke in production | Redaction worked, in English (Strip personal data before it reaches a model or a log) | DEBUGGING QUESTION · *Redaction worked. Only in English.* · "The redaction hook caught every phone number, in English. The German message went through untouched." | The hook runs on every call but was built and tested only against English; patterns and tests per language. Examples illustrative. |

Each new hook was run through the checklist: no product or company before the problem, no
unexplained term in the first line, one number or object on the board, a gap the viewer can
feel, first spoken line under 12 words, a payoff by about 20 s, "INTERVIEW QUESTION" only on a
question an interviewer could ask.

**Backlog for weeks 5-8** (hooks to write the same way): sold out on a full shelf, 200 either
way (We are telling customers we are sold out); the same reply twice after a retry (Customers
are getting the same reply twice); the agent forgot its rules at message 40; three tenants
locked out while in credit; two replicas, two conversations, one refund twice; the code tool
that read the secrets file; version a tool definition without breaking the caller.

## 6. Cross-posting

- **One render, three platforms.** The vertical MP4 (1080×1920, H.264 + AAC, 30 fps) is the
  file for TikTok, YouTube Shorts and Instagram Reels. Upload the source file to each; never
  re-download from one platform to post on another, because the renderer's own file has no
  watermark and full quality.
- **Landscape cut for the website.** The same script renders a 1920×1080 cut with the
  terminal beside the board, plus a poster frame (`<id>-landscape.jpg`) and a `.vtt` caption
  file for the web player. Embed it on the lab's page and the catalogue card.
- **YouTube.** The vertical cut goes up as a Short. **UNVERIFIED:** which lengths YouTube
  treats as a Short (hooks.md does not document the limit); check YouTube Help before relying
  on 3-minute Shorts. The landscape cut can also be published as a normal video, where
  YouTube's "Intro" retention report applies (hooks.md §2: the percentage still watching after
  30 s, and the advice to bring "the compelling content earlier").
- **Instagram.** Reels; Instagram's own advice is a hook in the first 3 s and a reel that
  "should make sense to those who may not know you" (hooks.md §2). **UNVERIFIED:** Reels
  length limits and whether a 3-minute reel is eligible for recommendation.
- **Titles and captions.** The on-screen question is the title; the kicker's genre is the
  first words of the description; the lab's title is the last line. Burned-in captions are the
  renderer's `captions: small`; the `.vtt` goes with the website embed. **UNVERIFIED:** whether
  hashtags change reach; keep three to five topical ones and judge by our own numbers.

## 7. Pointing viewers to Opalix without hurting reach

- **The call to action is the last page**, spoken once, as in the scripts: "Open the lab, See
  how tools reach an agent, and ask for the weather in Leeds yourself." It names what the
  viewer does next, not a product pitch (video-prompt.md: "End with what the viewer does
  next, in one sentence").
- **End card.** The renderer's `endCard` (default: the video's title and "Hands-on lab ·
  opalix") eases in over the dimmed board during the 2.5 s tail. That is the only branding in
  the video; no logo or intro at 0 s (hooks.md §5).
- **Pinned comment.** The lab's name and the one-line answer to the hook, so a viewer who
  wants the words gets them in the comments, plus "link in bio". No URL shorteners.
- **Bio link.** One link to the labs page, with the four-video MCP series first.
- **Avoid hard sells.** No "sign up", no price, no "limited", no "DM me". The video answers its
  own question in full (hooks.md §6, "honest payoff"); the lab is where the viewer goes to do
  it. **UNVERIFIED:** the common claim that links or sales language in the caption reduce
  distribution; hooks.md has no source for it. The reason to avoid them here is trust
  (hooks.md §3, clickbait and credibility), not an algorithm theory.

## 8. What to measure in the first month

**Documented by the platforms (hooks.md §2):**

| Platform | Metric | What it tells us |
|---|---|---|
| YouTube Shorts | **Stayed to watch**: "The percentage of times viewers stayed to watch past the initial seconds of a Short." **Engaged views**: times viewers stayed past the initial seconds, not counting loops. | Whether the hook holds. YouTube does not publish how many seconds "initial" is. |
| YouTube (landscape, long form) | **Intro**: the percentage still watching after the first 30 seconds. | Whether the first two board pages match the title's promise. |
| Instagram Reels | **Skip rate**: the share of views that leave in the first 3 seconds, with a retention chart (reported change, August 2025). | Same question, measured at 3 s. |
| TikTok | hooks.md quotes TikTok's guidance (a hook in the first 3-6 s; text overlays) but names no analytics metric. | **UNVERIFIED:** which retention metrics TikTok's analytics expose and how they are defined; read TikTok's own analytics help before writing targets. |

**How to use them.** Compare our videos with each other, not with blog benchmarks: hooks.md §2
notes that "70% stayed is good", "keep swipe-away under 30%", "65% decide in 3 s" and "you
have 1-2 seconds" have no primary source and are **folklore**. In month one, record for each
video: the hook pattern used, Stayed to watch (YouTube), Skip rate (Instagram), views per
platform, and comments that ask a follow-up question (the only direct signal that the payoff
landed). After 12 videos, rank patterns by Stayed to watch and Skip rate, knowing the
comparison is confounded by topic and by the channel's age; it guides the next hooks, it does
not prove anything.

**Not a metric, but worth counting:** lab opens from the bio link in the days after each
post, which is the only number tied to the channel's actual purpose.

**Folklore to ignore for now:** best posting times, "post daily or the algorithm forgets
you", hashtag counts, watermark penalties. None has a source in hooks.md; mark any such claim
UNVERIFIED if it reaches a plan.

## 9. Production notes for our renderer

From `docs/shorts.md`; nothing here is a platform claim.

- **Frame.** Vertical 1080×1920. The board sits in the top ~55% of the frame; the lower part
  stays clear for the apps' own buttons and the caption line. Elements sit on a 1000×700 grid
  scaled to the frame, so one scene serves both the vertical and the landscape cut. **UNVERIFIED:**
  the exact pixel safe zones of each app's UI (hooks.md has none); check each platform's own
  safe-zone template before the first upload and keep the kicker, title and first picture
  element inside the board area.
- **Frame zero is the thumbnail.** The kicker and title have `visible: true` and the first
  picture element too; the voice starts after the renderer's 0.3 s lead; something moves in
  the first second (hooks.md §5). The renderer writes a landscape poster only; for the
  vertical cover, save the 0 s frame with `--at 0` and upload it as the cover.
- **Captions.** `captions: small` (default) puts one plain subtitle line in the safe lower
  area of the vertical frame; `karaoke` shows 2-4 word blocks with the spoken word
  highlighted, for sound-off viewers. Either way the `.vtt` sidecar is written for the web
  player. Do not write the narration on the board (Mayer's redundancy principle, hooks.md §3);
  the board carries the question and short labels.
- **Length.** The owner's cap is 3 minutes per lesson video, enforced by the renderer: a
  video over 180 s fails before drawing a frame and names the segment to trim. Aim for
  60-180 s: Common mistake 60-90 s, Interview 90-150 s, Broke in production 90-180 s. TikTok
  allows longer uploads (**UNVERIFIED** how long; hooks.md does not say), but the cap stands.
- **Pace.** One idea per board page, 3-6 elements per page (more prints a warning), 0.8 s of
  silence at a page break, 20-30 words of voice per page at about 170 words a minute. Never
  slow the voice to fill time; add a step to the example.
- **Readability on a phone.** Title 58 px, chips about 34 px, node labels 42 px, terminal
  text 26 px on the 1000-wide grid at about 1× for vertical. Titles of 4-8 words; TikTok's
  guidance is 5-10 words of on-screen text per second (hooks.md §2).
- **Real output only.** Terminal output is pasted exactly as the lab printed it; `show` picks
  lines and `clip` shortens them; token-shaped strings are masked automatically. A `card` is an
  illustration and its title says so.
- **Checks before upload.** `--check` for length and holds; `--at` at a few beat times in
  both formats to see nothing is clipped and the highlighted thing matches the spoken word;
  `ffprobe` for duration and the AAC stream; read the warnings rather than speeding anything up.
- **Names.** The staff engineer is Tomas in every script, caption and voice clip.
