# Shorts: vertical explainer videos from a lesson

`scripts/shorts/render.mjs` turns a lesson concept into a 1080×1920 TikTok/Reels-style
MP4 (H.264 + AAC, 30 fps): narration, big word-by-word captions, and one visual per
segment drawn from the lab's own material. The visuals are the lessons' animated
diagrams (drawn by `dashboard/src/diagram.js` with `dashboard/public/diagram.css`,
so they look exactly like the lessons), a terminal that types a command and prints
its real output, real source lines, a chat mock, and title cards.

The sample is `labs/see-how-tools-reach-an-agent/learn/short.yaml`.

## Render

```bash
npm ci                     # once: yaml + playwright (Chromium comes from PLAYWRIGHT_BROWSERS_PATH)
export CLOUDFLARE_API_TOKEN=...      # Workers AI; CLOUDFLARE_ACCOUNT_ID optional (else the token's first account)
node scripts/shorts/render.mjs labs/see-how-tools-reach-an-agent/learn/short.yaml --stills 6
```

| Option | What it does |
|---|---|
| `--video <id>[,<id>]` | render only these entries of `videos` (default: all) |
| `--out <dir>` | where MP4s and stills go (default `scripts/shorts/.out/`, gitignored) |
| `--stills <n>` | also save n representative frames as PNG next to each MP4 |
| `--at <t>[,<t>]` | save frames at these times only, no MP4 (fast way to check a layout) |
| `--check` | make the narration, check the length, write `<id>.timeline.json`; no frames |
| `--workers <n>` | browser pages drawing frames in parallel (default 3) |

A 45 s video takes about 4 minutes on 4 cores. Never commit a rendered video.

## How it works

1. **Narration.** Each segment's `vo` is one Workers AI text-to-speech clip
   (`@cf/deepgram/aura-2-en`, default speaker `arcas`). The clip is slowed or sped up
   by `voice.tempo`, every pause inside it is capped at `pace.maxPause` (0.28 s), and it is
   trimmed to the speech. Whisper (`@cf/openai/whisper-large-v3-turbo`) then transcribes
   the processed clip for word timings, which are aligned to the script's own words.
   Clips and timings are cached by content hash in `scripts/shorts/.cache/` (gitignored), so
   only changed words cost an API call.
2. **Timeline** (`scripts/shorts/timeline.mjs`). Clips are laid end to end with `pace.gap`
   seconds between voices. Each visual starts just before its segment's voice. Every
   `at:` cue becomes a time, and captions are split into 2-5 word chunks at punctuation.
3. **Frames.** `scripts/shorts/page/index.html` runs in Playwright's Chromium. `shorts.seek(t)`
   draws the frame for time t and nothing else: there are no timers, CSS transitions are
   off, and the diagrams' Web Animations are paused and set by hand. Several pages can
   therefore draw frame ranges in parallel. ffmpeg encodes each range, then the ranges are
   joined and muxed with the narration (loudness-normalised AAC).

## The 3-minute rule

Make one video per lesson concept, and keep each one at **180 s or less**. A
`short.yaml` holds a list of `videos`, so a lesson with several concepts gets several
entries. Each entry renders to its own MP4. If a video would run longer than 180 s,
the render fails before drawing a single frame, and the message names the segment to trim:

```
render: video "gateways" would run 184.3 s (narration 182.0 s), over the 180 s limit by 4.3 s.
Trim segment "deep-dive" (150.0 s of narration) by at least 4.3 s, or split this video in two.
```

Aim for 45-60 s. At the default pace that is about 120-150 words of narration.

## Writing a short

```yaml
voice: { speaker: arcas, tempo: 0.84 }      # file-wide defaults; a video may override
pace: { gap: 0.28, tail: 2.3 }              # seconds: between voices, hold on the last card
videos:
  - id: see-how-tools-reach-an-agent        # the MP4's name
    title: See how tools reach an agent
    segments:
      - id: hook
        vo: Your AI agent just made up the weather.   # spoken and captioned word for word
        visuals:
          - type: chat
            ...
```

Each segment has one `vo` (one clip) and a list of `visuals`. The first visual fills the
segment. A later one cuts in at its own `at:`, so a diagram can hand over to a terminal
mid-sentence. Cuts are quick zoom or slide transitions (0.22 s).

**Cues.** Any `at:` is either a phrase from the segment's `vo` (it lands just before
the first word of the phrase is spoken) or a number of seconds from the start of the
segment's voice. A phrase that is not in the `vo` fails the render, naming the segment.

### Visual types

| type | fields |
|---|---|
| `card` | `kicker`, `title`, `sub`, `brand`, `cta`. Each is a string, or `{ text, at }` to pop in on a cue |
| `chat` | `agent`, `status`, `messages: [{ from: customer\|agent, text, at }]`, `chip: { label, text, at }`, `stamp: { text, at }` (on the last agent bubble) |
| `agent` | `model: { icon, label }`, `tool: { icon, label, at }`, `missing: { label, at }` (the tool slot turns into a red "?"), `guess: { text, stamp, at }` |
| `diagram` | `id` (from `packages/catalogue/diagrams.json`), `title` (defaults to the diagram's), `steps: [{ n, at }]` (1-based; the first starts with the visual), `zoom` (max camera zoom, default 1.5), `height` |
| `terminal` | `command`, `output` (verbatim), `clip` (cut lines longer than this many characters, with " …"), `highlight: [{ match, lines, tone, at }]` (`match` and `lines` are regexes; `tone` is ok, bad, warn or default), `typing` (seconds), `height`, `prompt`, `title`, `mask: [regex]` |
| `code` | `from` (a repository path), `lines: "84-92"`, `lang` (python or js), `highlight: [{ lines: [a, b], at }]` |

Any visual can also take `callouts: [{ text, tone, at }]`, a pill that pops in under it.

The diagram camera eases onto what each step lights up (the lit nodes, both ends of
each lit edge, and the step's notes). This keeps node labels readable on a phone.

### Real output only

Paste terminal output exactly as the command printed it in the lab: run the command
in a session, or against the lab's own services started from its `manifest.yaml`. Do not
edit the output. Use `clip` to shorten very long lines on screen. Anything token-shaped
(`Bearer …`, `sk-…`, `api_key=…`) is masked to `••••••••` in commands and output
before it reaches a frame. Add `mask:` regexes for anything else that must not show.

### Checking the result

- `--at` a few times you care about, and look at the PNGs: nothing clipped, captions on
  the word being spoken, terminal text readable.
- `ffprobe` the MP4 for duration and an AAC stream.
- Captions are at least 64 px tall, terminal and code text 34 px. The stage sits between the
  brand mark (top) and the captions (lower third). The bottom ~240 px is kept clear for the
  platform's own overlay.
