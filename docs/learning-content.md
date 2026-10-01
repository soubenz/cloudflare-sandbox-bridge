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
  workspace/answers.json     explore labs: the template the fields fill
```

`labs learn-check labs/<slug>` compiles the folder and prints every problem at once. `labs publish` runs the same check and refuses a lab that fails. `npm test` compiles every lab that ships a `learn/` folder.

## Concept ids

A concept is one idea a learner can know or not know. Ids live in `packages/catalogue/concepts.json`, shaped `area.some-name`. A lesson or question naming an id not in that file fails the check, so add the concept there first. Keep a concept small enough that one lesson (2 to 4 minutes) teaches it and two or three questions test it.

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
- `choices` is required for `choice` and forbidden otherwise. Up to 12 fields.

## The motion comic (optional): `learn/comic.yaml`

The story can also be told as a motion comic that plays like a short audio story with pictures: a camera moves across a comic page and zooms into each panel as it pops in, **one storyteller** tells the story over it, speech bubbles type out on screen, and the learner sees Replay, Skip and a Sound toggle. The art is drawn by the console from code, so a comic is a few lines of data per panel, never an image. `learn/story.md` stays required: it is the fallback for screen readers, for a skipped comic and for older consoles.

### Who tells it

The story is a team's, and Maren tells it.

- **The storyteller is Maren**, the platform lead, speaking to you as a member of her team: first person, and "we", "our platform", "your team". She is warm and direct. Her words are the `voiceover` of each panel, and one voice (`thalia`, set once in `src/labs/comic-kit.ts` as `NARRATOR_VOICE`) reads all of them.
- **Three people are drawn:** Maren, Tomasz (the engineer who built things) and You (the learner). Only `maren`, `tomasz` and `you` may appear in `cast` or as a bubble speaker.
- **Finance (Jonas), Support (Priya) and data protection (Anneke) are retired from the cast.** They are never drawn and never speak. The story still has them: Maren mentions them in the voiceover ("Jonas in Finance asked us...") or a caption names them, and a `message` panel can show their note arriving while the voiceover says who it is from. `labs learn-check` refuses `priya`, `jonas` and `anneke` in `cast` or as a bubble speaker, with the message "retired: use maren, tomasz or you; mention them in the voiceover or caption instead". (The names still parse so that a comic that has no voiceover yet keeps working until it is rewritten; see [Moving an old comic over](#moving-an-old-comic-over).)

### The panel

```yaml
title: Which provider answered?
panels:                         # one page; for several pages write `pages:` (below)
  - scene: desk                 # desk, message, portrait, screen, duo or you
    cast: [tomasz]              # who is drawn: maren, tomasz or you (none for screen and you scenes)
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
| `voiceover` | What the storyteller **says** over the panel. This is how the story is told. | **Spoken** by the one narrator voice (and part of "Read as text"). Not drawn on the panel. | Optional, plain single-line text, up to 240 characters |
| `caption` | A short **label** on the picture: a time, a place, the call to action. | Fades in at the panel start. **Never spoken.** | Optional, up to 100 characters |
| `bubbles` | A short quoted line of someone in the panel. | **Text only**, typed out word by word. **Never spoken.** At most two a panel. | `who` (maren, tomasz or you, in the panel's `cast`; optional), `text` up to 150 characters |
| `lines` / `sfx` | What a screen shows, one line per entry; a sound-effect word slammed onto the panel. | Typed on the screen; slammed in with a shake. Never spoken. | up to 6 lines of 44 characters; `sfx` up to 14 |

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
| `desk` | wide (2 of 3 columns) | 1 (maren, tomasz or you) | optional `lines` for the screen |
| `message` | square (1 column) | 1 | optional `prop`, `sfx`; the sender is named in the voiceover |
| `portrait` | square | 1 | optional `prop`, `sfx` |
| `screen` | wide | none | `lines` (typed out one by one) |
| `duo` | square | 2 | |
| `you` | wide | none | `lines`; the last panel shows the call to action |

A `screen` or `you` scene draws nobody, so it needs no cast. A `message` scene still has one of the three in the room with the envelope: the person who wrote the note is spoken about in the voiceover (bubbles need a speaker who is in the cast).

### Writing the voiceover

Write it the way Maren would say it to her team across a desk, so that it sounds right read aloud by a text-to-speech voice.

- **First person and plural.** "I", "we", "our platform", "your team", "you". "We had a problem on Tuesday." not "The team had a problem."
- **Short and natural.** One or two sentences, about 35 words at most (the hard limit is 240 characters). One idea a panel; the next panel carries the next.
- **Spell numbers and sizes** the way you would say them: "three in the morning", "four teams", "two hundred". No digits for amounts of money, counts or times that you want read out.
- **No code, symbols or file names.** Say "the gateway log", not `gateway.log`; no slashes, underscores, backticks, `$` or `%`. Put the exact text on a screen `line` instead and let the voiceover say what it means.
- **No hard acronyms.** Say "the model provider" when you can. If you need one the learner knows ("API", "EU"), use it sparingly.
- **Do not repeat the caption or the bubble.** The caption is the label, the bubble is a quote, the voiceover is the telling. A bubble is a line someone says out loud in the picture ("Which provider answered?"); the voiceover is Maren saying what is going on.
- **No answers to a graded question** and the story bible: Larkfield, second person for "you".

A comic is **5 to 9 panels** and **one page**, unless the story really turns (a page with a title card for "The call", say), in which case two. A comic with a voiceover may have at most 9 panels in all.

### Rules `labs learn-check` enforces

- 1 to 6 pages, 1 to 9 panels on a page, at least 4 panels in all, and **at most 9 in all once any panel has a `voiceover`**. Panels flow in reading order into rows of three columns (wide counts 2, square 1). Any count works: a wide panel that does not fit the rest of a row starts the next row, and a row that is not full sits in the middle of the page, so there is nothing to balance by hand.
- A voiceover is at most 240 characters. Speakers must be in the panel's cast, and cast and speakers are only `maren`, `tomasz` and `you` (see above). At most two bubbles per panel, 150 characters each, plain text. Under 130 bubble words on a page and under 520 in all.
- Every panel says something (a voiceover, a caption, a bubble or screen lines). `sfx` is for `message`, `portrait` and `desk` panels. A `screen` or `you` panel needs `lines`.
- Narration is optional: a comic with no `voiceover` anywhere is valid and plays without sound.

Lines on a screen are coloured by how they start: `$` is a command, `200` or `ok` is green, `4xx`, `5xx` or `error` is orange or red. Use `?` where the lab wants the learner to find the value.

### Moving an old comic over

The comic used to be read by several voices (a narrator for captions, each person for their bubbles). That contract is retired for new work but still validates, so a lab keeps working until it is rewritten: a comic with **no `voiceover`** keeps the old rules (any of the five people may be in it, up to 36 panels) and its old `learn/audio.json` is still accepted by `labs learn-check` and `labs publish`. The console does not play that old narration (it plays such a comic silent, with no Sound toggle). To move a lab over: write a `voiceover` on each panel in Maren's voice, drop the retired people from `cast` and the bubbles (mention them in the voiceover instead), then run `labs narrate`. As soon as one panel has a `voiceover`, the comic is held to the new rules and the old-shape `audio.json` is refused ("out of date ... run `labs narrate`"); `labs narrate` writes the new one and deletes the old clips.

### How it plays

The console (`dashboard/src/comic.js`) lays the whole comic out as one reel (every page a sheet of paper, one under the other) and plays it on a single clock; the schedule is a pure function in `comic-timeline.js`, so a panel's start, each word of a bubble and the camera at any second are the same every time.

- **Camera.** It starts on the first page, flies to each panel as it pops in, and zooms to fit it. Between pages it flies down to the next sheet (and to its title card, held a moment, when the page has a `title`). After the last panel it pulls back until the whole comic is in frame, and the frame grows to fit it. Without narration a panel stays up for `panelSeconds(words)` of every word it shows (bubbles, caption and screen lines; a voiceover is heard, not read, so it adds none). Bubbles type word by word, speaker after speaker; screen lines type one after another; the caption fades in at the panel start; a `sfx` word slams in with a shake.
- **Replay and Skip** are the playback controls. Skip goes straight to the finished comic (every page drawn, every bubble typed). Replay starts again from page 1. A thin progress bar and a timecode (`m:ss / m:ss`) show where it is; they are not controls. The comic plays by itself when it first shows, waits while its tab or the page is hidden, and stops its clock when it is finished or when the learner leaves the screen. One more button exists only on a narrated comic (see [Narration](#narration-the-storyteller)): the **Sound on / Sound off** toggle, a documented exception because browsers need a way to turn sound off.
- **Read as text.** Under the stage, a disclosure lists the transcript of every panel (the same text `labs learn-check` reads: `Panel 3. <caption> <voiceover> Maren: <bubble> On screen: ...`, with a `Page 2: Title.` line per page when there are several), so the whole story, including what the storyteller says, can be read. The stage itself is one image with the comic's title; the animation is hidden from screen readers, and the transcript is its equivalent. The text story from `story.md` sits under that, folded under "Read the story as text", and is the whole story when a lab has no comic or the comic cannot be drawn.
- **Reduced motion.** With `prefers-reduced-motion: reduce` the comic starts finished: every page drawn, no camera, nothing typing, the same buttons (Skip is then off; Replay plays it as cuts from panel to panel, still without travelling or typing).
- **Narrow places.** The stage is as wide as its container. In a narrow container (the story step in a window narrowed to a few hundred pixels) the frame is squarer, the words of a wide panel are drawn larger so that bubbles stay about 13px on screen and captions 11px or more, and the camera pushes in on a screen once what is said has been said.

### Narration (the storyteller)

A comic can be read aloud by one voice. The voice is made once, by an author, with `labs narrate`, and committed; nothing calls a model when a lab is published or played.

```
export CLOUDFLARE_API_TOKEN=...      # a token that may run Workers AI; never commit it
                                     # CLOUDFLARE_ACCOUNT_ID is read from the environment, else from wrangler.jsonc vars
npm run opalix -- labs narrate labs/<slug> --dry-run         # what it would make, and how many characters
npm run opalix -- labs narrate labs/<slug>                   # make it
git add labs/<slug>/learn/audio.json labs/<slug>/learn/audio
```

- **Who says what.** One storyteller reads the `voiceover` of every panel that has one, and nothing else: not a `caption`, not a `bubble` (bubbles are text only, whoever speaks them), not `lines` or `sfx`. A panel with no voiceover has no clip and is silent. The voice is set in one place, `src/labs/comic-kit.ts`: `NARRATOR_VOICE` (a Workers AI `@cf/deepgram/aura-2-en` speaker, `thalia`, a female voice) with `TTS_MODEL` for the model. Other female Aura-2 voices to try: `athena`, `luna`, `helena`, `andromeda`, `juno`, `vesta`. `narrationLines(comic)` there is the one definition of what is spoken.
- **What it writes.** `learn/audio/<key>.mp3`, one file per distinct (model, voice, text), where `<key>` is the first 16 hex digits of the SHA-256 of `model\nvoice\ntext`; and `learn/audio.json`: `{ model, clips: { <key>: { voice, text, seconds, bytes } }, lines: [{ panel, kind: "voiceover", clip }] }`, where `lines` has one entry per voiced panel in reading order (`panel` counts across pages from 0). Identical words share a file.
- **When to run it again.** Whenever a `voiceover` changes, or the voice or the model is changed in comic-kit (changing the voice makes every clip anew). Changing a caption or a bubble needs no new narration. It only makes the clips that are missing (a second run with nothing changed makes no network call and rewrites nothing) and deletes the clips nothing uses any more. `labs learn-check` and `labs publish` refuse a lab whose `audio.json` no longer matches the comic's voiceovers word for word, or whose clip files are missing, and say to run `labs narrate`, so a voice can never say words the story does not have.
- **Cost.** Workers AI bills text-to-speech by the character. A comic of 5 to 9 voiceovers of up to 240 characters is a few hundred to about two thousand characters, so a lab costs a cent or so; only changed voiceovers are paid for again. `--dry-run` prints the character count first. Each clip is limited to 400 KB and a lab to 80 clips.
- **Where the files go.** `labs publish` uploads the clips beside the bundle (the bundle carries `audio.json` as `learn.audio`); the Worker validates them (names, sizes, MP3 content, exactly the set `audio` names) and stores them at `labs/{slug}/{version}/audio/<key>.mp3`. See [the API](api.md#narration-clips). The console plays them from `/api/audio/<slug>/<key>.mp3`.
- **How it plays.** The storyteller runs on the comic's own clock (`dashboard/src/comic-timeline.js` and `comic-audio.js`). A voiced panel's clip starts **0.6 s into the panel**, once the picture has landed. The panel stays up for the larger of what it takes to read everything it shows and the clip's end plus the usual hold (`TIMING.hold`, 2 s), so no panel is ever cut before its clip ends, and the silence between one voiceover and the next is never less than `TIMING.breath` (0.5 s; in practice the hold plus the 0.6 s lead, so the storyteller pauses between panels like a person turning a page). The panel's bubbles appear as text and type out starting **0.8 s after the clip starts**, one after the other, at the reading pace (`TIMING.word`, 0.2 s a word), clamped so the last bubble is done by the clip's end plus one second; if there are more bubble words than fit, they type faster, never slower than the voice allows. The caption fades in at the panel start. Skip, Replay, a seek, a hidden tab, Sound off and leaving the screen stop the clip, and exactly one narrator clip plays at a time. A clip that cannot load is skipped in silence. A lab without narration plays exactly as before.
- **If the narration cannot be trusted the console plays the comic silent, whole.** If the narration is not of the voiceovers in the comic (other words, a panel without a voiceover, a voiceover without a clip, or any line of the old caption-and-bubble shape), the console turns all of it off rather than play part of it: no sound, no Sound toggle, the ordinary silent schedule.
- **The Sound toggle** sits beside Replay and Skip, only on a narrated comic. It is named for its state (**Sound on** or **Sound off**), is pressed when on, is on by default and is remembered (`localStorage` `opalix.comicSound`).
- **Autoplay.** The comic tries to start sound by itself. If the browser refuses (it wants a tap first), a small non-modal **Tap to turn the sound on** button appears in the frame; tapping it, or Replay, or the toggle, starts the clip where the clock is. With `prefers-reduced-motion: reduce` no audio plays by itself (the comic starts finished); Replay plays it hard-cut, with its audio.
- **Always text too.** Captions, bubbles and "Read as text" (which includes the voiceovers) are all still there, so nothing depends on hearing.

Tests drive the voice without sound: with `?comicTest=1` the player never calls `play()`, and `window.__comicClock.audio` lists the scheduled clips (key, start, end), `audioLog()` what it decided to play and stop, and `?comicAudio=blocked` makes play() refuse as a browser does (`test/e2e/19-comic-audio.spec.ts`, which carries its own small comic and narration in `test/e2e/comic-fixture.ts`).

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

All three need the console cookie like the other `/api` routes. The launcher's `has_learn` flag comes through `GET /api/labs` unchanged; a lab without it never asks for a bundle.

- **Platform quiz** (`onboarding.js`). Shown once after the first sign-in when the quiz exists; "Skip for now" is on every screen and is remembered; "Retake the quiz" sits next to the help control in the header and in the "?" dialog. It branches (see [The platform onboarding quiz](#the-platform-onboarding-quiz)): a checklist of the areas the learner has worked with, then at most two questions per ticked area. Its outcome is a level per module (strong, familiar or new, from the areas in `concepts.json`), and the launcher puts a "Suggested start" chip on the first module that is new.
- **Before you begin** (`before-you-begin.js`, with the order in `learn-flow.js`). Between Start and the boot: the story, then rounds of questions alternating with chunks of the lessons (`learn-lessons.js`, full screen, with a count of the lessons read in the chunk). A lesson for a known or skipped concept folds to its `recap` with "Show me the lesson anyway"; the others show in full with "I know this, skip". Every step has a Back button (to the story, the questions or the lessons before it; inside a round, to the previous question) and "Back to labs"; answers are kept, so Back never asks a question again and never posts one twice. The session starts only when "Start the lab" is pressed (the last lessons' button, or the last question's when the flow ends on a round); "Skip all, just start the lab" is on every step. Any failure to fetch the bundle goes straight to the boot.
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
  "intro": "Welcome … **no score** … where each module starts …",
  "areas": [
    { "area": "gateway", "blurb": "One place your apps call models through, with stable names and a spend log." }
  ],
  "questions": [
    { "id": "ob-gw-alias", "level": "basic", "concept": "gateway.routing-aliases", "type": "single", "prompt": "…", "options": [], "answer": ["b"], "explanation": "…" }
  ]
}
```

- **`areas`** has one entry per area of `concepts.json` (no more, no fewer). The `blurb` is the plain one-line description (up to 90 characters, single line, no markup) shown under the area's title on the first screen. The title and module order come from `concepts.json`.
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
