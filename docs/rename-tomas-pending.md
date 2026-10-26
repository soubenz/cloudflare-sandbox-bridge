# Renaming Tomasz to Tomas: narrated lines still pending

The character is now **Tomas** wherever a person reads it (cast display name in `src/labs/comic-kit.ts`,
catalogue clip alt text, lesson and story text, docs, tests). The internal cast id stays `tomasz`
(comics use `who: tomasz`, the console, voices and many tests key on it).

The 10 `voiceover:` lines below still say "Tomasz". Each was recorded as audio, and a clip is keyed by its
exact words, so editing the text changes the clip key and `labs learn-check` (and the unit tests) would
refuse the lab until the audio is made again. They were left unchanged on purpose. They need
**re-narration**. The narrator voice is generated through Higgsfield, which was not reachable when this
rename was made.

The matching `learn/story.md` and `learn/closing.md` lines were already changed to "Tomas" (learn-check does
not require them to equal the voiceover), so until the clips are remade the text story says Tomas while the
narrator still says Tomasz. No speech bubble with recorded audio says Tomasz (bubbles are text only; the
one bubble and caption that did were changed).

## Lines to change after re-narration

| # | Lab | File | Line | Text |
|---|-----|------|------|------|
| 1 | follow-one-request-through-the-stack | learn/comic.yaml | 37 | Then Support's provider went down in the middle of the night. Its name was written into their code, so moving to another provider meant Tomasz editing that code at three in the morning. |
| 2 | follow-one-request-through-the-stack | learn/comic.yaml | 61 | Each part keeps its own log. Tomasz read all four for an hour. Every line said the request went fine, and not one of them said how long the customer had been sitting there. |
| 3 | gateway-warm-up | learn/comic.yaml | 14 | It started on a Saturday, at twelve minutes past three in the morning, when the phone of Tomasz, an engineer on Larkfield's platform team, lit up the dark bedroom because the support assistant had stopped answering customers. |
| 4 | gateway-warm-up | learn/closing.yaml | 7 | Three months later, on another Saturday at three in the morning, OpenAI went down again, but this time Tomasz's phone stayed dark and he slept right through it. |
| 5 | onboard-yourself-the-way-a-new-team-sees-it | learn/comic.yaml | 8 | I opened our onboarding page for the team that starts on Monday. Nine bullet points. Bullet seven just says, ask Tomasz. |
| 6 | onboard-yourself-the-way-a-new-team-sees-it | learn/comic.yaml | 18 | In fairness, Tomasz built most of this, so he sort of is the documentation. He also wrote that page before we moved the gateway, and two people have edited it since. |
| 7 | onboard-yourself-the-way-a-new-team-sees-it | learn/comic.yaml | 43 | Then Tomasz remembered the script he'd left in your workspace. It walks the whole path for real. A key for the team, their tool plugged in, one real call, and a time on every step. |
| 8 | prove-where-one-requests-data-went | learn/comic.yaml | 34 | Then Tomasz remembered something awkward. Our EU route isn't a straight line to its provider. Something sits in the middle, and he never wrote down what. |
| 9 | see-how-tools-reach-an-agent | learn/comic.yaml | 34 | Tomasz put two toy servers behind it, a weather one and a calculator. Nothing real is connected, so nothing you try in there can reach a customer. |
| 10 | see-why-a-document-matched | learn/comic.yaml | 40 | Luckily, Tomasz had already built a little sandbox for exactly this. A houseplant care library, twenty-four short articles, behind a real search service just like ours. |

The same text also sits in each lab's `learn/audio.json` (`closing-audio.json` for line 4); those files are
rewritten by the narrate command, do not edit them by hand.

## Command flow (from docs/learning-content.md, "Narration")

For each of the 7 labs above, once the narrator voice can be generated:

1. Edit the 10 `voiceover:` lines above, "Tomasz" to "Tomas".
2. Print what has to be made (new clips only; unchanged lines keep their clips):
   `npm run opalix -- labs narrate labs/<slug> --plan --out plan.json`
   (`--plan` lists the opener and the closing, per line the file name, voice id and voice name from
   `packages/catalogue/voices.json`.)
3. Generate each listed line in the narrator voice with the text-to-speech tool (Higgsfield), save it under
   its `file` name in one folder together with the plan saved there as `manifest.json`.
4. Import: `npm run opalix -- labs narrate labs/<slug> --from-dir <folder>`
   (add `--model <id> --voice <id>` for the single-voice `NN.mp3` form). This updates `learn/audio.json`
   and `learn/closing-audio.json` and removes clips nothing uses any more.
5. Check: `npx tsx cli/src/index.ts labs learn-check labs/<slug>` and `npx vitest run`; commit the new
   clips with the indexes. Do not publish labs from here.
