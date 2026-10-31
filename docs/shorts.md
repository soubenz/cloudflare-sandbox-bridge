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
one running example**, drawn on a board that **builds up slowly**. Every narrated
phrase adds or animates one small thing on the word that names it: a chip pops in, an
arrow draws itself, a title writes itself on, a packet travels, a dashed box circles
what is being discussed, a ring pulses. When a board is full, a **page break** erases
it and a new page starts. Each actor has one colour everywhere, on chips, nodes,
packets and terminal highlights. Terminal output in a video is real.

The default look is the site's navy: `#0a0f2c` with a soft top light, a gentle navy
gradient and the site's faint dot grid. Outlines and text are a slightly bluish white.
`theme: black` gives the near-black of the KodeKloud reference.

The sample is `labs/see-how-tools-reach-an-agent/learn/short.yaml`: the four MCP explainers
of `docs/research/mcp-gateway-scripts.md` (what is MCP, why an MCP gateway, virtual servers,
when a tool fails) plus an A/B cut of the second one's hook. Each script row is one segment
and one board page, and the segment's `vo` is the row's VOICE word for word.

## Approval (owner rule, 2026-10-31)

Nothing is rendered or narrated until the owner has approved that video's transcript.

1. Write or change one video's script (docs/research/<topic>-scripts.md, or the lab's short.yaml).
2. Post the full spoken text of that video in chat, page by page, grouped by scene.
3. Revise it with the owner until they validate the transcript.
4. Ask the owner for the green light to build that video, and render only after a clear yes.

One video at a time: approval of one video's transcript or build never covers another video,
and any change to an approved transcript needs approval again.

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
theme: navy                     # navy (default) | black
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

A video may also set `endCard: { title, sub }` (default: the video's title and "Hands-on
lab · opalix") or `endCard: false`. The end card eases in over a dimmed board after the
last word.

Start each video with a question hook: a `kicker` (small orange capitals) and a
hand-written `title`, plus a picture that reads at a glance. Then set up the running
example. End with a recap ("Focus on what just happened.") and a one-line call to
action that opens the lab.

**Cues.** An `at:` is a phrase from the segment's `vo` (the beat lands just before its
first word is spoken; `phrase #2` picks its second occurrence) or a number of seconds
from the start of the segment's voice. Punctuation and case don't matter. A phrase
that is not in the `vo` fails the render, naming the segment.

### Pages

One board shouldn't carry everything. A scene can list `pages`, and each element says
which page it is on. Aim for 3-6 elements per page; more than `pace.pageMax` prints a
warning. An element with no `page` is a carry-over: it stays on the board across page
breaks, which suits a small running-example chip or tag.

```yaml
scene:
  pages:
    - { id: mesh }                                   # the first page is on show from the start
    - { id: bundle, title: "Support's bundle" }      # a title writes itself on as the page opens
  elements:
    a1: { type: node, page: mesh, label: Support, pos: [150, 300] }
    aB: { type: node, page: bundle, label: Support, pos: [190, 250] }
    tag: { type: chip, text: "toy-tools", pos: [880, 40], visible: true }   # carry-over
```

A beat turns the page:

```yaml
- { at: "But should every agent", page: bundle, transition: erase, pause: 0.8 }
```

| transition | what happens (in `pace.pageTransition`, 0.6 s by default) |
|---|---|
| `erase` (default) | a soft chalky band sweeps the board left to right; what it passes fades and drifts up |
| `slide` | the old page slides away to the left and fades |
| `zoom` | the old page shrinks a little and fades |
| `fade` | the old page fades |

The new page's elements then enter on their own beats (or with `visible: true`, as
the page opens). Arrows and packets go with the page of the element they start from.
The dashed focus box is cleared at each page break.

**Pauses.** `pause: <seconds>` on any beat opens that much silence in the narration
just before its cue word, and everything after it moves later. The beat itself fires as
the silence starts. Use 0.6-1.0 s at a page break so the wipe happens in quiet. A beat
with no `at` pauses before the segment's first word (use that, not the first word as
`at`, to pause at the very start).

When two cue words are closer than `minBeatGap`, put the pause on its own beat at the
second cue (`{ at: "and five servers", pause: 1.1 }`, then `{ at: "and five servers",
show: sl }`): the quiet opens at the phrase break and the element lands on its word.

**Title cards.** `card: { kicker, title, hold }` shows a brief title card over the
dimmed board between topics. The narration pauses for it: 0.5 s in, `hold` (default
`pace.cardHold`), and 0.5 s out. It can share a beat with a page break.

### Elements

Elements sit on a 1000 × 700 grid; `pos: [x, y]` is the element's centre. The grid is
scaled to the frame, so one scene serves both formats. Every element starts hidden
unless it has `visible: true`. Any element takes `color` (an actor from `colors`, or a
palette name: pink, yellow, cyan, green, blue, violet, orange, red, white, grey), `scale`
and `page`. On the navy theme, every palette colour keeps at least 5:1 contrast,
including on the lightest part of the gradient.

Entrances take `pace.enter` (0.7 s). Boxes and chips pop with a little overshoot,
text and titles write themselves on, and arrows draw from tail to head. A soft ring
then pulses on the element as it lands (`pace.pulse`; set `pulse: false` on one
element to skip it).

| type | fields |
|---|---|
| `kicker` | `text`: the small orange capitals above a hook |
| `title` | `text`, `size`, `width` (a number, or `auto` to fit the words), `underline`: a hand-written heading that writes itself on |
| `text` | `text`, `size`, `width`, `font` (hand, mono or sans) |
| `chip` | `text`, `sub`, `icon`, `font`: a rounded pill (a letter, a tool name, a status) |
| `node` | `label`, `sub`, `icon`, `width`: a box for an actor (agent, server, gateway) |
| `circle` | `text`: a small round node |
| `bubble` | `text`, `side` (left or right), `width`, `stamp`: a chat bubble (`stamp: "Guess"` lands a small stamp on its corner) |
| `chat` | `title`, `messages: [{ text, side, color }]`, `width`, `highlight`: a chat window; `mark` lights words in it |
| `box` | `label`, `size: [w, h]`, `dashed` (default true), `labelAt: bottom`: a box drawn round other elements (declare it before them) |
| `dots` | `n`, `size`, `gap`, `row`: a crowd of small dots (ten agents, twenty servers) |
| `stamp` | `text`, `rotate`, `size`: a rubber stamp ("GUESS", "LEFT OUT") |
| `icon` | `icon`, `size` |
| `list` | `items: [text or { text, color, icon }]`, `title`, `row`, `cols`, `gate`, `font`: a stack, row or grid of chips. With `gate: true` each item appears on its own beat (`show: list/0`); `ring`, `color` and `text` also take `list/0` |
| `card` | `title`, `lines`, `highlight: [{ id, match, lines, color }]`: a dashed box of code-like lines. A line may be `{ text, reveal: <highlight id> }`: its room is kept and it shows when that highlight is marked |
| `arrow` | `from`, `to`, `label`, `labelSide` (below), `labelSize`, `labelWidth` (wraps the label), `dashed`, `offset`: drawn from box edge to box edge, following moves |
| `mesh` | `from`, `to`, `via`, `stagger`, `dashed`, `width`, `opacity`, `label`, `labelPos`, `labelColor`: many lines at once, from every dot or list chip of `from` to every one of `to` (or each to and from a hub `via`), drawn `stagger` seconds apart; its `label` is a count that `text:` can change. Like arrows, meshes don't count towards `pageMax` |
| `packet` | `on` (an arrow), `label`, `reverse`, `dur`, `stay`, `lift`, `scale`: a pill that rides an arrow when it gets `travel` |
| `terminal` | `command`, `output` (verbatim), `show: "0-2,5-10"` (which output lines; gaps show as "…"), `clip`, `highlight: [{ id, match, lines, color }]`, `title`, `prompt`, `mask` |

Icons: agent, server, gateway, key, clock, cloud, warn, check, cross, user, log, model,
shield, sun, calendar, mail.

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
| `text: { id: "new text" }` | change what an element says (`{ id: { sub: "..." } }` changes a node's or chip's small second line) |
| `strike: [ids]` | a red line draws through each, corner to corner |
| `color: { id: actor }` | recolour (a server that failed turns red) |
| `layout: split` / `layout: canvas` | bring the terminal in (landscape: right; vertical: under the canvas) or send it away; the canvas glides to make room |
| `page: id`, `transition` | turn to another page (see "Pages") |
| `pause: <seconds>` | open a silence in the narration before this beat's word |
| `card: { kicker, title, hold }` | a brief title card between topics |
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

Slow is the default. Everything is in `pace:` (seconds unless noted), file-wide or per
video:

| key | default | what it is |
|---|---|---|
| `enter` | 0.7 | an element's entrance: pop with overshoot, write-on, draw-on |
| `pulse` | 1 | 1: a soft ring pulses on each element as it lands; 0: none |
| `packet` | 1.2 | seconds per hop for a travelling packet (or `dur` on the packet) |
| `beatHold` | 2.5 | a segment's last beat holds at least this long before the next voice starts |
| `minBeatGap` | 2.0 | warn when an element appears sooner than this after the one before |
| `pageTransition` | 0.6 | a page break |
| `pageMax` | 6 | warn when a page (or a scene without pages) has more elements than this, not counting arrows, packets and the terminal |
| `cardHold` | 1.4 | a title card's hold |
| `drift` | 4 | a very small, slow camera drift on the board, in grid units (0: still) |
| `gap` | 0.7 | quiet between two segments |
| `maxPause` | 0.6 | longest pause kept inside one clip |
| `lead` / `tail` | 0.3 / 2.5 | quiet before the first word / hold after the last (the end card shows here) |
| `transition` | 0.7 | a soft cross-fade between scenes |
| `typing` | 16 | characters per second when a command is typed |
| `minOutputHold` | 4.0 | terminal output stays at least this long after its last highlight |
| `minStep` | 3.5 | a step of a legacy `diagram` visual stays at least this long |
| `captionWords` | 4 | most words in one karaoke caption |

When a scene would close (or the terminal leave) too soon after its last highlight,
or a segment's last beat wouldn't get its `beatHold`, the next segment waits. A hold
that can't be fixed that way, a crowded page, or elements that arrive too close
together are printed as warnings naming the segment and the cue. `--strict` makes
warnings fail the render.

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
- Read the warnings: a crowded page or elements arriving close together means the
  script is rushing. Add a page, a pause or a sentence; don't speed the animation up.
- Sizes: the hand-written title is 58 px, chips about 34 px, node labels 42 px, and
  terminal text 26 px (25 px in landscape), on a 1000-wide grid that is scaled about 1×
  (vertical) or 1.2× (landscape).

The older one-screen-per-segment visuals (`visuals:` with `card`, `chat`, `agent`,
`diagram`, `terminal`, `code`) still render. A legacy `diagram` uses the lessons'
`dashboard/src/diagram.js`.

## Finish: loudness pass and FilmCraft hand-off

`scripts/shorts/finish.mjs` runs after a render. It polishes the narration with
[SoundCraft](https://github.com/storytold/soundcraft), puts it back into both MP4s, and builds a
[FilmCraft](https://github.com/storytold/filmcraft) project per video for the owner. See
[`docs/research/effectcraft.md`](research/effectcraft.md) for what these tools are.

```bash
node scripts/shorts/finish.mjs labs/see-how-tools-reach-an-agent/learn/short.yaml \
     --in scripts/shorts/.out                  # where render.mjs wrote the MP4s and VTTs
```

| Option | What it does |
|---|---|
| `--out <dir>` | where finished files go, one folder per video (default `<in>/finished`) |
| `--video <id>[,<id>]` | only these videos (default: every rendered video of the file) |
| `--lufs <n>` / `--true-peak <n>` | loudness target (default -14 LUFS) and true-peak limit of the final MP4 (default -1 dBTP) |
| `--fc-export <id>\|none` | export this video's vertical sequence from FilmCraft too, and compare it with the ffmpeg-muxed MP4 (default: the first video; about 5 minutes) |
| `--no-filmcraft` | audio pass only |
| `--fetch-tools` | ignore installed CLIs and use the pinned download under `scripts/shorts/.tools/` |

**Tools.** It needs `soundcraft-cli` and `filmcraft-cli` **0.15.0**. It looks on `PATH`, then in
`/opt/craft/<app>/bin` (where `scripts/setup-cloud-env.sh` installs them). If neither has the
pinned version, it downloads the official linux tarball from the GitHub release, checks it against
the SHA-256 pinned in the script *and* the release's `SHA256SUMS.txt`, and unpacks it under
`scripts/shorts/.tools/` (gitignored). It never uses a mirror. ffmpeg is still needed for muxing
and for the cross-checks.

**What it does, per video:**

1. Rebuilds the timeline with `render.mjs --check` (cached narration, no API call). It stops if
   the VTT next to the MP4 differs from the script's captions now, or if the narration WAV in
   `scripts/shorts/.cache/build/` has a different length: re-render first.
2. **SoundCraft pass** on that narration WAV (the raw mix, before the render's own `loudnorm`):
   a trim to about -20 LUFS, a gentle de-esser (6.5 kHz, at most 6 dB, about 1.5 dB less energy
   above 5 kHz), a gentle compressor (2.5:1, soft knee), then on a master track a gain to the target
   and the maximizer as a -1.5 dBFS ceiling. The master gain is found in 2-3 bounces, each read from
   SoundCraft's own bounce report (LUFS, peak, true peak). The output is a 48 kHz 24-bit stereo
   WAV with exactly as many samples as the input, and the script checks that no sample has moved.
3. **Mux**: the WAV goes into both MP4s as AAC 192k, with `-c:v copy`. The script checks that the
   video stream is byte-identical, the durations are unchanged, the audio lines up with the raw
   narration to the sample, nothing clips, and the first and last words are present.
4. **FilmCraft project** (`<id>.fcproj`) with two sequences, vertical and landscape, each with:
   - V1 "Picture": the finished MP4 (picture only)
   - A1 "Narration (SoundCraft)": the polished WAV on its own track
   - A2 "Music (empty)": a spare track for a bed
   - C1: the VTT as an English caption track
   - a marker at every page break (rose) and every cue word (green), named after the cue phrase,
     from the timeline
   Then it exports OTIO and FCP7 XML per sequence, the markers as CSV, and the captions as SRT.

Loudness is measured twice, by SoundCraft and by ffmpeg's `ebur128`, before and after; everything
goes into `report.json` (per video and for the whole run).

**Target.** -14 LUFS integrated with a true peak of at most -1 dBTP is the usual target for
short-form social video. It is a **convention, not a platform rule**: the platforms do not
publish a binding loudness spec for uploads, and those that normalise playback mostly turn loud
uploads down rather than quiet ones up. The render's built-in one-pass `loudnorm` left our videos
at about -16.7 LUFS, so the finish step is what actually reaches the target.

**Output** in `<out>/<id>/` (never commit it):

| File | What |
|---|---|
| `<id>-vertical.mp4`, `<id>-landscape.mp4` | the finished videos |
| `<id>-narration.wav` | the polished narration |
| `<id>.vtt`, `<id>.srt` | captions (SRT exported by FilmCraft) |
| `<id>-markers.csv` | page breaks and cue words (FilmCraft's marker CSV) |
| `<id>.fcproj` | the FilmCraft project; it points at the files in this folder, so keep them together |
| `<id>-vertical.otio`, `<id>-landscape.otio`, `<id>-*.xml` | the same timelines for other editors (OTIO carries markers, not captions) |
| `soundcraft/<id>.scraft` | the SoundCraft session with the chain, to adjust it by ear |
| `<id>-vertical-filmcraft.mp4` | only for `--fc-export`: the same sequence exported by FilmCraft |
| `<id>-landscape.jpg`, `report.json` | the poster frame, and every number the checks used |

**Results on the five MCP videos (2026-10-31).** The raw narration was at -27.0 to -27.7 LUFS, and
the rendered MP4s at -16.5 to -16.9 LUFS with a true peak of about -4 dBTP. After the finish step
every MP4 reads -14.1 LUFS and -1.2 to -1.3 dBTP, in both SoundCraft and ffmpeg. There are no
clipped samples, durations and video streams are unchanged, and the audio has no sample offset. A
whole run takes about 25 minutes on 4 cores, of which about 5 minutes are the FilmCraft export. The
FilmCraft export of `mcp-what-is-mcp` (vertical, H.264 CRF 18) matched the ffmpeg-muxed file:

- the same 5,086 frames
- audio sample-aligned
- SSIM 0.996 (0.995 when shifted by one frame)
- PSNR 50.5 dB
- the same loudness

**Quirks found in SoundCraft 0.15 and FilmCraft 0.15:**

- `mix.insert` ignores its `params`, so the script sets them with `mix.insert_params`.
- A mono track is panned into the stereo mix at -3 dB per side. Loudness is unchanged, but
  SoundCraft's peak reading for a mono file is 3 dB lower than ffmpeg's.
- SoundCraft decodes AAC about 60 ms short, so to meter an MP4 the script decodes it with
  ffmpeg first.
- A dynamic de-esser moves the phase of the sibilants. A full-band correlation can read that as a
  1-sample shift, so the sync checks use the band below 3 kHz.
- FilmCraft snaps clips to whole frames, so the WAV on A1 ends up to one frame (33 ms) early, in
  the silent tail. Its own export pads the audio to the video's length.
- FilmCraft takes marker colours from its own label set (Rose, Green, …), not "Red".
