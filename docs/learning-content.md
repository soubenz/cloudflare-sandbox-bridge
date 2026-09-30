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

## Trimming the brief

Once the lesson teaches a concept, the brief stops explaining it. The brief keeps: what is running, the tools, what done looks like, the pressure sentence if any. Target 300 words or fewer for an explore lab.

## What the learner sees

1. The platform onboarding quiz (once) sets a starting level per module.
2. Before a lab starts, "Before you begin" shows the story, then the diagnostic questions for the lab's concepts.
3. Concepts answered correctly collapse to their recap. The others expand as lessons. The learner can press "I know this, skip" on any lesson, or "Show me the lesson anyway" on a collapsed one. The quiz decides the default; the learner decides the outcome.
4. Mastery is stored in the learner's browser. Nothing is graded on it.
5. For an explore lab, the graded questions are a form beside the terminal, with the lessons one tab away.

## How the console shows it

The learner console (`dashboard/`) renders all of the above in the browser. The bundle arrives through the console Worker, which reads it with the service key and never sends anything about the learner to the API:

| Console route | API call | Notes |
|---|---|---|
| `GET /api/learn/:slug` | `GET /labs/:slug/learn` | a `404 no_learn` passes through; the console then boots the lab as it always did |
| `GET /api/onboarding` | `GET /learn/onboarding` | a `404` or any failure means no quiz is offered |
| `POST /api/learn/answers` | `POST /learn/answers` | only the validated body is forwarded (at most 60 answers, 16 KB), with no user, subject or address |

All three need the console cookie like the other `/api` routes. The launcher's `has_learn` flag comes through `GET /api/labs` unchanged; a lab without it never asks for a bundle.

- **Platform quiz** (`onboarding.js`). Shown once after the first sign-in when the quiz exists; "Skip for now" is remembered; "Retake the quiz" sits next to the help control in the header. Its answers set a level per module (strong, ok or new, from the areas in `concepts.json`), and the launcher puts a "Suggested start" chip on the first module that is new.
- **Before you begin** (`before-you-begin.js`). Between Start and the boot: the story, the diagnostic questions for concepts not already known, then the plan. A lesson for a known or skipped concept folds to its `recap` with "Show me the lesson anyway"; the others show in full with "I know this, skip". The session starts only when "Start the lab" is pressed; "Skip all, just start the lab" is on every step. Any failure to fetch the bundle goes straight to the boot.
- **In the session** (`learn-tab.js`, `questions-form.js`). A Learn tab with the story and every lesson (toggleable), and for a lab with `fields` a Questions tab: a form that writes `workspace/<answers_file>` as JSON after 600 ms of quiet and on Save. A write re-reads the file first and merges by key: a key the learner changed in the form wins, a key they did not touch keeps what the file holds now, and keys the form does not know are kept. Number fields store a JSON number (or `null` when empty), text a string (or `null`), choice the chosen choice string.
- **Mastery** (`learn-model.js`) lives in the browser under `localStorage['opalixLearn']`: onboarding levels, per-concept `known` (true only when every diagnostic question about the concept was answered correctly), and the learner's own `skipped` / `forced` overrides, which always win. Nothing is sent and nothing is graded; the anonymous outcomes that do go to `POST /learn/answers` carry no identity.
- **Lesson and story text** (`markdown.js`) is drawn straight into DOM nodes (no HTML is ever parsed): paragraphs, `##` and `###` headings, bold, italic, code, fenced code, lists, `http(s)` links and `::diagram[id]` lines. A diagram id that is not in the library becomes a short notice.

## Checklist before publishing

- `labs learn-check labs/<slug>` prints `ok`.
- Read the story and the lessons aloud once. Cut anything that is not needed for the lab's task.
- The lab's checks still pass with the learner never opening a lesson.
