# Shorts: explainer videos from a lesson

`scripts/shorts/render.mjs` turns a lesson concept into a short explainer video in two
formats from one script and one narration:

- **vertical**: 1080×1920, for TikTok, Reels and Shorts. The picture sits in the top
  ~55% of the frame; the lower part stays clear for the app's own buttons.
- **landscape**: 1920×1080, for websites. The picture is centred and large, and the
  terminal sits beside it when one is shown.

Each format is an H.264 + AAC MP4 at 30 fps. Every render also writes a poster frame
(`<id>-landscape.jpg`) and a WebVTT caption sidecar (`<id>.vtt`) for embedding.

The style follows KodeKloud's whiteboard explainers. There is **one idea per video and
one running example**, drawn on **one canvas that builds up**. Every narrated phrase
adds or animates one small thing on the word that names it: a chip appears, an arrow
draws itself, a packet travels, a dashed box circles what is being discussed, a ring
pulses. Nothing jumps to a new screen while the idea is being built. Each actor has
one colour everywhere, on chips, nodes, packets and terminal highlights. Terminal
output in a video is real.

The sample is `labs/see-how-tools-reach-an-agent/learn/short.yaml`, with three videos:
what a tool is and what MCP adds, one door for many tool servers, and when a tool fails.

## Render

```bash
npm ci                     # once: yaml + playwright (Chromium comes from PLAYWRIGHT_BROWSERS_PATH)
export CLOUDFLARE_API_TOKEN=...      # Workers AI; CLOUDFLARE_ACCOUNT_ID optional (else the token's first account)
node scripts/shorts/render.mjs labs/see-how-tools-reach-an-agent/learn/short.yaml --stills 6
```

| Option | What it does |
|---|---|
| `--formats vertical,landscape` | which formats to draw (default: both) |
| `--video <id>[,<id>]` | render only these entries of `videos` (default: all) |
| `--out <dir>` | where files go (default `scripts/shorts/.out/`, gitignored) |
| `--stills <n>` | also save n representative frames per format as PNG |
| `--at <t>[,<t>]` | save frames at these times only, no MP4 (fast way to check a layout) |
| `--check` | make the narration, check the length and holds, write `<id>.timeline.json` and `<id>.vtt`; no frames |
| `--strict` | fail on hold warnings instead of printing them |
| `--workers <n>` | browser pages drawing frames in parallel (default 3) |

Output per video: `<id>-vertical.mp4`, `<id>-landscape.mp4`, `<id>-landscape.jpg`,
`<id>.vtt`. A 2-minute video takes several minutes per format on 4 cores. Never commit a
rendered video.

## The 3-minute rule

Write one video per lesson concept. A `short.yaml` holds a list of `videos`, and no
video may run longer than **180 s**. If one would, the render fails before drawing a
single frame, and the message names the segment to trim:

```
render: video "gateways" would run 184.3 s (narration 182.0 s), over the 180 s limit by 4.3 s.
Trim segment "deep-dive" (150.0 s of narration) by at least 4.3 s, or split this video in two.
```

Aim for 1.5-3 minutes and one concrete example. The narrator can speak at a normal
pace (150-200 words a minute) when the picture builds in small steps. Never slow the
voice down to fill time: add a step to the example instead.

## Writing a video

```yaml
voice: workers-ai:arcas         # or dir:<folder>, see "Pre-made narration"
captions: small                 # off | small | karaoke
pace: { gap: 0.7, tail: 2.0 }   # see "Pace"
colors:                         # one colour per actor, used everywhere
  agent: blue
  weather: cyan
  gateway: violet
videos:
  - id: mcp-what-a-tool-is      # file names
    title: What a tool is, and what MCP adds
    segments:
      - id: hook
        vo: >-                  # spoken and captioned word for word; one audio clip
          Ask an AI agent: is it snowing in Leeds right now? ...
        scene:                  # opens a canvas; it stays until a later segment opens another
          id: hook
          elements:
            q: { type: title, text: "How does an agent know today's weather?", pos: [500, 140], underline: true }
            agent: { type: node, icon: agent, label: Agent, color: agent, pos: [180, 450] }
        beats:                  # changes to the canvas, each on a word of this segment's vo
          - { show: q }                          # no `at`: as the segment starts
          - { at: "It answers", show: agent }
      - id: tool
        vo: The fix is to give the agent a tool. ...
        beats:                  # no `scene`: keeps building the canvas above
          - { at: "give the agent a tool", ring: agent }
```

Start each video with a question hook: a `kicker` (small orange capitals) and a
hand-written `title`, plus a picture that reads at a glance. Then set up the running
example. End with a recap ("Focus on what just happened.") and a one-line call to
action that opens the lab.

**Cues.** An `at:` is a phrase from the segment's `vo` (the beat lands just before its
first word is spoken; `phrase #2` picks its second occurrence) or a number of seconds
from the start of the segment's voice. Punctuation and case don't matter. A phrase
that is not in the `vo` fails the render, naming the segment.

### Elements

Elements sit on a 1000 × 700 grid; `pos: [x, y]` is the element's centre. The grid is
scaled to the frame, so one scene serves both formats. Every element starts hidden
unless it has `visible: true`. Any element takes `color` (an actor from `colors`, or a
palette name: pink, yellow, cyan, green, blue, violet, orange, red, white, grey) and
`scale`.

| type | fields |
|---|---|
| `kicker` | `text`: the small orange capitals above a hook |
| `title` | `text`, `size`, `width`, `underline`: hand-written heading |
| `text` | `text`, `size`, `width`, `font` (hand, mono or sans) |
| `chip` | `text`, `sub`, `icon`, `font`: a rounded pill (a letter, a tool name, a status) |
| `node` | `label`, `sub`, `icon`, `width`: a box for an actor (agent, server, gateway) |
| `circle` | `text`: a small round node |
| `bubble` | `text`, `side` (left or right), `width`: a chat bubble |
| `stamp` | `text`, `rotate`, `size`: a rubber stamp ("GUESS", "LEFT OUT") |
| `icon` | `icon`, `size` |
| `list` | `items: [text or { text, color }]`, `title`, `row`, `gate`, `font`: a stack or row of chips. With `gate: true` each item appears on its own beat (`show: list/0`) |
| `card` | `title`, `lines`, `highlight: [{ id, match, lines, color }]`: a dashed box of code-like lines |
| `arrow` | `from`, `to`, `label`, `labelSide` (below), `dashed`, `offset`: drawn from box edge to box edge, following moves |
| `packet` | `on` (an arrow), `label`, `reverse`, `dur`, `stay`: a pill that rides an arrow when it gets `travel` |
| `terminal` | `command`, `output` (verbatim), `show: "0-2,5-10"` (which output lines; gaps show as "…"), `clip`, `highlight: [{ id, match, lines, color }]`, `title`, `prompt`, `mask` |

Icons: agent, server, gateway, key, clock, cloud, warn, check, cross, user, log, model,
shield, sun.

### Beats

A beat is `{ at, ... }` with one or more of:

| key | effect |
|---|---|
| `show: [ids]` / `hide: [ids]` | pop in / fade out (`stagger: 0.2` spaces several out) |
| `ring: [ids]` | a ring pulses round each, "look here" |
| `focus: [ids]` | a dashed box round all of them, until the next `focus` (`focus: []` clears it) |
| `travel: [packets]` | send packets along their arrows |
| `dim: [ids]` / `undim: [ids] or all` | fade to the background, and back |
| `move: { id: [x, y] }` | glide to a new place (arrows follow) |
| `text: { id: "new text" }` | change what an element says |
| `color: { id: actor }` | recolour (a server that failed turns red) |
| `layout: split` / `layout: canvas` | bring the terminal in (landscape: right; vertical: under the canvas) or send it away; the canvas glides to make room |
| `run: terminalId` | the terminal types its command and prints its output |
| `mark: [highlightIds]` | light highlights in a terminal or card |

Only one terminal shows at a time: the one run last. Its command line stays pinned at
the top, and the output scrolls only to keep the latest highlight in view.

### Real output only

Paste terminal output exactly as the command printed it in the lab: run it in a
session, or against the lab's own services started from its `manifest.yaml`. Don't
edit it. Use `show` to pick lines and `clip` to shorten long ones on screen. Anything
token-shaped (`Bearer …`, `sk-…`, `api_key=…`) is masked to `••••••••` in commands,
output and cards before it reaches a frame. Add `mask:` regexes for anything else that
must not show. A `card` is an illustration (say so in its title); a `terminal` is a
real run.

### Captions

`captions: small` (the default) shows one plain subtitle line: in the safe lower area
of the vertical frame, and at the bottom of the landscape frame. `karaoke` shows big
2-4 word blocks with the spoken word highlighted. `off` shows none. Either way,
`<id>.vtt` holds the subtitles for a web player.

## Pace

All in `pace:` (seconds unless noted), file-wide or per video:

| key | default | what it is |
|---|---|---|
| `gap` | 0.7 | quiet between two segments |
| `maxPause` | 0.6 | longest pause kept inside one clip |
| `lead` / `tail` | 0.3 / 2.0 | quiet before the first word / hold after the last |
| `transition` | 0.4 | a cut between scenes |
| `minOutputHold` | 3.0 | terminal output stays at least this long after its last highlight |
| `minStep` | 3.5 | a step of a legacy `diagram` visual stays at least this long |
| `captionWords` | 4 | most words in one karaoke caption |
| `typing` | 28 | characters per second when a command is typed |

When a scene would close (or the terminal leave) too soon after its last highlight,
the next segment waits. A hold that can't be fixed that way is printed as a warning
naming the segment; `--strict` makes it fail.

## Narration

**Workers AI** (`voice: workers-ai:<speaker>`, default `workers-ai:arcas`): each
segment's `vo` is one `@cf/deepgram/aura-2-en` clip at natural speed. Pauses inside a
clip are capped at `pace.maxPause`, and the clip is trimmed to the speech. Whisper
(`@cf/openai/whisper-large-v3-turbo`) then gives word timings, which are aligned to the
script's own words. Everything is cached in `scripts/shorts/.cache/` (gitignored), keyed
by voice and text: TTS clips by model, speaker and words; timings by the clip's bytes
and how it was processed. Rendering a second format, or re-rendering after a visual
change, makes no API call.

### Pre-made narration (`voice: dir:<folder>`)

To use clips made elsewhere (for example the ElevenLabs "Mark" narrator the lesson
videos use), set `voice: dir:<folder>`, either file-wide or on one video. The folder is
relative to the `short.yaml`, else to the repository root. The renderer then makes no
speech: it only runs Whisper on each clip for word timings.

The folder must hold:

- **One audio file per segment**, numbered from 01 in segment order: `01.mp3`, `02.mp3`,
  `03.mp3`, ... (`.wav`, `.m4a`, `.ogg` and `.flac` also work). Each clip is one
  segment's `vo`, spoken as written.
- **`manifest.json`** with the text each clip was made from:

  ```json
  { "segments": [
      { "index": 1, "text": "Ask an AI agent: is it snowing in Leeds right now? ..." },
      { "index": 2, "text": "The fix is to give the agent a tool. ..." }
  ] }
  ```

The render fails, saying what to do, if the manifest lists a different number of clips
than the video has segments, if a clip file is missing, or if an entry's `text` differs
from the segment's `vo` (case, punctuation and spacing are ignored). That way a script
edit can't silently go out with stale audio. Use one folder per video. Leading and
trailing silence is trimmed, and pauses inside a clip are capped at `pace.maxPause`.

## Checking the result

- Run `--at` at a few beat times and look at the PNGs in both formats: nothing clipped
  or overlapping, the highlighted thing matches the word being spoken, and the terminal
  is readable.
- `ffprobe` each MP4 for its duration and an AAC stream.
- Sizes: the hand-written title is 58 px, chips about 34 px, node labels 42 px, and
  terminal text 26 px (25 px in landscape), on a 1000-wide grid that is scaled about 1×
  (vertical) or 1.2× (landscape).

The older one-screen-per-segment visuals (`visuals:` with `card`, `chat`, `agent`,
`diagram`, `terminal`, `code`) still render. A legacy `diagram` uses the lessons'
`dashboard/src/diagram.js`.
