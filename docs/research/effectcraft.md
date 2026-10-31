# EffectCraft, FilmCraft and SoundCraft for our explainer videos

Can an agent working from code in a Linux container, with no screen, use the ArtCraft "Crafting Apps"
to make our whiteboard shorts ([`docs/shorts.md`](../shorts.md)) better? **Yes.** All three run
headless here from their official Linux release tarballs. EffectCraft built and rendered one scene of
video 2's hook entirely over its MCP server. Written 2026-10-31.

**Short version**

- Keep our renderer as the backbone: it times every beat to the narration's words and writes
  captions, so the YAML-to-MP4 pipeline stays.
- Use **EffectCraft** for the few "hero" moments: hooks and the one big transition per video.
  There it gives us real motion blur, glow, physical easing and path morphing.
- Use **FilmCraft** as the owner's finishing editor. Our renderer can export a timeline for it.
- Use **SoundCraft** for narration loudness and polish.

---

## 1. What the three tools are (official sources)

All three are by the ArtCraft team (GitHub org `storytold`). They are written from scratch in Rust,
dual-licensed **MIT OR Apache-2.0**, and contain no FFmpeg. They are young: EffectCraft's first commit
was on 1 October 2026.

I read these sources:

- the READMEs on `raw.githubusercontent.com/storytold/<app>/main/README.md`
- EffectCraft's [docs/agents.md](https://raw.githubusercontent.com/storytold/effectcraft/main/docs/agents.md)
- the release `SHA256SUMS.txt` files
- the app pages on [getartcraft.com](https://getartcraft.com/apps/effectcraft)

The SourceForge mirror and the aiidelist review were not used: they are secondary sources.

| | [EffectCraft](https://github.com/storytold/effectcraft) | [FilmCraft](https://github.com/storytold/filmcraft) | [SoundCraft](https://github.com/storytold/soundcraft) |
|---|---|---|---|
| What | After-Effects-style compositor: keyframes, Graph Editor, 308 effects, shape layers, text animators, 3D, JS expressions | Premiere-style NLE: edit, colour, audio mixer, titles, captions | Pro-Tools-style DAW: multitrack, mixer, plugins, MIDI, bounce |
| Latest release (GitHub) | **v0.19.0** (getartcraft.com still lists 0.18.0) | **v0.15.0** (site lists 0.14.0) | **v0.15.0** (site lists 0.14.0) |
| Status (own words) | alpha; ~91% feature parity, "~45% ready for production work" | alpha; breadth ~86%, "ready for real work ~56%" | pre-alpha; ~40% of the way |
| Linux artefacts | AppImage, Flatpak, deb, rpm, tar.gz (x86_64, aarch64), riscv64 tar.gz | same | same |
| Build from source | Rust ≥ 1.95 (`cargo run --release -p effectcraft-cli`) | Rust ≥ 1.95 | Rust ≥ 1.95 for the UI (core 1.90), plus ALSA headers |
| Headless CLI | `effectcraft-cli` (info, exec, run, props, get/set, render-frame, render, script, mcp) | `filmcraft-cli` (exec, run JSONL, inspect, import, export, render, probe, mcp) | `soundcraft-cli` (run, script, convert, info, commands, mcp) |
| MCP | `effectcraft-cli mcp` (headless) or `--bridge PORT` to the live app; **27 tools** headless | `filmcraft-cli mcp`; **17 tools** (the `ui_*` ones need the app) | `soundcraft-cli mcp [--demo]`; **17 tools** |
| Project file | `.ecproj`: versioned JSON (`schema: 2`), readable but large (11 MB for our 11 s hook) | `.fcproj` (format in its docs/project-files.md) | `.scraft` session plus an `Audio Files/` folder |
| Interchange | Lottie import/export (`file.exportLottie`, `.json` or `.lottie`); timeline import/export FCP7 XML, FCPXML, OTIO, EDL, AAF, OMF; SVG paste as shapes | FCP7 XML, FCPXML 1.9–1.11, OTIO, CMX 3600 EDL, AAF, OMF; captions SRT/WebVTT/SCC | WAV/BWF/AIFF/FLAC in and out; MIDI, MusicXML; AAF/OMF still missing |
| Render / export | H.264, HEVC, AV1, ProRes 422/4444 **with alpha**, WebM VP9 **with alpha**; PNG/TIFF/EXR sequences; GIF; WAV | H.264 + AAC, ProRes 422 HQ, DNxHR, MXF, PNG sequences, GIF, WAV | mix or stems to WAV/AIFF/FLAC, with a report of peak, true peak and LUFS |

The tool lists below come from `tools/list` run in this container:

- **EffectCraft (27):** `list_commands`, `describe_command`, `execute_command`, `run_script`
  (After Effects-style JavaScript object model), `get_project`, `get_comp`, `get_layer`,
  `get_property`, `set_property` (value, keyframe or expression), `add_keyframe`, `add_effect`,
  `list_effects`, `list_fonts`, `get_state`, `render_frame`, `open_project`, `save_project`,
  `undo`, `redo`, `history`, `script_ui`, `batch` (several commands, one undo step, `$N.key`
  references), `command_list`, `command_run`, `render_preview`, `command_batch`, `doc_inspect`.
  There are 742 engine commands.
- **FilmCraft (17):** `command_batch`, `command_list`, `command_run`, `doc_inspect`,
  `media_import`, `project_inspect`, `render_frame`, `render_preview`, `sequence_inspect`, plus
  `ui_*` tools that need a bridged app. There are 711 commands.
- **SoundCraft (17):** `list_commands`, `execute`, `batch`, `inspect_session`, `new_session`,
  `open_session`, `save_session`, `import_audio`, `bounce_mix`, `parity`, plus UI tools. There
  are 482 commands.

**Audio.** SoundCraft has no text-to-speech, no voice cloning and no sound-effects library.
It does have:

- built-in instruments (a subtractive synth, a drum synth and a sampler)
- MIDI tracks, so a music bed can be written as notes from code
- processing plugins: EQ, compressor, de-esser, maximizer, reverbs and more

So narration stays with ElevenLabs or Workers AI. SoundCraft can clean the narration, set its
loudness and mix a bed under it.

---

## 2. Install in this container

The container is Ubuntu 24.04 (glibc 2.39) on x86_64 with 4 cores and no GPU. Everything came from
the official GitHub release downloads, checked against each release's `SHA256SUMS.txt`, and was
unpacked under the scratchpad:

```
github.com/storytold/effectcraft/releases/download/v0.19.0/effectcraft-0.19.0-linux-x86_64.tar.gz   sha256 OK
github.com/storytold/filmcraft/releases/download/v0.15.0/filmcraft-0.15.0-linux-x86_64.tar.gz       sha256 OK
github.com/storytold/soundcraft/releases/download/v0.15.0/soundcraft-0.15.0-linux-x86_64.tar.gz     sha256 OK
```

- **The tarballs are self-contained.** `bin/<app>` and `bin/<app>-cli` have no missing shared
  libraries, and no build was needed. FilmCraft's `install.sh` was *not* run: the CLI runs from the
  unpacked folder.
- **The GitHub API is blocked for these repos in this session.** Release downloads and
  `raw.githubusercontent.com` work, but `api.github.com` and `github.com/<repo>/releases/latest`
  answer 403. So release dates and notes could not be read here. Versions were found by probing
  release download URLs.
- **The board's font had to be installed by hand.** `Kalam` was converted from our
  `scripts/shorts/page/fonts/kalam-latin-700-normal.woff2` to TTF (fontTools) and copied to
  `~/.local/share/fonts/`. EffectCraft uses installed system fonts and does not read woff2.

Only the CLIs were tested. The desktop apps (egui) need a display, and none was tried.

---

## 3. What works headless

**EffectCraft 0.19.0**

These all worked:

- `effectcraft-cli mcp --empty` answers `initialize` and `tools/list`. Every edit went through
  MCP `batch`, `execute_command`, `set_property` and `add_keyframe`.
- Shape layers and Pen paths, repeaters, masks with feather, dashed strokes.
- Text in an installed font with small caps and paragraph boxes.
- Parenting, and the comp and layer motion-blur switches (shutter 180°, 16 samples).
- Effects: Gradient Ramp, Gaussian Blur, Fill, Glow, Linear Wipe.
- Expressions: `ease`, `easeOut`, `createPath()` on shape paths, `Math.*`, and `sourceText`
  expressions (the 200 → 30 counter).
- Importing a WAV and adding it as a layer.
- `effectcraft-cli render … --format h264 --audio on` writes clean H.264 + AAC (`ffmpeg -xerror`
  decodes it without error). PNG-sequence render works too.
- `file.exportLottie` works. It reports 207 warnings for this scene: expressions, Glow, Linear
  Wipe and audio do not go into Lottie. Bake expressions first with
  `prop.convertExpressionToKeyframes`.

Pitfalls found:

- Keyframe times snap to the nearest frame. Two keys less than one frame apart collapse into one.
- `keys.setEase` has no `timeBase` parameter.
- Prefer expressions for physical motion, such as a drop with a bounce. They are deterministic and
  easier to generate than tuning Bezier handles.

**FilmCraft 0.15.0**, headless with `filmcraft-cli run steps.jsonl`:

- made a 1080×1920 30 fps sequence
- imported the EffectCraft MP4 and **our WebVTT**, which became a caption track with 5 captions
- placed the clip on V1/A1 and added 6 named markers on the cue words
- exported **OTIO** (markers included; captions are not in OTIO) and **FCP7 XML**
- exported H.264: 11.3 s in 18.9 s, at 18 fps

**SoundCraft 0.15.0**, headless with `soundcraft-cli run`:

- imported the hook narration
- inserted de-esser, compressor and plate reverb
- bounced it in 0.46 s, reporting `lufs -22.2, true peak -6.3 dB`

Our narration is far below the usual short-video loudness target. A `maximizer` insert plus a
bounce can fix that in the same command.

**Not tried or not available:**

- GPU rendering (`--gpu`); this container has no GPU
- the desktop apps and the bridge or control-channel `ui_*` tools
- FilmCraft caption burn-in at export

---

## 4. Proof of concept: video 2's hook in EffectCraft

[`scripts/shorts/effectcraft/hook-poc.mjs`](../../scripts/shorts/effectcraft/hook-poc.mjs) is about
260 lines. It is a tiny MCP client: it starts `effectcraft-cli mcp`, builds the scene, saves
`.ecproj` and renders it. The cue times are the hook's word times from
`mcp-why-a-gateway.timeline.json`, so the picture lands on the same words as our render, and the
narration is the first 11.3 s of our final MP4.

```bash
node scripts/shorts/effectcraft/hook-poc.mjs --cli <dir>/bin/effectcraft-cli \
     --out <dir> --format both --audio hook.wav       # --no-render: project and stills only
```

The scene, beat by beat:

| Time | What happens |
|---|---|
| Start | Navy gradient, top light and the masked dot grid. The kicker and the title are on the board, with a dashed underline. |
| "Ten AI agents" | A scale wave runs down the 10 agent dots. |
| "twenty MCP servers" | 20 server dots pop in with overshoot. |
| "two hundred" | **200 paths** draw themselves on, staggered. Each path is one `createPath()` expression. "10 × 20 = 200 connections" wipes on. |
| "secret" | The yellow "200 secrets" chip pops in. |
| "One box" | The violet **MCP gateway** box falls with motion blur, squashes and bounces as it lands, sends out a ring and glows. |
| Right after | The middle vertex of every line slides into the box with a small overshoot, so the 200 lines **fold into 10 + 20**. The mesh turns from grey to violet with a glow. |
| To "thirty" | The counter rolls 200 → 30 and turns violet, and the chip dims. |

Outputs (not committed):

- `/tmp/claude-0/-home-user-cloudflare-sandbox-bridge/df72f384-93f2-5786-ae80-e07aea773876/scratchpad/ec-poc/out/hook-vertical.mp4`
  (1080×1920, 11.3 s, H.264 + AAC)
- `/tmp/claude-0/-home-user-cloudflare-sandbox-bridge/df72f384-93f2-5786-ae80-e07aea773876/scratchpad/ec-poc/out/hook-landscape.mp4`
  (1920×1080)
- `.../ec-poc/out/hook-vertical.ecproj`, `.../ec-poc/out/hook-landscape.ecproj` (open them in the
  desktop app to tweak)
- side-by-side with our current render: `.../ec-poc/out/compare-vertical.mp4` (left: current,
  right: EffectCraft) and `.../ec-poc/out/compare-landscape.mp4` (top: current)
- FilmCraft test: `.../fc-test/hook.fcproj`, `hook.otio`, `hook.xml`, `hook-fc.mp4`
- SoundCraft test: `.../sc-test/hook-processed.wav`, `hook.scraft`

### How it compares with our render (first 11.3 s of `mcp-why-a-gateway-vertical.mp4`)

| | Our renderer (HTML + Playwright + ffmpeg) | EffectCraft 0.19 over MCP |
|---|---|---|
| Motion | CSS-style eases. The direct mesh fades out and a separate hub mesh fades in. The box appears and moves. No motion blur. | The lines physically *re-route* through the box (one continuous morph), and the box falls with acceleration, bounce and squash. Real motion blur, glow, and a feathered wipe-on. The fold reads clearly as "200 become 30". |
| Look | Same palette, font and layout. Logo, captions and the end card are built in. | Same palette and font. No logo or captions in the PoC (both are possible: SVG paste, text layers), and it would need its own caption pass. The 200 grey lines at 40% show slight moiré, as ours do. |
| Effort | One YAML block: about 15 lines for the whole hook. | About 260 lines of generator code for one 11 s scene, plus learning the command set (about half a day). Each further scene costs much less once the helpers exist. |
| Build time | n/a | 4 s to build over MCP (about 300 tool calls) |
| Render time (4 CPU cores) | not re-measured. [`docs/shorts.md`](../shorts.md) says a 2-minute video takes "several minutes per format" | **77 s vertical, 86 s landscape** for 11.3 s (about 4 fps). The cost is motion blur at 16 samples plus 200 path expressions per frame. That is fine for one hook, but too slow to render whole videos this way. |
| Determinism | deterministic by design (`seek(t)`) | **deterministic**: the same frames (8.5–9.5 s, with motion blur) rendered twice gave byte-identical PNGs. Expressions depend only on `time`. |
| Editability by the owner | edit the YAML and re-render | open the `.ecproj` in the desktop app and use the Graph Editor, keyframes and effects |

**Verdict.** For a hero moment, EffectCraft clearly looks better: the motion is continuous,
physical and blurred. It is built and rendered entirely from code, deterministically. It does
not replace our renderer:

- our renderer's strengths are narration-timed beats from YAML, captions, page breaks and
  whole-video speed
- EffectCraft is alpha software released weekly, so it should be pinned

---

## 5. Recommendation

1. **Pin and fetch.** Add a `scripts/shorts/effectcraft/fetch.sh` that downloads one pinned
   release tarball (EffectCraft 0.19.0, and later FilmCraft/SoundCraft 0.15.0) from GitHub
   releases and checks it against `SHA256SUMS.txt`. Also install Kalam as a TTF (or commit a TTF
   next to the woff2). *Effort: 1 h.*
2. **Hero segments from EffectCraft (the main win).** Let a segment in `short.yaml` say
   `renderer: effectcraft` with a `scene` module (like `hook-poc.mjs`).
   - Generalise the PoC's helpers into a small library that maps our element types onto EffectCraft
     layers on the same 1000 × 700 grid. Start with `dots`, `mesh`, `node`, `chip`, `title` and `text`.
   - Read the cue times from `<id>.timeline.json`, so the timing stays shared.
   - `render.mjs` renders that segment's time range with EffectCraft (H.264, or ProRes 4444 / PNG
     with alpha to keep our captions and logo on top) and splices it in at the segment's
     `visualStart` with ffmpeg. Everything else stays as it is.

   Use it for hooks and the one "aha" transition per video only: 10–20 s per video at about
   80 s of render per format. *Effort: 2–3 days for the library and the splice, then about 1 h
   per hero scene.*
3. **Hand-off to the owner through FilmCraft.** Add `render.mjs --handoff`, which writes:
   - the per-segment MP4 clips (or the whole video)
   - the narration WAV
   - the VTT/SRT captions
   - a `filmcraft-cli run` JSONL that builds a `.fcproj` with V1, A1, a caption track and one
     marker per cue word, then exports OTIO and FCP7 XML

   This was proven headless in §3. With it the owner can retime, grade and re-cut in FilmCraft (or
   any NLE through OTIO or XML). Hero scenes also ship their `.ecproj`, so the owner can polish
   motion in EffectCraft's Graph Editor. *Effort: 1 day.*
4. **Audio polish with SoundCraft.** After narration is made, run it through `soundcraft-cli`
   (de-esser, compressor, maximizer to a loudness target) and read the LUFS it reports. Later,
   add an optional MIDI music bed under the voice. *Effort: 2–3 h for the loudness pass.*
5. **Do not adopt yet:**
   - Lottie as our main interchange: expressions and effects are dropped, so they would have
     to be baked first.
   - Whole-video rendering in EffectCraft: it is too slow on CPU and duplicates our timing
     engine.
   - The desktop and bridge workflows: they need a display.

   Re-check after the next few releases, because all three apps change every week.

**Risks:**

- **Alpha software.** Pin versions and keep our renderer as the fallback for every segment.
- **Large `.ecproj` files.** Generate them, never commit them.
- **The proxy blocks the GitHub API** for these repos in this environment. Use release URLs, or
  ask the owner to enable the repos if release notes are needed.
