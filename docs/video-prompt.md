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
articulate engineering professor), the characters speak their own speech
bubbles aloud in their own voices, and the pictures are simple animated
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
- 6 to 12 panels. One idea per panel. About 90 to 120 seconds spoken.

STORY
- The narrator tells ONE story that runs through every panel, not a list of
  separate facts. Open inside a concrete moment the viewer can picture (a
  time, a place, one person, one thing going wrong), written fresh for each
  video; never reuse an example line from this prompt. Then link each panel
  to the last with a time or a cause ("Then, on Friday evening...").
- Write it as told prose, not a list of short facts: past tense for the
  story, sentences joined with because, so, while, when, until, and each
  panel's voiceover one or two flowing sentences. Avoid runs of three-word
  sentences ("OpenAI is down. The customer gets an answer.").
- Use real names where a real thing exists: OpenAI, Anthropic, Google, an
  OpenAI key. Larkfield and its people are fictional; the providers are not.

SAY IT ONCE
- Every beat is said by exactly one of: the narrator, a character, or the
  picture. The narrator never says what a character is about to say, a
  character never repeats the narrator, and a caption never repeats either.
- Captions only carry what nobody says aloud: a timestamp ("03:12"), a
  place, a number on a screen. If the narrator says "on Sunday", there is
  no "Sunday" caption.
- A character line must earn its place: it reacts, reveals or asks; it is
  not a quip for its own sake. If it is weak, cut it.

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
- A story beat may instead use `scene: clip`, a short animation from the
  shared clip library (packages/catalogue/clips.json), with its words drawn
  over it; concept panels stay diagrams.
- What is on screen must be what the voice is talking about at that moment.
  Mark the word in the voiceover where each picture element should appear
  (a cue), e.g. a screen line appears on "support". A bubble is spoken, so it
  plays after the narrator's line, in its own time; it needs no cue.
- Screen lines are short and literal: "support assistant: down".

CHARACTERS AND HUMOUR
- The narrator stays calm and never jokes. The characters speak their
  bubbles aloud, each in their own voice, right after the narrator's line
  for that panel; the humour lives there and only there.
- The cast is Larkfield's team (packages/catalogue/voices.json has their
  voices):
    Maren (platform lead): warm and direct; briefs you, keeps the team calm.
    Tomasz (staff engineer): built most of it; dry, precise, knows every log.
    Graham (head of engineering, the boss): asks the blunt question nobody
      wants: who, how much, when is it fixed.
    Ollie (engineer): well-meaning and eager; the one who makes the mistakes,
      and owns up to them.
    Jess (product manager): excitable; wants it shipped by Friday and asks
      the customer's question.
    Priya (head of Support): kind; speaks for the customers who are waiting.
    You (the learner): may have a bubble, but is never voiced.
  Finance (Jonas) and data protection (Anneke) are mentioned, never drawn.
- A bubble is a spoken line: short, 90 characters or fewer recommended
  (150 at most), and at most two per panel. It reacts to the sentence just
  spoken and must make sense on its own; if it needs a setup the viewer did
  not see, cut it. Write it the way that person talks (Graham's blunt
  question, Ollie owning up, Jess's "can we still ship it?").
- The bubbles are dry and kind, never mocking the viewer. A character never
  repeats the narrator, and the narrator never repeats a bubble.

HOOK (panel 1)
- The first spoken sentence is under 12 words, no name, no term, no setup,
  and it is true in the video: whatever it promises is paid off by panel 3.
- The picture is the hook before the voice is: the number, the clock or the
  screenshot is already on screen at second zero.
- Patterns that work for engineers: the number that should not exist ("a
  month's budget in one weekend"), the quiet disaster ("every dashboard was
  green; the bill had tripled"), you have this bug ("one of your keys is in a
  screenshot right now"), the absurd detail ("answered a customer from Leeds
  in perfect Dutch"), the countdown ("3:12 a.m., the fix is a code change"),
  the confession ("we pasted a key into the chat"), the bet ("six things went
  wrong here; four will happen to you"), the outcome first then rewind.
- Never "in this video", never "have you ever", never a question the
  narrator then answers.
- The hook line is also the card text in the catalogue.

CINEMA (every panel)
- Cold open: start inside the incident; the setup comes after the first shock.
- Show, then tell: the picture reveals (a beat of silence, "…") before the
  voice names it. Dramatic irony: let the viewer see the key before the
  characters do.
- Ticking clock: timestamps in captions that advance ("03:12" → "03:40").
- Montage: incidents as short beats with the same caption shape and a sting
  on each; escalate, each beat costing more than the last.
- Cliffhanger: an opener ends on black with the beats stacked and the question.
- Match cut and callback: the closing reopens on the same shot, changed; a
  line from the opener comes back paid off.
- Camera: `shot: close` to push in on a detail, `shot: wide` to reveal.
- Faces: give the characters a mood when it matters (tired, worried, pleased);
  someone wants something and can lose it, said early in one line.

SOUND
- A sting at the moment of impact, named on the sfx and timed by its cue:
  phone, ping, thud, register, whoosh, pop, tick. One per beat, never two.
- The voice never describes a sound the viewer hears.

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
   Write each bubble as "Speaker: words" (e.g. "Ollie: That might be my test script.").
3. If this is an opener: the quiz questions (one per problem), each with the
   two answer options and a one-line explanation.
4. A 10-second read-aloud check: list any sentence over 240 characters, any
   bubble over 90 characters, any panel with more than two bubbles, any term
   used before it was explained, any joke in the voice track. Fix them
   before you hand the script in.
```
