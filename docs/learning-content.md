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
    diagnostic: true        # default; false = shown only inside the lesson
```

Rules the checker enforces:

- Every lesson needs at least one `diagnostic: true` question, otherwise it can never be skipped.
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

The story can also be told as a motion comic that plays like a video: a camera moves across a comic page and zooms into each panel as it pops in, speech bubbles type out word by word, and the learner sees Replay and Skip. The art is drawn by the console from code, so a comic is a few lines of data per panel, never an image. It can have one page or several, and any number of panels on each. `learn/story.md` stays required: it is the fallback for screen readers, for a skipped comic and for older consoles.

```yaml
title: Which provider answered?
panels:                         # one page; for several pages write `pages:` (below)
  - scene: desk                 # desk, message, portrait, screen, duo or you
    cast: [jonas]               # who is in it: maren, tomasz, priya, jonas, anneke, you
    caption: Tuesday, a little after ten.
    bubbles:
      - { who: jonas, text: "Which provider answered, and what did that reply cost?" }
    lines: ["$ $ $", "?"]      # what the screen shows
  - scene: message
    cast: [maren]
    prop: envelope              # none, envelope, laptop, chart, map, key, document
    sfx: PING!
    bubbles: [{ who: maren, text: "Nobody can answer this." }]
```

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
| `desk` | wide (2 of 3 columns) | 1 | optional `lines` for the screen |
| `message` | square (1 column) | 1 | optional `prop`, `sfx` |
| `portrait` | square | 1 | optional `prop`, `sfx` |
| `screen` | wide | none | `lines` (typed out one by one) |
| `duo` | square | 2 | |
| `you` | wide | none | `lines`; the last panel shows the call to action |

Rules `labs learn-check` enforces:

- 1 to 6 pages, 1 to 9 panels on a page, at least 4 and at most 36 panels in all. Panels flow in reading order into rows of three columns (wide counts 2, square 1). Any count works: a wide panel that does not fit the rest of a row starts the next row, and a row that is not full sits in the middle of the page, so there is nothing to balance by hand.
- Speakers must be in the panel's cast. At most two bubbles per panel, 150 characters each, plain text. Under 130 spoken words on a page and under 520 in all, so a page plays in about a minute and a half. The camera turns the page (with its optional title) between pages.
- Every panel says something (a caption, a bubble or screen lines). `sfx` is for `message`, `portrait` and `desk` panels.
- The comic follows the story bible: Larkfield, the five recurring people, second person for "you", no answer to a graded question.

Lines on a screen are coloured by how they start: `$` is a command, `200` or `ok` is green, `4xx`, `5xx` or `error` is orange or red. Use `?` where the lab wants the learner to find the value.

### How it plays

The console (`dashboard/src/comic.js`) lays the whole comic out as one reel (every page a sheet of paper, one under the other) and plays it on a single clock; the schedule is a pure function in `comic-timeline.js`, so a panel's start, each word of a bubble and the camera at any second are the same every time.

- **Camera.** It starts on the first page, flies to each panel as it pops in, and zooms to fit it. Between pages it flies down to the next sheet (and to its title card, held a moment, when the page has a `title`). After the last panel it pulls back until the whole comic is in frame, and the frame grows to fit it. A panel stays up for `panelSeconds(words)` of every word it shows: what is said, the caption and the screen lines. Bubbles type word by word, speaker after speaker; screen lines type one after another; the caption fades in; a `sfx` word slams in with a shake.
- **Replay and Skip** are the only playback controls. Skip goes straight to the finished comic (every page drawn, every bubble typed). Replay starts again from page 1. A thin progress bar and a timecode (`m:ss / m:ss`) show where it is; they are not controls. The comic plays by itself when it first shows, waits while its tab or the page is hidden, and stops its clock when it is finished or when the learner leaves the screen. One more button exists only on a narrated comic (see [Narration](#narration-voices)): the **Sound on / Sound off** toggle, a documented exception because browsers need a way to turn sound off.
- **Read as text.** Under the stage, a disclosure lists the transcript of every panel (the same text `labs learn-check` reads: `Panel 3. Maren: ...`, with a `Page 2: Title.` line per page when there are several). The stage itself is one image with the comic's title; the animation is hidden from screen readers, and the transcript is its equivalent. The text story from `story.md` sits under that, folded under "Read the story as text", and is the whole story when a lab has no comic or the comic cannot be drawn.
- **Reduced motion.** With `prefers-reduced-motion: reduce` the comic starts finished: every page drawn, no camera, nothing typing, the same two buttons (Skip is then off; Replay plays it as cuts from panel to panel, still without travelling or typing).
- **Narrow places.** The stage is as wide as its container. In the guide pane (360 to 520px) the frame is squarer, the words of a wide panel are drawn larger so that bubbles stay about 13px on screen and captions 11px or more, and the camera pushes in on a screen once what is said has been said.

### Narration (voices)

A comic can be read aloud. The voices are made once, by an author, with `labs narrate`, and committed; nothing calls a model when a lab is published or played.

```
export CLOUDFLARE_API_TOKEN=...      # a token that may run Workers AI; never commit it
                                     # CLOUDFLARE_ACCOUNT_ID is read from the environment, else from wrangler.jsonc vars
npm run opalix -- labs narrate labs/<slug> --dry-run         # what it would make, and how many characters
npm run opalix -- labs narrate labs/<slug>                   # make it
git add labs/<slug>/learn/audio.json labs/<slug>/learn/audio
```

- **Who says what.** The narrator reads every `caption`. Each `bubble` is read by its speaker's voice; a bubble with no `who` is the narrator's. The learner (`you`) is never spoken, and neither are `lines` (what a screen shows) or `sfx`. The voices are set in one place, `src/labs/comic-kit.ts`: `CAST[].voice` for each person and the exported `NARRATOR_VOICE`, with `TTS_MODEL` for the model (Workers AI `@cf/deepgram/aura-2-en`: Atlas narrates, Jonas is Arcas, Maren Thalia, Priya Luna, Tomasz Orion, Anneke Andromeda). `narrationLines(comic)` there is the one definition of what is spoken.
- **What it writes.** `learn/audio/<key>.mp3`, one file per distinct (model, voice, text), where `<key>` is the first 16 hex digits of the SHA-256 of `model\nvoice\ntext`; and `learn/audio.json`: `{ model, clips: { <key>: { voice, text, seconds, bytes } }, lines: [{ panel, kind, bubble?, clip }] }`, where `lines` has one entry per spoken line in reading order (`panel` counts across pages from 0). Identical words in the same voice share a file.
- **When to run it again.** Whenever a caption or a bubble changes, a speaker changes, or a voice or the model is changed in comic-kit. It only makes the clips that are missing (a second run with nothing changed makes no network call and rewrites nothing) and deletes the clips nothing uses any more. `labs learn-check` and `labs publish` refuse a lab whose `audio.json` no longer matches `comic.yaml` word for word, or whose clip files are missing, and say to run `labs narrate`, so a voice can never say words the panel does not show.
- **Cost.** About 3,000 characters narrated all six explore comics (a lab's comic is 300 to 600 characters; Workers AI bills text-to-speech by the character, on the order of $0.03 per 1,000 characters, so a lab costs a cent or two). Only changed lines are paid for again. `--dry-run` prints the character count first. Each clip is limited to 400 KB and a lab to 80 clips.
- **Where the files go.** `labs publish` uploads the clips beside the bundle (the bundle carries `audio.json` as `learn.audio`); the Worker validates them (names, sizes, MP3 content, exactly the set `audio` names) and stores them at `labs/{slug}/{version}/audio/<key>.mp3`. See [the API](api.md#narration-clips). The console plays them from `/api/audio/<slug>/<key>.mp3`.
- **How it plays.** The voices run on the comic's own clock (`dashboard/src/comic-timeline.js` and `comic-audio.js`): with narration, each spoken line starts and ends where its clip does (a caption's clip as the caption appears, then each bubble's clip, 0.35 s apart), a bubble's words type across its clip in proportion to their length so the typing keeps pace with the voice, and a panel stays up until its last clip is done plus the usual hold (never less than reading time). Skip, Replay, a hidden tab and the toggle stop the clip, and two never play at once. A clip that cannot load is skipped in silence. A lab without narration plays exactly as before.
- **The Sound toggle** sits beside Replay and Skip, only on a narrated comic. It is named for its state (**Sound on** or **Sound off**), is pressed when on, is on by default and is remembered (`localStorage` `opalix.comicSound`). Replay and Skip stay the only playback controls.
- **Autoplay.** The comic tries to start sound by itself. If the browser refuses (it wants a tap first), a small non-modal **Tap to turn the sound on** button appears in the frame; tapping it, or Replay, or the toggle, starts the clip where the clock is. With `prefers-reduced-motion: reduce` no audio plays by itself (the comic starts finished); Replay plays it hard-cut, with its audio.
- **Always text too.** Captions, bubbles and "Read as text" are all still there, so nothing depends on hearing.

Tests drive the voices without sound: with `?comicTest=1` the player never calls `play()`, and `window.__comicClock.audio` lists the scheduled clips (key, start, end), `audioLog()` what it decided to play and stop, and `?comicAudio=blocked` makes play() refuse as a browser does (`test/e2e/19-comic-audio.spec.ts`).

## Trimming the brief

Once the lesson teaches a concept, the brief stops explaining it. The brief keeps: what is running, the tools, what done looks like, the pressure sentence if any. Target 300 words or fewer for an explore lab.

## What the learner sees

1. The platform onboarding quiz (once, branching, a few questions at most) sets a starting level per module.
2. Before a lab starts, "Before you begin" shows the story, then the diagnostic questions for the lab's concepts.
3. Concepts answered correctly collapse to their recap. The others expand as lessons. The learner can press "I know this, skip" on any lesson, or "Show me the lesson anyway" on a collapsed one. The quiz decides the default; the learner decides the outcome.
4. Mastery is stored in the learner's browser. Nothing is graded on it.
5. In the session the lab's guide, a reading pane beside the workspace window, has them as tabs: an explore lab opens on its Story, then Lessons, Brief and Questions; any other lab opens on its Brief.

## How the console shows it

The learner console (`dashboard/`) renders all of the above in the browser. The bundle arrives through the console Worker, which reads it with the service key and never sends anything about the learner to the API:

| Console route | API call | Notes |
|---|---|---|
| `GET /api/learn/:slug` | `GET /labs/:slug/learn` | a `404 no_learn` passes through; the console then boots the lab as it always did |
| `GET /api/onboarding` | `GET /learn/onboarding` | a `404` or any failure means no quiz is offered |
| `POST /api/learn/answers` | `POST /learn/answers` | only the validated body is forwarded (at most 60 answers, 16 KB), with no user, subject or address |

All three need the console cookie like the other `/api` routes. The launcher's `has_learn` flag comes through `GET /api/labs` unchanged; a lab without it never asks for a bundle.

- **Platform quiz** (`onboarding.js`). Shown once after the first sign-in when the quiz exists; "Skip for now" is on every screen and is remembered; "Retake the quiz" sits next to the help control in the header and in the "?" dialog. It branches (see [The platform onboarding quiz](#the-platform-onboarding-quiz)): a checklist of the areas the learner has worked with, then at most two questions per ticked area. Its outcome is a level per module (strong, familiar or new, from the areas in `concepts.json`), and the launcher puts a "Suggested start" chip on the first module that is new.
- **Before you begin** (`before-you-begin.js`). Between Start and the boot: the story, the diagnostic questions for concepts not already known, then the plan. A lesson for a known or skipped concept folds to its `recap` with "Show me the lesson anyway"; the others show in full with "I know this, skip". The session starts only when "Start the lab" is pressed; "Skip all, just start the lab" is on every step. Any failure to fetch the bundle goes straight to the boot.
- **In the session** (`learn-tab.js`, `questions-form.js`, `session-layout.js`). The guide's Story tab (an explore lab's first) and Lessons tab (every lesson, toggleable; a lab that does not open on its story folds the story into the top of it), and for a lab with `fields` a Questions tab, one card per question with a Not answered / Answered / Saved badge: a form that writes `workspace/<answers_file>` as JSON after 600 ms of quiet and on Save. A write re-reads the file first and merges by key: a key the learner changed in the form wins, a key they did not touch keeps what the file holds now, and keys the form does not know are kept. Number fields store a JSON number (or `null` when empty), text a string (or `null`), choice the chosen choice string.
- **Mastery** (`learn-model.js`) lives in the browser under `localStorage['opalixLearn']`: onboarding levels, per-concept `known` (true only when every diagnostic question about the concept was answered correctly), and the learner's own `skipped` / `forced` overrides, which always win. Nothing is sent and nothing is graded; the anonymous outcomes that do go to `POST /learn/answers` carry no identity.
- **Lesson and story text** (`markdown.js`) is drawn straight into DOM nodes (no HTML is ever parsed): paragraphs, `##` and `###` headings, bold, italic, code, fenced code, lists, `http(s)` links and `::diagram[id]` lines. A diagram id that is not in the library becomes a short notice.

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
