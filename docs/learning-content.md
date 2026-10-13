# Learning content: the `learn/` folder

A lab can teach before it tests. The `learn/` folder gives a lab a short story, one lesson per concept, quiz questions that decide which lessons a learner can skip, and (for explore labs) the graded questions the console renders as a form.

Nothing here changes how a lab is graded. Checks still read the running system or `answers.json`. `learn/` only changes what the learner sees before and beside the lab.

## Layout

```
labs/<slug>/
  learn/
    story.md                 the case file: who, where, why it matters today
    concepts/<id>.md         one lesson per concept, file name = concept id
    quiz.yaml                diagnostic questions, several per concept
    questions.yaml           explore labs: the graded fields
    closing.md, closing.yaml optional closing story and comic, shown after the lab
    games.yaml               optional games, played after the closing
  workspace/answers.json     explore labs: the template the fields fill
```

`labs learn-check labs/<slug>` compiles the folder and prints every problem at once. `labs publish` runs the same check and refuses a lab that fails. `npm test` compiles every lab that ships a `learn/` folder.

## Concept ids

A concept is one idea a learner can know or not know. Ids live in `packages/catalogue/concepts.json`, shaped `skill.some-name`, where `skill` is a skill id from `packages/catalogue/paths.json` (the `skill` of a module, or of a path without modules). A lesson or question naming an id not in that file fails the check, so add the concept there first. Keep a concept small enough that one lesson (2 to 4 minutes) teaches it and two or three questions test it.

## story.md

```markdown
---
title: Monday at Larkfield
minutes: 2
---
You start on Monday. Maren hands you a laptop and a ticket…
```

- `title` up to 80 characters, `minutes` 1 to 10, body up to 2,600 characters.
- Write in second person, past or present, one fictional company per path (see the story bible for the path).
- The story sets the stakes and names the task. It teaches nothing the lessons do not; a learner who skips every lesson can still read it in two minutes.

## concepts/&lt;id&gt;.md

```markdown
---
id: gateway.routing-aliases
title: Model aliases and routing
minutes: 3
recap: An alias is a stable name that the gateway maps to a real model.
---
Lesson body…
```

- `id` must equal the file name without `.md`.
- `recap` is one line, up to 160 characters. When a learner already knows the concept, the lesson collapses to this line.
- Body up to 2,600 characters. Explain with the lab's own system, not in the abstract. End with what the learner will see in the lab.

Lessons play in file-name order. An optional `order: <n>` in the front matter (a whole number; lower plays first, default 100, ties keep file-name order) moves a lesson earlier or later without renaming it. The foundation lesson below uses `order: 1`.

### Foundation lesson

Every lab's first lesson explains what the subject is, from scratch, right after the story. It assumes no prior knowledge: a plain definition with one everyday analogy, the problems the thing solves (each tied to a scene in the story), what it does step by step, where it sits, and the few terms the lab uses, ending with what the learner will do. Give it `order: 1` and its own concept id (`gateway.what-is-a-gateway` is the model). The other lessons then assume it and open with a sentence that bridges from it instead of repeating the definition.

## quiz.yaml

```yaml
questions:
  - id: q-alias-purpose
    concept: gateway.routing-aliases
    type: single            # single or multi
    prompt: What does a model alias give the callers of a gateway?
    options:
      - { id: a, text: A stable name that survives a change of model }
      - { id: b, text: A faster model }
      - { id: c, text: A cheaper price per token }
    answer: [a]
    explanation: Callers keep one name while the model behind it changes.
    diagnostic: true        # default; false = never asked up front: it is asked in a later round, after its lesson
```

Rules the checker enforces:

- Every lesson needs at least one `diagnostic: true` question, otherwise it can never be skipped.
- Write **at least two questions per concept** (three is the model). The flow asks one question per concept up front (Round 1) and the rest after the lesson, so a concept with a single question is asked once and never again, and the rounds after the lessons have nothing to ask. Keep one or two of them `diagnostic: false` when they only make sense once the lesson has been read (a "what happens next" or "why does it do that" question).
- Keep the whole quiz to about three questions per lesson. Rounds hold five questions (never more than six), so a quiz much longer than that is cut short: whatever does not fit in the last round is not asked.
- Every question's `concept` must have a lesson in the same lab.
- 2 to 6 options with unique ids; option text up to 160 characters; prompt up to 300; explanation up to 420.
- `single` has exactly one answer. `multi` has two or more and never every option.
- Plain single-line text only. No markdown or HTML inside questions.

Write the wrong options as real misconceptions, not throwaways. A learner who picks one should learn something from the explanation.

## questions.yaml (explore labs)

```yaml
answers_file: answers.json
fields:
  - key: support_deployment
    prompt: Which deployment serves the `support` alias?
    kind: choice            # text, number or choice
    choices: [a, b]
    help: Look at the view page under Services.
```

- Each field is one key of the lab's `workspace/answers.json` template. The console writes the learner's answers into that file through the files API, so the existing checks keep working unchanged.
- The compiler cross-checks in both directions: every key in the template needs a field, and every field needs a key.
- `choices` is required for `choice` and forbidden otherwise. `options` (2 to 4 suggested answers, text and number fields only) shows them as buttons next to "Something else", which opens the usual box; the stored answer is the button's text or what the learner typed. Up to 12 fields.

## The motion comic (optional): `learn/comic.yaml`

The story can also be told as a motion comic that plays like a short audio story with pictures: a camera moves across a comic page and zooms into each panel as it pops in, **one storyteller** tells the story over it, the people in the panels **speak their bubbles in their own voices** (when the lab's narration includes them) while the bubbles type out on screen, and the learner sees Replay, Skip and a Sound toggle. The art is drawn by the console from code, so a comic is a few lines of data per panel, never an image. `learn/story.md` stays required: it is the fallback for screen readers, for a skipped comic and for older consoles.

### Who tells it, and who speaks

The story is a team's: a calm storyteller tells it, and the people in it speak their own lines.

- **The storyteller** (the narrator) is not a character: the words are the `voiceover` of each panel, read by one voice. With Workers AI that is `thalia` (`NARRATOR_VOICE` in `src/labs/comic-kit.ts`); with the cast's voices it is the narrator of `packages/catalogue/voices.json` (Mark). The storyteller is calm, plain and never jokes (see `video-prompt.md`).
- **The characters speak their bubbles.** Every bubble whose `who` has a voice in the cast is spoken aloud in that person's own voice when the lab's narration includes bubble clips (imported with a manifest that names who speaks each clip, see [Narration](#narration-the-storyteller)). The learner (`you`) is drawn and may have a bubble, but is never voiced; a bubble with no `who` is never voiced either. A narration without bubble clips (Workers AI, or an import of the voiceovers alone) keeps every bubble as text, exactly as before.
- **The cast.** Only these may appear in `cast` or as a bubble speaker in a comic with a voiceover:

| id | Who | Personality (one line) | Voice (`voices.json`, model `higgsfield/elevenlabs`) | Drawn as |
| --- | --- | --- | --- | --- |
| `maren` | Maren, platform lead | Warm and direct; briefs you and keeps the team calm. | Helena `3c2b83c0-2e0a-5ae8-998a-a5fe71b7eccd` | dark swept fringe, cobalt jacket |
| `tomasz` | Tomasz, staff engineer | Built most of it; dry, precise, knows where every log lives. | Bram `549ff70a-3ee7-4f04-a4d9-89a24fab7709` | brown hair, round glasses, teal |
| `graham` | Graham, head of engineering (the boss) | Asks the blunt question nobody wants: who, how much, and when is it fixed. | Sterling `dc382508-c8bd-443c-8cb2-46e57b8d2e6f` | grey-silver hair, short beard, charcoal blazer and tie, older |
| `ollie` | Ollie, engineer | Well-meaning and eager; the one who makes the mistakes, and owns up. | John `6b528d43-c056-4a2f-9d82-1591a7ba13b0` | messy blond hair, big grin, orange hoodie, headphones round his neck |
| `jess` | Jess, product manager | Excitable; wants it shipped by Friday, and asks the customer's question. | Gracie `09878754-f20b-5330-9790-58a8027ab5b2` | curly auburn hair in a high bun, mustard cardigan, lanyard |
| `priya` | Priya, head of Support | Kind; speaks for the customers who are waiting. | Remy `b9c5c5db-4eb7-468a-a0b7-d06423af0335` | long dark hair, support headset, rose |
| `you` | You, the learner | The new platform engineer; never voiced. | none | a plain dark silhouette |
| (narrator) | The storyteller | Calm, plain, no jokes. | Mark `27c04473-84a9-4b60-a41f-c8e8458bd4f1` | not drawn |

- **Finance (Jonas) and data protection (Anneke) are retired from the cast.** They are never drawn and never speak. The story still has them: the voiceover mentions them ("Jonas in Finance asked us...") or a caption names them, and a `message` panel can show their note arriving while the voiceover says who it is from. `labs learn-check` refuses `jonas` and `anneke` in `cast` or as a bubble speaker, with the message "retired: use maren, tomasz, graham, ollie, jess, priya or you; mention them in the voiceover or caption instead". (The names still parse so that a comic that has no voiceover yet keeps working until it is rewritten; see [Moving an old comic over](#moving-an-old-comic-over).) Priya is back in the cast.

The voices live in one file, `packages/catalogue/voices.json`: `{ "model", "narrator": { "name", "voice" }, "cast": { "<id>": { "name", "voice" } } }`, one entry per speaking person (everybody above but `you`), every voice different (`src/labs/voices.ts` checks it). `name` is the voice's own name in that service, `voice` its id, which is stored with each clip and is part of the clip's key. Change a voice there and plan and import the lab again (`labs narrate --plan`, then `--from-dir`).

### The panel

```yaml
title: Which provider answered?
panels:                         # one page; for several pages write `pages:` (below)
  - scene: desk                 # desk, message, portrait, screen, duo, you, black, diagram or clip
    cast: [tomasz]              # who is drawn: maren, tomasz, graham, ollie, jess, priya or you (none for screen and you scenes)
    caption: Tuesday, a little after ten.
    voiceover: On Tuesday morning Jonas in Finance asked us a question that nobody on the team could answer.
    bubbles:
      - { who: tomasz, text: "Which provider answered, and what did that reply cost?" }
    lines: ["$ $ $", "?"]      # what the screen shows
  - scene: message
    cast: [maren]
    prop: envelope              # none, envelope, laptop, chart, map, key, document
    sfx: PING!
    voiceover: Then a note from Priya arrived. Support could not say either, and I did not like that.
    bubbles: [{ who: maren, text: "Nobody can answer this." }]
```

Each panel has up to four things to say, and they differ:

| Field | What it is | How it is shown | Limits |
| --- | --- | --- | --- |
| `voiceover` | What the storyteller **says** over the panel. This is how the story is told. | **Spoken** by the one narrator voice, first on its panel (and part of "Read as text"). Not drawn on the panel. | Optional, plain single-line text, up to 240 characters |
| `caption` | A short **label** on the picture: a time, a place, the call to action. | Fades in at the panel start. **Never spoken.** | Optional, up to 100 characters |
| `bubbles` | A short line someone in the panel says. The humour lives here. | Typed out word by word, and **spoken in the speaker's own voice** when the narration includes bubble clips (after the voiceover, one after the other). The learner's bubble and one with no `who` are text only. At most two a panel. | `who` (one of the cast, in the panel's `cast`; optional), `text` up to 150 characters (90 or fewer recommended: it is spoken) |
| `lines` / `sfx` | What a screen shows, one line per entry; a sound-effect word slammed onto the panel. | Typed on the screen; slammed in with a shake (and a [sting](#stings) with `sound`). Never spoken. | up to 6 lines of 44 characters; `sfx` up to 14 |

More than one page:

```yaml
title: Which provider answered?
pages:
  - title: Tuesday morning        # optional heading shown when the camera turns the page
    panels: [ ... ]
  - title: The call
    panels: [ ... ]
```

| Scene | Panel size | Cast | Needs |
| --- | --- | --- | --- |
| `desk` | wide (2 of 3 columns) | 1 (any of the cast) | optional `lines` for the screen |
| `message` | square (1 column) | 1 | optional `prop`, `sfx`; the sender is named in the voiceover |
| `portrait` | square | 1 | optional `prop`, `sfx` |
| `screen` | wide | none | `lines` (typed out one by one) |
| `duo` | square | 2 | |
| `you` | wide | none | `lines`; the last panel shows the call to action |
| `black` | wide | none | `captions` (see [Black cards](#black-cards)) |
| `diagram` | wide | 0 or 1 | `diagram` (see [The diagram scene](#the-diagram-scene)) |
| `clip` | wide | 0 to 2, not drawn (they name who speaks) | `clip` (see [The clip scene](#the-clip-scene)) |

A `screen` or `you` scene draws nobody, so it needs no cast. A `message` scene still has one of the cast in the room with the envelope: the person who wrote the note is spoken about in the voiceover (bubbles need a speaker who is in the cast).

### Writing the voiceover

Start from the writing prompt in `video-prompt.md`: it fixes the shape (an opener shows problems and ends by asking "is this normal?"; a closing introduces the answer and walks one example through it), the voice (plain, calm teaching sentences, every term explained on first use, no jokes in the voice track), and the picture rule (every panel is an ON SCREEN | VOICE | BUBBLE triple, concept panels are diagrams). The rules below are the format limits the prompt points to.

- **A voice-over for the team.** The narrator is not a character: no "I", no name. "We" and "our" are fine ("our support assistant"). The drawn characters speak only in bubbles, in their own voices; the narrator never jokes, the bubbles may.
- **Bubbles are spoken lines.** Keep each to 90 characters or fewer (150 is the hard limit) and at most two a panel: each is a clip that plays after the voiceover, so a long one holds the panel up. Write them as people talk: Graham's blunt question, Ollie owning up, Jess's "can we still ship it?".
- **Short and natural.** One or two sentences, about 35 words at most (the hard limit is 240 characters). One idea a panel; the next panel carries the next.
- **Spell numbers and sizes** the way you would say them: "three in the morning", "four teams", "two hundred". No digits for amounts of money, counts or times that you want read out.
- **No code, symbols or file names.** Say "the gateway log", not `gateway.log`; no slashes, underscores, backticks, `$` or `%`. Put the exact text on a screen `line` instead and let the voiceover say what it means.
- **No hard acronyms.** Say "the model provider" when you can. If you need one the learner knows ("API", "EU"), use it sparingly.
- **Do not repeat the caption or the bubble.** The caption is the label, the bubble is a quote, the voiceover is the telling. A bubble is a line someone says out loud in the picture ("Which provider answered?"); the voiceover is Maren saying what is going on.
- **No answers to a graded question** and the story bible: Larkfield, second person for "you".

A comic is **5 to 12 panels** and **one page**, unless the story really turns (a page with a title card for "The call", say), in which case two. A comic with a voiceover, or with a black card, a diagram or a clip panel, may have at most 12 panels in all (black cards, diagram and clip panels count as panels: they are cards in the story's flow).

### Rules `labs learn-check` enforces

- 1 to 6 pages, 1 to 12 panels on a page, at least 4 panels in all, and **at most 12 in all once any panel has a `voiceover` or the comic uses a `black`, `diagram` or `clip` card**. Panels flow in reading order into rows of three columns (wide counts 2, square 1). Any count works: a wide panel that does not fit the rest of a row starts the next row, and a row that is not full sits in the middle of the page, so there is nothing to balance by hand.
- A voiceover is at most 240 characters. Speakers must be in the panel's cast, and cast and speakers are only `maren`, `tomasz`, `graham`, `ollie`, `jess`, `priya` and `you` (see above). At most two bubbles per panel, 150 characters each, plain text. Under 130 bubble words on a page and under 520 in all.
- Every panel says something (a voiceover, a caption, a bubble or screen lines). `sfx` is for `message`, `portrait`, `desk` and `clip` panels. A `screen` or `you` panel needs `lines`.
- Narration is optional: a comic with no `voiceover` anywhere is valid and plays without sound.
- A narration that voices bubbles voices **all** of them: once any bubble clip is in `audio.json`, every bubble of a speaking person (anyone of the cast but `you`) needs its clip, in that person's one voice (not the narrator's), with the bubble's exact words. A missing one fails, naming it: `learn/audio.json voices some bubbles but not panel 2 bubble 2 of comic.yaml (Jess: "Can we still ship on Friday?"): ...`; a bubble whose words or speaker changed since is "out of date".

Lines on a screen are coloured by how they start: `$` is a command, `200` or `ok` is green, `4xx`, `5xx` or `error` is orange or red. Use `?` where the lab wants the learner to find the value.

### Cues: timing a part to the voice

A `caption`, an `sfx`, each bubble and each screen line can name a **cue**, a phrase of the panel's voiceover; on a narrated panel it then appears when the storyteller says it. Plain strings stay valid; the object forms carry the cue:

```yaml
  - scene: desk
    cast: [maren]
    voiceover: At three in the morning the phone rang, and the bill had tripled since Friday.
    caption: { text: "Saturday, 03:12.", cue: "three in the morning" }
    sfx: { text: BZZT!, cue: "the phone rang", sound: phone }
    bubbles: [{ who: maren, text: "Not again.", cue: tripled }]
    lines: [{ text: "spend: x3", cue: "the bill" }, "since: Friday"]
```

- A caption, sfx or screen line **starts on the first word** of its phrase: the clip's start plus the same fraction of the clip as the phrase's place in the voiceover. A bubble **pops just after the phrase** (its last word), so it reacts to what was said.
- Times are clamped inside the clip. Bubbles keep their spacing and typing pace, screen lines never start before the line above is typed; when cues collide the order is kept and the later one is pushed (the panel stays up until it, and the hold, are done).
- A part with no cue keeps the usual timing. Cues only matter on a narrated panel: without narration, or on a panel with no voiceover, the comic plays exactly as before.
- `labs learn-check` fails a cue that is not in the voiceover (case and spacing do not matter), or a cue on a panel with no voiceover, naming the panel and the element: `comic panel 1 (desk): bubble 1 has the cue "on monday", which is not in the voiceover`.

### Shots

`shot: close` pushes the camera in on the panel (about 1.35 times closer) once it has arrived, over the usual move time: for a detail, a face, a number. `shot: wide` frames the panel's whole row of the page from its start: for a reveal. Without `shot` the camera frames the panel as ever. Shots are part of the comic's camera schedule (`comic-timeline.js`), so Replay, Skip and reduced motion treat them like any other move.

### Black cards

`scene: black` is a wide dark card with nobody drawn, for a cliffhanger or a montage's tally: its `captions` (up to five, 80 characters each, plain or `{ text, cue }`) appear one under the other, on their cues, or spread evenly over the voiceover when they have none (without narration, evenly over the panel's time). An optional `title` (60 characters) heads the card. The transcript reads the title and the captions in order. `labs learn-check` needs captions on a black card and refuses `captions` or `title` on any other scene.

```yaml
  - scene: black
    title: Is this normal?
    captions: [{ text: "The bill tripled.", cue: tripled }, { text: "Nobody was told.", cue: nobody }, "Nobody could say who."]
    voiceover: The bill tripled, nobody was told, and nobody could say who spent it.
```

### Stings

An `sfx` can make a short sound, a **sting**, with `sound:` one of `phone`, `ping`, `thud`, `register`, `whoosh`, `pop` or `tick`. The console synthesises it (no audio files; `dashboard/src/comic-sfx.js`), 80 to 400 ms long and about 14 dB under the storyteller, at the sfx's moment (its cue, or the usual sfx time). A comic with stings has the Sound toggle too. Stings never play while the sound is off, under reduced motion, while the comic is paused or finished, or before the learner has tapped the comic once (a browser allows sound only after a tap); Skip stops nothing, they are short. One sting per beat, never two, and the voice never describes a sound the viewer hears.

### Moods, poses and the night

A cast entry is an id (`maren`) or `{ who, mood, pose }`: `mood` is `tired`, `worried`, `pleased` or `surprised` (brows, eyes and mouth), `pose` is `phone`, `typing` or `shrug` (what the hands do). Both are optional; every check that counts or matches the cast reads the `who`. `bg: night` draws a dark sky (a moon, a lamp, the glow of a screen).

```yaml
    cast: [{ who: maren, mood: tired, pose: phone }]
    bg: night
```

### The diagram scene

`scene: diagram` (wide, nobody or one presenter in `cast`) shows a diagram of `packages/catalogue/diagrams.json` and steps through it, so a concept panel shows the concept, not a person: `diagram: <id>` and an optional `steps:` list, one entry per step to show (the first N steps of the diagram), each `{ cue }` or `{}`. Steps start on their cues, or spread evenly over the voiceover (without narration, over the panel's time); with no `steps` every step of the diagram is shown, evenly. The transcript reads the diagram's title and the captions of the steps it shows. `labs learn-check` fails an id that is not in the library, and more steps than the diagram has.

```yaml
  - scene: diagram
    diagram: gateway-what-it-does
    steps: [{ cue: every team }, { cue: checks the key }, {}]
    voiceover: With one front door, every team sends its calls to a gateway, which checks the key and then calls the provider.
```

### The clip scene

`scene: clip` (wide) fills the panel with a short generated animation from the shared **clip library**, `packages/catalogue/clips.json`: a few seconds of video, or a still image, made once with an AI video tool and reused by any lab. The player is the editor: every word on a clip panel is the console's own overlay, drawn and timed exactly like on any other panel, so one clip can carry different words in different labs.

```yaml
  - scene: clip
    clip: night-office-still                 # an id of packages/catalogue/clips.json (required)
    cast: [{ who: tomasz, mood: tired }]     # optional, 0 to 2 of the cast; NOT drawn, only bubble speakers
    voiceover: Late on Sunday Tomasz opened the gateway log, and one line told him which team it was.
    caption: { text: "Sunday, 23:47.", cue: "late on sunday" }
    bubbles: [{ who: tomasz, text: "There you are.", cue: "one line" }]
    sfx: { text: TICK, cue: opened, sound: tick }
    lines: [{ text: "team: search", cue: "the gateway log" }]   # a small screen card over the clip, typed like a screen
    shot: close
```

- **Fields.** `clip` is required on a clip scene and refused on every other scene. `cast` (up to two of the cast, with `mood` and `pose` allowed) is never drawn: it is there so bubbles have speakers, and the retired people are refused even in a comic with no voiceover. `bubbles`, `caption`, `sfx` (with `sound` and `cue`), `lines` (a small screen card at the top right, typed like screen lines, coloured by how they start) and `shot: close | wide` all work and are timed by their cues as on any panel; a clip never changes a panel's length. `captions` and `title` stay black-card only, `diagram` and `steps` diagram only.
- **The library.** `{ "clips": [ { "id", "kind": "video" | "image", "src", "poster"?, "alt", "seconds"?, "loop"?: true } ] }`. `id` is like a diagram's (lowercase letters, digits, hyphens, up to 40). `src` and `poster` are paths the console serves: `/media/clips/<file>` (a video `.mp4` or `.webm`; an image or poster `.webp`, `.png`, `.jpg`, `.jpeg` or `.avif`). `alt` (240 characters, plain) says what the clip shows; it is the clip's text in **Read as text**, read before the panel's caption, voiceover, bubbles and screen lines. `seconds` is the clip's length until the video knows its own. `loop: true` (videos only) loops it while its panel is on; without it the clip rests on its last frame when it ends. The library is checked by `src/labs/clip.ts`; `labs learn-check` fails an id that is not in it: `comic panel 3 (clip): clip "no-such-clip" is not in packages/catalogue/clips.json`.
- **The files** live in `dashboard/public/media/clips/`, which the console Worker serves as static assets (`dashboard/wrangler.jsonc` `assets.directory` is `./public`) at `/media/clips/<file>`, behind the sign-in like every page. Keep a clip small: a few seconds, 720p or less, a few MB (Workers serves no single asset over 25 MiB; `test/unit/console-comic-clip.test.ts` checks every file exists, is tracked, is the type its name says and is under that limit). The CSP needs nothing more: `default-src 'self'` covers a video of the console's own origin, `img-src 'self'` a still.
- **To add a clip:** generate it (a short, silent, loopable shot is best), export it small (an `.mp4` plus a `.webp` poster of its first frame, or a still `.webp`), put the files in `dashboard/public/media/clips/`, add an entry to `clips.json` with an `alt` that says what is seen, and reference its `id` from a panel. **Keep text out of the generated picture**: no captions, signs, screen text or logos. All words are overlaid by the player (they stay sharp, translatable, accessible and correct), and the picture is cropped to the panel (`object-fit: cover`), so keep what matters near the middle.
- **How it plays.** A video is muted and inline (`playsinline`, `preload="metadata"`), and plays only while the comic's clock runs and its panel is on (from the panel's start to its end); the comic's Pause, a hidden tab and a scrolled-away comic pause it. Whenever it is not playing, and when it drifts, it is set to the frame the clock says: `(clock time - panel start) mod length` during the panel, its last frame from the panel's end on (and so on Skip); so a seek, Replay and Skip land on the same frame as playing there would (`clipTimeAt` in `comic-timeline.js`). A still is pushed in slowly (a Ken Burns move) by the panel's progress, a CSS transform set from the clock, so it is the same picture at the same second. Under reduced motion a clip shows its poster (or a still frame) and nothing moves. A clip that fails to load shows its poster, and failing that a plain dark panel that reads its `alt`; a console whose library lacks the id plays the panel's words over a plain dark panel. The comic is never broken by a clip.
- **Tests.** With `?comicTest=1` no video is ever played: `window.__comicClock.clips` lists the clips (`{ panel, id, start, end }`) and `clipLog()` what the player would have played and paused (`{ type: 'play' | 'pause', panel, id, at, offset }`).

### Moving an old comic over

The comic used to be read by several voices (a narrator for captions, each person for their bubbles). That contract is retired for new work but still validates, so a lab keeps working until it is rewritten: a comic with **no `voiceover`** keeps the old rules (anybody of the cast list, the retired included, may be in it, up to 36 panels) and its old `learn/audio.json` is still accepted by `labs learn-check` and `labs publish`. The console does not play that old narration (it plays such a comic silent, with no Sound toggle). To move a lab over: write a `voiceover` on each panel (the storyteller's, see [Writing the voiceover](#writing-the-voiceover)), drop the retired people from `cast` and the bubbles (mention them in the voiceover instead), then run `labs narrate`. As soon as one panel has a `voiceover`, the comic is held to the new rules and the old-shape `audio.json` is refused ("out of date ... run `labs narrate`"); `labs narrate` writes the new one and deletes the old clips.

### How it plays

The console (`dashboard/src/comic.js`) lays the whole comic out as one reel (every page a sheet of paper, one under the other) and plays it on a single clock; the schedule is a pure function in `comic-timeline.js`, so a panel's start, each word of a bubble and the camera at any second are the same every time.

- **Camera.** It starts on the first page, flies to each panel as it pops in, and zooms to fit it. Between pages it flies down to the next sheet (and to its title card, held a moment, when the page has a `title`). After the last panel it pulls back until the whole comic is in frame, and the frame grows to fit it. Without narration a panel stays up for `panelSeconds(words)` of every word it shows (bubbles, caption and screen lines; a voiceover is heard, not read, so it adds none). Bubbles type word by word, speaker after speaker; screen lines type one after another; the caption fades in at the panel start; a `sfx` word slams in with a shake.
- **Replay and Skip** are the playback controls. Skip goes straight to the finished comic (every page drawn, every bubble typed). Replay starts again from page 1. A thin progress bar and a timecode (`m:ss / m:ss`) show where it is; they are not controls. The comic plays by itself when it first shows, waits while its tab or the page is hidden, and stops its clock when it is finished or when the learner leaves the screen. One more button exists only on a narrated comic (see [Narration](#narration-the-storyteller)): the **Sound on / Sound off** toggle, a documented exception because browsers need a way to turn sound off.
- **Read as text.** Under the stage, a disclosure lists the transcript of every panel (the same text `labs learn-check` reads: `Panel 3. <caption> <voiceover> Maren: <bubble> On screen: ...`, with a `Page 2: Title.` line per page when there are several), so the whole story, including what the storyteller says, can be read. The stage itself is one image with the comic's title; the animation is hidden from screen readers, and the transcript is its equivalent. The text story from `story.md` sits under that, folded under "Read the story as text", and is the whole story when a lab has no comic or the comic cannot be drawn.
- **Reduced motion.** With `prefers-reduced-motion: reduce` the comic starts finished: every page drawn, no camera, nothing typing, the same buttons (Skip is then off; Replay plays it as cuts from panel to panel, still without travelling or typing).
- **Narrow places.** The stage is as wide as its container. In a narrow container (the story step in a window narrowed to a few hundred pixels) the frame is squarer, the words of a wide panel are drawn larger so that bubbles stay about 13px on screen and captions 11px or more, and the camera pushes in on a screen once what is said has been said.

### Narration (the storyteller)

A comic can be read aloud: by the storyteller alone (Workers AI, `labs narrate`), or by the storyteller and the cast, each person speaking their own bubbles (clips made in any text-to-speech tool from `labs narrate --plan` and imported with `labs narrate --from-dir`). The voices are made once, by an author, and committed; nothing calls a model when a lab is published or played.

```
export CLOUDFLARE_API_TOKEN=...      # a token that may run Workers AI; never commit it
                                     # CLOUDFLARE_ACCOUNT_ID is read from the environment, else from wrangler.jsonc vars
npm run opalix -- labs narrate labs/<slug> --dry-run         # what it would make, and how many characters
npm run opalix -- labs narrate labs/<slug>                   # make it
git add labs/<slug>/learn/audio.json labs/<slug>/learn/audio
```

- **Who says what.** One storyteller reads the `voiceover` of every panel that has one; with the cast's voices each bubble of a speaking person is spoken too, in that person's voice (comic-kit `spokenLines`: per panel the voiceover, then the bubbles in order). Never a `caption`, `lines` or `sfx`, never the learner's bubble. Plain `labs narrate` (Workers AI) makes the voiceovers only: its bubbles stay text. The voice is set in one place, `src/labs/comic-kit.ts`: `NARRATOR_VOICE` (a Workers AI `@cf/deepgram/aura-2-en` speaker, `thalia`, a female voice) with `TTS_MODEL` for the model. Other female Aura-2 voices to try: `athena`, `luna`, `helena`, `andromeda`, `juno`, `vesta`. `narrationLines(comic)` there is the one definition of what is spoken.
- **What it writes.** `learn/audio/<key>.mp3`, one file per distinct (model, voice, text), where `<key>` is the first 16 hex digits of the SHA-256 of `model\nvoice\ntext`; and `learn/audio.json`: `{ model, clips: { <key>: { who?, voice, text, seconds, bytes } }, lines: [{ panel, kind: "voiceover", clip }, { panel, kind: "bubble", bubble, clip }] }`, where `lines` has one entry per voiced panel in reading order (`panel` counts across pages from 0) and, with the cast's voices, one `bubble` line per spoken bubble after its panel's voiceover (`bubble` is 0 or 1). A clip's `who` is `narrator` or the speaker's id; the single-voice shape has no `who` (its clips are the narrator's) and stays valid. Identical words in the same voice share a file.
- **When to run it again.** Whenever a `voiceover` changes, or the voice or the model is changed in comic-kit (changing the voice makes every clip anew). Changing a caption or a bubble needs no new narration. It only makes the clips that are missing (a second run with nothing changed makes no network call and rewrites nothing) and deletes the clips nothing uses any more. `labs learn-check` and `labs publish` refuse a lab whose `audio.json` no longer matches the comic's voiceovers word for word, or whose clip files are missing, and say to run `labs narrate`, so a voice can never say words the story does not have.
- **Clips from another text-to-speech.** `labs narrate labs/<slug> --from-dir <clips> --model <id> --voice <id>` files clips made elsewhere (ElevenLabs, say) exactly as if `labs narrate` had made them, with no token and no network call. `<clips>` holds `01.mp3`, `02.mp3`, ... in voiceover order, and `closing/01.mp3`, ... for the closing; or a `manifest.json` (`{ "model", "voice", "clips": [{ "file", "text" }], "closing": [...] }`) that matches each file to its voiceover by its exact words and refuses words the comic does not have. Model and voice are stored as given (`"model": "elevenlabs/eleven_v4"`) and are part of each key, so reuse, orphan removal and the stale check work as above; a number of clips that is not the number of voiceovers is refused, and `--dry-run` lists file, panel and key. `labs learn-check` holds an imported narration to one voice throughout, and `labs publish` is unchanged. After a voiceover edit, import again. A plain `labs narrate` refuses a lab whose `audio.json` or `closing-audio.json` names a model other than Workers AI's (it would make every clip anew and remove the imported ones); delete those indexes, or pass `--replace`, to re-narrate it with Workers AI.
- **The cast's voices: plan, make, import.** `labs narrate labs/<slug> --plan` prints (or with `--out <file>` writes) every line to make, as JSON, for the opener and the closing: per panel the voiceover (who `narrator`), then each bubble of a speaking person, once per distinct speaker and words, each with the file to save it as, the voice id and the voice's name from `packages/catalogue/voices.json`:

  ```json
  {
    "lab": "labs/<slug>",
    "model": "higgsfield/elevenlabs",
    "voices": { "narrator": "27c0...", "maren": "3c2b...", "tomasz": "549f...", "graham": "dc38...", "ollie": "6b52...", "jess": "0987...", "priya": "b9c5..." },
    "clips": [
      { "file": "01-narrator.mp3", "who": "narrator", "name": "Mark", "voice": "27c0...", "panel": 1, "text": "On Monday the bill for the weekend reached our head of engineering." },
      { "file": "02-graham.mp3", "who": "graham", "name": "Sterling", "voice": "dc38...", "panel": 1, "bubble": 1, "text": "Who signed off on this?" }
    ],
    "closing": [ { "file": "closing-01-narrator.mp3", "...": "..." } ]
  }
  ```

  Generate each line in that voice with any text-to-speech tool, save it under its `file` in one folder, and save the plan there as `manifest.json`. Then `labs narrate labs/<slug> --from-dir <folder>` imports it. The manifest form that names who speaks is `{ "model"?, "voices"?, "clips": [{ "file", "text", "who" }], "closing"?: [...] }`: `who` is `narrator` or a cast id (no `who` means `narrator`); `voices` is `{ narrator, maren, ... }` and defaults to `voices.json` (whose model is then the default model too; for another model give both `model` and `voices`); `voice`, `name`, `panel` and `bubble` on a clip are what `--plan` writes and are ignored, except that a `voice` must be its speaker's. Clips are matched to the comic by **(who, words)**, not by order; a clip whose words are not that speaker's line, a speaking bubble with no clip, two speakers sharing a voice or a speaker with no voice are refused before anything is written. `--voice` (one voice for all) does not go with this form. The single-voice forms (`NN.mp3` with `--model` and `--voice`, or a manifest with `voice` and no `who`) work as before and voice no bubbles.
- **Cost.** Workers AI bills text-to-speech by the character. A comic of 5 to 12 voiceovers of up to 240 characters is a few hundred to about three thousand characters, so a lab costs a cent or so; only changed voiceovers are paid for again. `--dry-run` prints the character count first. Each clip is limited to 400 KB and a lab to 80 clips.
- **Where the files go.** `labs publish` uploads the clips beside the bundle (the bundle carries `audio.json` as `learn.audio`); the Worker validates them (names, sizes, MP3 content, exactly the set `audio` names) and stores them at `labs/{slug}/{version}/audio/<key>.mp3`. See [the API](api.md#narration-clips). The console plays them from `/api/audio/<slug>/<key>.mp3`.
- **How it plays with the cast's voices.** On a panel with a bubble clip the clips play one after another, never two at once: the storyteller's first (0.6 s into the panel, as above), then each bubble in the panel's order, starting `TIMING.speakerGap` (**0.35 s**) after the clip before it ends (the first bubble 0.6 s in when the panel has no voiceover). A spoken bubble **pops and types when its clip starts**, its words typed over the clip (never slower than the reading pace), and its speaker's mouth moves while the clip plays; its `cue` is not used (keep cues for comics whose bubbles are text). A bubble nobody voices (the learner's) takes its turn in the same order, typed at the reading pace. The panel lasts until the last clip has ended plus the usual hold (2 s), or its reading time if that is longer. Pause, seek, Skip, Replay, the Sound toggle and the test seam work as for the voiceovers: `__comicClock.audio` lists every clip, bubble clips included, each with `kind` (`voiceover` or `bubble`), `bubble`, `who` (`narrator` or the speaker), `panel`, `start`, `end` and `url`. A narration with no bubble clips plays exactly as below.
- **How it plays.** The storyteller runs on the comic's own clock (`dashboard/src/comic-timeline.js` and `comic-audio.js`). A voiced panel's clip starts **0.6 s into the panel**, once the picture has landed. The panel stays up for the larger of what it takes to read everything it shows and the clip's end plus the usual hold (`TIMING.hold`, 2 s), so no panel is ever cut before its clip ends, and the silence between one voiceover and the next is never less than `TIMING.breath` (0.5 s; in practice the hold plus the 0.6 s lead, so the storyteller pauses between panels like a person turning a page). The panel's bubbles appear as text and type out starting **0.8 s after the clip starts**, one after the other, at the reading pace (`TIMING.word`, 0.2 s a word), clamped so the last bubble is done by the clip's end plus one second; if there are more bubble words than fit, they type faster, never slower than the voice allows. The caption fades in at the panel start. Skip, Replay, a seek, a hidden tab, Sound off and leaving the screen stop the clip, and exactly one narrator clip plays at a time. A clip that cannot load is skipped in silence. A lab without narration plays exactly as before.
- **If the narration cannot be trusted the console plays the comic silent, whole.** If the narration is not of the words in the comic (other words, a panel without a voiceover, a voiceover without a clip, a bubble clip whose speaker is not the bubble's, a comic whose bubbles are partly voiced, or any line of the old caption-and-bubble shape), the console turns all of it off rather than play part of it: no sound, no Sound toggle, the ordinary silent schedule.
- **The Sound toggle** sits beside Replay and Skip, only on a narrated comic. It is named for its state (**Sound on** or **Sound off**), is pressed when on, is on by default and is remembered (`localStorage` `opalix.comicSound`).
- **Autoplay.** The comic tries to start sound by itself. If the browser refuses (it wants a tap first), a small non-modal **Tap to turn the sound on** button appears in the frame; tapping it, or Replay, or the toggle, starts the clip where the clock is. With `prefers-reduced-motion: reduce` no audio plays by itself (the comic starts finished); Replay plays it hard-cut, with its audio.
- **Always text too.** Captions, bubbles and "Read as text" (which includes the voiceovers) are all still there, so nothing depends on hearing.

Tests drive the voice without sound: with `?comicTest=1` the player never calls `play()`, and `window.__comicClock.audio` lists the scheduled clips (key, kind, bubble, who, start, end), `audioLog()` what it decided to play and stop, and `?comicAudio=blocked` makes play() refuse as a browser does (`test/e2e/19-comic-audio.spec.ts`, which carries its own small comic and narration in `test/e2e/comic-fixture.ts`). Stings are not synthesised in a test either: `__comicClock.stings` lists them (`{ panel, sound, at }`) and `audioLog()` has a `{ type: 'sting', sound, at }` entry for each one the player would have played. Clip videos are never played in a test (`__comicClock.clips`, `clipLog()`; see [The clip scene](#the-clip-scene)). `comic-fixture.ts` `V2` is a comic with one panel of each v2 feature, a clip panel among them; `CAST_COMIC` with `castNarrationOf` is a comic of the new cast with the narration a manifest import writes (every speaking bubble voiced).

## Closing comic (optional): `learn/closing.md` and `learn/closing.yaml`

A lab can end with a second story: what the case turned out to be. `closing.md` has the same front matter as `story.md` (`title`, `minutes`, a body), and `closing.yaml` is a comic of exactly the shape of `comic.yaml` and is held to the same rules (its problems are reported prefixed `closing:`). Both files are needed: `closing.yaml` without `closing.md` is an error, as is the reverse.

`labs narrate` (and `--plan`, and `--from-dir`) narrates the closing in the same run as the opener: its clips go into the same `learn/audio/` (same 16-hex keys, a line both comics say is one file) and its index into `learn/closing-audio.json`, the shape of `audio.json`. A clip either comic uses is kept. `labs learn-check` refuses a `closing-audio.json` that no longer matches `closing.yaml`, and the 80-clip limit counts both comics together. Commit `closing-audio.json` with `audio.json`.

## Games (optional): `learn/games.yaml`

Up to six small games, played after the closing. A lab with games needs a closing and has no `questions.yaml` fields. Every game has an `id` (lowercase, unique across the lab's games), a `title`, a `prompt` (shown as the game's one-line goal) and an `explanation` shown on its end screen; `kind` picks one of four shapes. The fields marked optional can be left out: a game without them plays with the defaults.

```yaml
games:
  - kind: sort                       # one card at a time: drag or swipe it to a bucket
    id: who-pays
    title: Who pays?
    prompt: Put each call where its cost lands.
    explanation: The gateway bills the team that owns the key.
    host: tomasz                     # optional: maren, tomasz, graham, ollie, jess or priya (default tomasz)
    timer: 8                         # optional: seconds a card (default 8; 0 = no clock)
    buckets: [{ id: team, label: The team }, { id: platform, label: The platform }]   # 2 to 4
    cards:                                                                             # 3 to 10, bucket must exist
      - { id: c1, text: A call with the team key, bucket: team, why: The team's key is on the call. }  # why optional
  - kind: flag                       # one card at a time: left (leave it) or right (flag it)
    id: spot-the-leak
    title: Spot the leak
    prompt: Flag the lines that leak a secret.
    explanation: Keys never belong in logs.
    timer: 10                        # optional (default 10; 0 = no clock)
    choices: { flag: Leaks a secret, leave: Safe }   # optional: the words of the two sides (default Flag it / Leave it)
    board:                           # optional, 1 to 4: a live status board above the cards
      - { name: OpenAI, status: down }               # status: up or down
      - { name: Anthropic, status: up }
    items:                           # 3 to 10; at least one flagged and one not; why is optional
      - { id: a, text: "key=sk-123", flag: true, why: A raw key. }
  - kind: sliders                    # move the inputs, watch the readout, answer a question
    id: daily-cost
    title: What a day costs
    prompt: Move the sliders.
    explanation: Calls times price is the bill.
    inputs:                          # 1 to 4; min < max, default between them; unit optional
      - { id: calls, label: Calls a day, min: 0, max: 1000, step: 10, default: 100 }
      - { id: price, label: Price per call, min: 0, max: 1, step: 0.01, default: 0.1, unit: USD }
    formula: [{ input: calls, op: "*" }, { input: price, op: "*" }]   # folded left; the first op is ignored
    readout: { label: Daily cost, unit: USD, decimals: 2 }
    ask: { prompt: Which input moves the bill most?, answer: calls }  # answer is an input id
    target: { value: 50, tolerance: 1 }   # optional: a readout to dial in first; closeness scores points
  - kind: order-and-nest             # order the steps in the pipeline, nest them, send a call through
    id: request-path
    title: Follow one request
    prompt: Order the steps and nest them.
    explanation: The gateway wraps the provider call.
    steps:                           # 3 to 10; exactly one root (parent: null), parents exist, no cycles,
      - { id: gw, text: Gateway receives the call, parent: null, order: 0 }   # siblings have distinct order
      - { id: alias, text: Alias resolves, parent: gw, order: 0 }
```

All text is plain single-line text, as in `quiz.yaml`. `host`, `timer`, `choices`, `board`, a card's `why` and `target` are optional; `timer` belongs to sort and flag, `choices` and `board` to flag, `target` to sliders.

### How a game plays

Every game opens on its title, its goal (the `prompt`), its host (a small bust of the `host`, who reacts to each answer with a mood and a speech bubble) and its rules, with a Start button and a 3, 2, 1 count-in. While it plays it shows the score, a progress bar, Sound and Timer toggles (Sound is the comic's own setting, `opalix.comicSound`; Timer is remembered as `opalix.gameTimer`), and for sort and flag a combo meter and three hearts.

- **sort and flag**: the cards come one at a time. A card goes to a side by dragging or swiping it, by tapping the side, or with ← and → (1 to 4 when a sort has more than two buckets). A flag's left side is "leave it" and its right side "flag it" (or the words of `choices`), so the data is the same `flag: true/false`. A right card scores 100, up to 50 more for speed when the clock is on, times the combo (x1.25 for each card in a row, up to x2). A wrong card, or a card whose clock runs out, costs a heart, shows the right side and the card's `why` (or "That one is: <bucket>"), and comes back at the end of the deck. The round is won when every card is in its place; it is lost when the hearts are gone (Try again starts a new round).
- **order-and-nest**: the steps start shuffled in the pipeline. Drag a step (sideways nests it), use its arrow buttons, or from the keyboard focus it and press Space to pick it up, the arrows to move it (← and → nest it), Space to drop it and Escape to put it back. "Send it through" sends a call down the pipeline: it stops and bounces at the first step out of place, or comes out the end when every step is in order at its level. No hearts; fewer sends, more stars.
- **sliders**: move the sliders and watch the readout (with a `target`, a meter shows how close it is), then pick the slider that moves it most. Points for closeness (500, or all 500 with no target) and for the answer (500 first time, 250 second, 100 after).

The end screen shows one to three stars (sort and flag: 3 with no mistake, 2 with one, 1 with more; order-and-nest: 3 for one send, 2 for two, 1 for more; sliders: 3 for the right slider first time and the target within 90%, 2 by the second try, 1 after), the score, the best score kept in this browser, a recap of every item with its right answer and its `why`, the `explanation`, and Play again and Continue.

Under reduced motion nothing slides, flies or shakes and the feedback is immediate; the game is the same otherwise. Every action is also a button or a key, and a live region says each card, each verdict and the hearts left. The Timer toggle turns the clock off for anyone who needs more time. For end-to-end tests, `?gameTest=1` in the page address (or `window.__opalixGameTest = true`) skips the count-in, the clock, the delays and the sound.

### Solving, skipping and finishing

A game is solved when a round is won (every card in its place, the call straight through, the right slider). The console records the first solve with `tries`, the rounds played to it. The games only go forward: there is no way back from a game to the closing story or to an earlier game, only Back to labs. "Skip this game" (before Start and during play) moves on to the next game, and on the last game finishes the warm-up; the first game also has "Skip all games", which skips every game not yet solved and finishes. A skipped game says "Skipped" when it is shown again, and can still be played and solved.

"Finish the warm-up" sends every game: `{ id, solved: true, tries }` for a solved one, `{ id, solved: false, skipped: true, tries: 0 }` for a skipped one. The warm-up is done when every game is solved or skipped. In the completion a skipped game's result passes with weight 0 and the message "skipped": the warm-up still counts as finished (the path moves on), but a skipped game adds nothing to its score, and one with every game skipped scores 0. XP is earned per lab, not per game: there is no XP for a game, played or skipped, and finishing the warm-up earns its completion XP either way.

## Trimming the brief

Once the lesson teaches a concept, the brief stops explaining it. The brief keeps: what is running, the tools, what done looks like, the pressure sentence if any. Target 300 words or fewer for an explore lab.

## What the learner sees

1. The platform onboarding quiz (once, branching, a few questions at most) sets a starting level per module.
2. Before a lab starts, "Before you begin" shows the story (the motion comic, or the text story), then **alternates rounds of questions and lessons**: Round 1 (up to five questions), the first lessons full screen (the whole width of the console, the text on the left and its diagram large on the right from 1280px wide), Round 2, the next lessons, and so on. "Start the lab" is the last step. See [How the pre-lab flow alternates](#how-the-pre-lab-flow-alternates). A lab with a story and no lessons goes from the story to Start; one with lessons and no story begins at its first round or its lessons; one with no questions is story, lessons, Start.
3. Concepts answered correctly collapse to their recap. The others expand as lessons. The learner can press "I know this, skip" on any lesson, or "Show me the lesson anyway" on a collapsed one. The quiz decides the default; the learner decides the outcome.
4. Mastery is stored in the learner's browser. Nothing is graded on it.
5. The story and the lessons are read there and nowhere else: the session's guide, a reading pane beside the workspace window, has no Story or Lessons tab (an explore lab's tabs are Brief, Questions, Hints; any other lab's Brief, Checks, Hints). A learner who rejoins a running lab goes straight to it.

## How the console shows it

The learner console (`dashboard/`) renders all of the above in the browser. The bundle arrives through the console Worker, which reads it with the service key and never sends anything about the learner to the API:

| Console route | API call | Notes |
|---|---|---|
| `GET /api/learn/:slug` | `GET /labs/:slug/learn` | a `404 no_learn` passes through; the console then boots the lab as it always did |
| `GET /api/onboarding` | `GET /learn/onboarding` | a `404` or any failure means no quiz is offered |
| `POST /api/learn/answers` | `POST /learn/answers` | only the validated body is forwarded (at most 60 answers, 16 KB), with no user, subject or address |
| `POST /api/prepare` | `POST /sessions/prepare` | `{ lab }` plus the cookie's subject as `user_id`; answers `202 { prepared: true }` with no session id or token. Warms the lab up (see below); an API refusal is passed through and ignored by the page |
| `POST /api/prepare/cancel` | `POST /sessions/prepare/cancel` | `{ lab? }` plus the cookie's subject; `POST` so a closing tab's `sendBeacon` can send it. The API ends the user's pre-warm only if it has not begun |

All three need the console cookie like the other `/api` routes. The launcher's `has_learn` flag comes through `GET /api/labs` unchanged; a lab without it never asks for a bundle. The same route adds, to every lab, the learner's `progress` and (when the API says which plan they are on) `plan: 'free' | 'pro'`, plus `bypass: true` for the owner's own subject: the catalogue shows a Pro lab as locked for a free learner unless `bypass` is set.

- **Platform quiz** (`onboarding.js`). Shown once after the first sign-in when the quiz exists; "Skip for now" is on every screen and is remembered; "Retake the quiz" sits next to the help control in the header and in the "?" dialog. It branches (see [The platform onboarding quiz](#the-platform-onboarding-quiz)): a checklist of the areas the learner has worked with, then at most two questions per ticked area. Its outcome is a level per quiz skill (strong, familiar or new; the quiz skills are `quiz` in `concepts.json`), which the personal path and the profile use. "Start here" and the launcher's "Suggested start" chip both point at the module that holds the learner's next lab (the profile's `next_lab`).
- **Before you begin** (`before-you-begin.js`, with the order in `learn-flow.js`). Between Start and the boot: the story, then rounds of questions alternating with chunks of the lessons (`learn-lessons.js`, full screen, with a count of the lessons read in the chunk). A lesson for a known or skipped concept folds to its `recap` with "Show me the lesson anyway"; the others show in full with "I know this, skip". Every step has a Back button (to the story, the questions or the lessons before it; inside a round, to the previous question) and "Back to labs"; answers are kept, so Back never asks a question again and never posts one twice. The session starts only when "Start the lab" is pressed (the last lessons' button, or the last question's when the flow ends on a round); "Skip all, just start the lab" is on every step. Any failure to fetch the bundle goes straight to the boot.

  **The lab is warmed up while the last steps are read.** The first time the second-to-last step (`prefetchStepIndex` in `learn-flow.js`; the only step when there is one, never for "Skip all") or a later one comes on screen, the page calls `POST /api/prepare` once per visit, silently and ignoring any failure: the API boots a container and parks it (see [Pre-warming](api.md#pre-warming)), so the later Start is answered from it. Leaving without Start (Back to labs, a route change, or the page closing, by `sendBeacon` on `pagehide`) calls `POST /api/prepare/cancel`; it is not sent once Start was pressed, and the API refuses to end a lab that has begun, so a late beacon is harmless. A warm lab is invisible: the browser never receives its id, so there is no Rejoin card and no "lab running", and a phone warms nothing. An unstarted warm lab is reclaimed by the API after ten minutes.
- **In the session** (`questions-form.js`, `session-layout.js`). The guide has no Story or Lessons; for a lab with `fields` it has a Questions tab, one card per question with a Not answered / Answered / Saved badge: a form that writes `workspace/<answers_file>` as JSON after 600 ms of quiet and on Save. A write re-reads the file first and merges by key: a key the learner changed in the form wins, a key they did not touch keeps what the file holds now, and keys the form does not know are kept. Number fields store a JSON number (or `null` when empty), text a string (or `null`), choice the chosen choice string.
- **Mastery** (`learn-model.js`) lives in the browser under `localStorage['opalixLearn']`: onboarding levels, per-concept `known` (true only when every diagnostic question about the concept was answered correctly), and the learner's own `skipped` / `forced` overrides, which always win. Nothing is sent and nothing is graded; the anonymous outcomes that do go to `POST /learn/answers` carry no identity.
- **Lesson and story text** (`markdown.js`) is drawn straight into DOM nodes (no HTML is ever parsed): paragraphs, `##` and `###` headings, bold, italic, code, fenced code, lists, `http(s)` links and `::diagram[id]` lines. A diagram id that is not in the library becomes a short notice.

## How the pre-lab flow alternates

`planLearningFlow(learn, mastery)` (`dashboard/src/learn-flow.js`, pure and unit tested in `test/unit/console-learn-flow.test.ts`) returns the ordered steps; `before-you-begin.js` only draws them.

```
story -> Round 1 -> lessons part 1 -> Round 2 -> lessons part 2 -> Round 3 -> Start the lab
```

- **Rounds.** A round holds at most 5 questions. The questions are cut into fives; when the last round would hold only 1 or 2 questions they are folded into the others and the rounds are evened out (11 is 6 and 5, 12 is 6 and 6; no round ever holds more than 6). A round with no questions is skipped, and no question is asked twice. A lab with 5 questions or fewer has one round before its lessons, and the lessons are then one chunk: story, Round 1, all the lessons, Start.
- **Round 1** draws diagnostic questions one concept after another in lesson order (the foundation lesson's concept first) and round again, so each concept is asked about once before any is asked about twice. Its answers set the mastery record as before: a concept whose Round 1 questions were all answered right is known and its lesson folds to the recap; a miss leaves it open. (Only Round 1 sets mastery. Later rounds are practice: they are posted to the same analytics call and do not change what is folded.)
- **Lessons** are cut, in lesson order (the `order: 1` foundation lesson first), into min(lessons, rounds - 1) chunks as even as possible (5 lessons in 2 chunks is 3 and 2). Each chunk is followed by a round of questions about its own concepts that were not asked yet, `diagnostic: false` ones included; whatever the earlier rounds left over goes into the last round. A concept the learner already knows (from an earlier visit) is not asked about again, and a chunk whose questions are all gone has no round after it (its lessons join the next chunk's).
- **What a learner sees.** Every question gives its feedback and explanation at once and is headed "Round 2 of 3 · question 3 of 5" (just "Question 3 of 5" when there is a single round). Quiet dots across the top show the whole flow (story, rounds, lessons, a ring for Start); "Step N of M: ..." is said to screen readers at each step. Rounds are a centred column about 760px wide; the lessons stay full width.
- **Writing for it.** For a 5-lesson lab, 15 questions (three per concept) make three rounds of five with two lesson chunks. Two questions per concept is the least that works: one for Round 1, one after the lesson. A lesson with a single question has it asked up front and nothing to ask about it afterwards.
- **Back, refresh and links.** Back keeps the answers; a refresh returns to the same step with the same plan and answers (kept in this tab's `sessionStorage` under `opalix.flow.<slug>`, dropped when the lab starts or the learner leaves). The address is `/labs/<slug>/story`, `/questions` or `/lessons`, with `?step=N` (the step's place in the flow, from 1) for any step that is not the first of its kind; see [console routes](console-routes.md). A step number out of range opens the first step.

## The platform onboarding quiz

The one-time quiz every learner sees first is not a lab's `quiz.yaml`: it is `packages/catalogue/onboarding.json`, shared by all labs, validated by `parseOnboarding` (`src/labs/learn.ts`) when the API serves it and again by `npm test`. It is short and adaptive, driven by what the learner says they know.

```json
{
  "version": 1,
  "intro": "Welcome … **no score** … where each skill starts and which labs your path skips …",
  "areas": [
    { "area": "gateway", "blurb": "One place your apps call models through, with stable names and a spend log." }
  ],
  "questions": [
    { "id": "ob-gw-alias", "level": "basic", "concept": "gateway.routing-aliases", "type": "single", "prompt": "…", "options": [], "answer": ["b"], "explanation": "…" }
  ]
}
```

- **`areas`** has one entry per quiz skill (`quiz` in `concepts.json`; no more, no fewer). The `blurb` is the plain one-line description (up to 90 characters, single line, no markup) shown under the area's title on the first screen. The title (the module's own) and the module order come from `paths.json`.
- **`level`** is required on every onboarding question, `basic` or `advanced`, and on no lab question. A `basic` question recognises what the thing is or why it exists; an `advanced` one tests a subtle behaviour. Every area needs at least one of each. Between 12 (two per area) and 24 questions in all; the rest of a question is exactly a lab quiz question (same option, answer and explanation rules).
- **The intro** is markdown, up to 600 characters. Do not promise a number of questions or a length: how many it asks depends on the learner.

How the console uses it (`dashboard/src/learn-model.js` holds the pure logic, `onboarding.js` the screens):

1. **What have you worked with?** The intro and a checklist (a fieldset with one checkbox per area, plus an exclusive "None of these yet"). "Start" needs at least one choice; "Skip for now" is always available and is remembered. An area left unticked gets no question and starts as **new**. "None of these yet" marks all areas new and goes straight to the summary.
2. **One probe per ticked area, in module order, at most two questions.** The area's first `basic` question in file order is asked. Wrong (or "Not sure"): the area is **new** and probing stops. Right: the area's first `advanced` question is asked; right is **strong**, wrong (or "Not sure") is **ok**. So put the question you want asked first, in its level, at the top of its area in the file; later questions of the same level are not used until they lead. A ticked set of areas never costs more than two questions each.
3. **Summary.** Each module with its level (Strong, Familiar, New) and a "Start with module N" suggestion, and a line saying the quiz can be retaken from the "?" menu. Only the questions actually asked are posted to `POST /api/learn/answers` with phase `onboarding`; nothing is posted when none were asked. The levels are stored in this browser (`opalixLearn`).

An old console that cannot read `level` drops every question and offers no quiz, rather than showing one it cannot branch.

## Checklist before publishing

- `labs learn-check labs/<slug>` prints `ok`.
- Read the story and the lessons aloud once. Cut anything that is not needed for the lab's task.
- The lab's checks still pass with the learner never opening a lesson.
