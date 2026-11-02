# What the KodeKloud shorts do (reference analysis)

Three more reference videos from the owner (KodeKloud TikTok explainers), studied frame by frame
and transcribed on 2026-11-02: "HTTP QUERY", "MCP vs UTCP" and "How database indexing works".
The transcripts stay in the scratchpad (they are KodeKloud's text); this file keeps only our
analysis. The first reference ("How a folder gets compressed") is analysed in
[hooks.md](hooks.md) and docs/shorts.md.

## Numbers

| Video | Length | Words | Speaking rate |
|---|---|---|---|
| HTTP QUERY | 2:54 | 585 | about 200 wpm |
| MCP vs UTCP | 3:02 | 624 | about 205 wpm |
| Database indexing | 2:56 | 693 | about 235 wpm |

They talk fast, about 200 words a minute, and are still easy to follow. Speed is not what makes a
video feel rushed; unexplained steps are.

## 1. A chain of reasons, not a list of facts

Every video is one problem walked through a chain of attempts, each motivated by the failure of
the one before:

- **HTTP QUERY:** filters in the URL, *but* URLs have length limits at the CDN, *so why not* the
  body of a GET, *but* servers treat a GET body differently, *that's why* teams fall back to POST,
  *but* POST isn't cached or safely retried, *and this is exactly where* QUERY helps.
- **Indexing:** a full scan, *but* ten million rows, *so* a sorted copy of one column, *now you
  might ask* how to search it without reading from the top, *this is exactly where* a B-tree
  comes in, *but* an index costs work on every insert, *that's why* you index only what you search.

The "why" the owner asks for is built into the structure: the viewer always knows why the next
thing exists, because they just saw the previous thing fail. Signal phrases: "But we have one
major problem", "So why not…", "That's why…", "Now you might ask…", "This is exactly where…",
"Focus on what just happened here", "If you notice".

## 2. One concrete scenario, with a person if it helps

Right after the hook question comes "Let's say…": shopping for a t-shirt with four filters; Alan
building a support agent that should open a Jira ticket when "my payment failed twice"; a users
table with nine users, find Nina. The same scenario carries the whole video, with real-looking
data (brand=nike,puma&size=m…, title "Payment failing", priority high, row 5).

## 3. Explain the mechanism on its first appearance

The MCP vs UTCP video opens with the exact point our owner raised: "The model itself doesn't
directly call Jira. It generates a tool call… and some code has to actually call Jira." The
picture shows the tool-call card (`create_ticket`, title, priority) and an empty dashed box with
"?" for "the code that calls Jira", and the rest of the video fills that box in two ways.

## 4. Boards with a title, panels with tags

- Each section has a hand-written title at the top that stays while the board builds ("Filters in
  the URL", "GET with a body", "Fall back to POST", "Where QUERY helps"; "MCP", "UTCP", "Both
  cases", "Trade-off"). A new question means a new title and a fresh board; the previous board
  dims before it goes.
- Concepts get a colour and keep it everywhere: GET cyan, POST pink, QUERY yellow; MODEL pink,
  MCP CLIENT cyan, UTCP violet.
- Parts of a system are tags in a panel header, not separate boxes: "Alan's app" with chips
  MODEL and MCP CLIENT, so the viewer sees at once that both live inside the app.
- Realistic artefacts instead of abstract chips: a phone shop app, a `search.http` request window,
  a `manual.json` code window, a `403 Forbidden` response, the t-shirt grid "no filters".
- Product logos (Jira, Google Drive, GitHub, CloudFront) mark real systems. For us, only logos
  cleared in scripts/shorts/page/assets/manifest.json (GitHub, Kong, Python today); the rest are
  written names.

## 5. Ending

A practical caveat ("test it first; your CDN might not support QUERY yet"; "every index is a
tree to maintain") or a trade-off, then a one-line summary, then the call to action.

## What this means for our scripts

1. Build each video as a reason chain: the naive way, why it breaks, the next way, why it breaks,
   then the thing we teach. Every "why" then comes for free.
2. Open with the question, then "Let's say…" and one concrete scenario with real-looking data.
3. Put a title on every board; a new question gets a new title and a fresh board.
4. Draw systems as panels with tag chips (the app with MODEL and MCP CLIENT inside), and use
   realistic artefacts (a chat window, a request window, a JSON file) over abstract chips.
5. Keep a colour per concept for the whole video.
6. End with a practical caveat or trade-off, a one-line summary and the call to action.
7. Pace: about 170-200 words a minute is fine when every sentence matches what changes on screen
   and every step is motivated; do not slow the voice down to fix a missing reason.
