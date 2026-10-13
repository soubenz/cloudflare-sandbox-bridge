# Writing an Opalix video

The prompt below is what every motion-comic script is written from. Paste it
to the writer (a person or an agent) with the four fields filled in. The
format rules it refers to (`comic.yaml`, voiceover limits, narration) are in
`learning-content.md`; this file is about what makes the video teach.

```
You are writing a short educational motion-comic video for Opalix, a hands-on
course on production AI engineering. The viewer is a working engineer who is
new to this topic. Make them understand ONE idea, remember it, and want to
try it. Write for the ear: this is narrated by a calm male voice (an
articulate engineering professor), and the pictures are simple animated
panels.

TOPIC: <one idea, in one sentence, e.g. "what an AI gateway is and why a team runs one">
PLACE IN THE COURSE: <opener before the lessons | closing after the lessons>
WHAT THE VIEWER ALREADY KNOWS: <list>
WHAT COMES NEXT: <quiz | lessons | games | the first lab "<title>">

SHAPE
- An OPENER shows problems only. It never names or suggests the solution.
  It ends by asking the viewer to judge: "is each of these normal, or a sign
  that something is missing?" The quiz that follows asks exactly that, one
  question per problem, and each explanation names what is missing without
  naming the solution.
- A CLOSING introduces the solution in one panel, then walks one concrete
  example through it step by step, then shows one thing that is now easy
  that was hard before, then says what the viewer does next.
- 6 to 9 panels. One idea per panel. About 90 to 120 seconds spoken.

VOICE (the narrator)
- Plain, calm teaching sentences. Short. Concrete nouns, real numbers, real
  times ("three in the morning", "1,850 tokens"), never vague ("a lot").
- Every technical term is explained in the same sentence the first time it
  appears, in everyday words: "A key is the secret that proves who is paying."
- No jokes, no asides, no chatty filler ("okay", "so", "here's the thing",
  "by the way"), no rhetorical questions answered by the narrator, no
  "here's the good news", no "X. Zero Y." punchlines, no "not X, but Y",
  no lists of three for rhythm's sake, no "let's dive in".
- The narrator is a voice-over for the team. It never says "I" or names
  itself, and it never speaks a line that a character then repeats.
- Each panel's voiceover is at most 240 characters. Read it aloud once.

PICTURES
- Every panel is written as a triple: ON SCREEN | VOICE | BUBBLE.
- Concept panels show the concept, not a person: use a diagram panel
  (apps → gateway → providers, a tracking page, a token meter, a table).
  Story panels show a character and one prop (a key, an envelope, a screen).
- What is on screen must be what the voice is talking about at that moment.
  Mark the word in the voiceover where each picture element should appear
  (a cue), e.g. a screen line appears on "support", a bubble appears after
  the sentence it reacts to.
- Screen lines are short and literal: "support assistant: down".

CHARACTERS AND HUMOUR
- The cast is Larkfield's platform team: Maren (platform lead) and Tomasz
  (engineer). Other people (Finance, Support) are mentioned, never drawn.
- Humour lives only in speech bubbles, as text, never in the voice. One
  bubble per panel at most, and it reacts to the sentence just spoken. A
  bubble must make sense on its own; if it needs a setup the viewer did not
  see, cut it.
- The bubbles are dry and kind, never mocking the viewer.

TEACHING
- Start from a thing the viewer has seen or felt, not from a definition.
- Problems before solutions. Let the viewer notice the gap before you fill it.
- Prefer one worked example over three abstract claims.
- Say what the thing is NOT when a newcomer would likely confuse it.
- End with what the viewer does next, in one sentence.

OUTPUT
1. Title (3 to 6 words, names the idea or the incident, not the lab).
2. A table with columns: # | ON SCREEN | VOICE | BUBBLE. Put cues in
   square brackets inside ON SCREEN, e.g. "[on 'support'] screen line: model: support".
3. If this is an opener: the quiz questions (one per problem), each with the
   two answer options and a one-line explanation.
4. A 10-second read-aloud check: list any sentence over 240 characters, any
   term used before it was explained, any joke in the voice track. Fix them
   before you hand the script in.
```
