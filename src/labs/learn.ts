import { z } from 'zod';
import registry from '../../packages/catalogue/concepts.json';
import { QUIZ_SKILLS } from '../skills';
import { DIAGRAMS, KNOWN_DIAGRAMS, diagramRefs } from './diagram';
import { KNOWN_CLIPS } from './clip';
import { ComicSchema, allPanels, checkComic, type Comic } from './comic';
import { CAST, NARRATOR_ID, NARRATOR_VOICE, SPEAKING_CAST_IDS, TTS_MODEL, VOICEOVER_MAX, legacyNarrationLines, narrationLines, spokenLines, usesVoiceover } from './comic-kit';

/**
 * The learning layer of a lab: a short story, one lesson per concept, quiz
 * questions the console asks before the lab starts, and (for explore labs)
 * the graded questions the console renders as a form instead of asking the
 * learner to edit answers.json by hand.
 *
 * Authors write files under `labs/<slug>/learn/` (docs/learning-content.md);
 * `labs publish` compiles them into one JSON document of this shape and the
 * Worker stores it at `labs/{slug}/{version}/learn.json`. Nothing in this
 * file touches the filesystem, so the Worker and the CLI share it.
 */

/** Markdown is a small safe subset the console renders itself: no HTML. */
const markdown = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/<\/?[a-zA-Z!]/.test(s), 'HTML is not allowed; use plain markdown');

const plain = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[<>]/.test(s) && !s.includes('\n'), 'plain single-line text, no markup');

const conceptId = z.string().regex(/^[a-z]+\.[a-z0-9]+(-[a-z0-9]+)*$/, 'concept ids look like area.some-name');
const localId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and hyphens');

export const StorySchema = z.object({
  title: plain(80),
  minutes: z.number().int().min(1).max(10),
  body: markdown(2600),
});

export const ConceptSchema = z.object({
  id: conceptId,
  title: plain(80),
  minutes: z.number().int().min(1).max(10),
  /** One line shown when the learner already knows this and the lesson collapses. */
  recap: plain(160),
  body: markdown(2600),
});

const QuestionShape = z.object({
  id: localId,
  concept: conceptId,
  type: z.enum(['single', 'multi']),
  prompt: plain(300),
  options: z.array(z.object({ id: localId, text: plain(160) })).min(2).max(6),
  /** Ids of the correct options; exactly one for `single`. */
  answer: z.array(localId).min(1).max(5),
  explanation: plain(420),
  /** Asked before the lab to decide which lessons to skip. */
  diagnostic: z.boolean().default(true),
});

function refineQuestion(q: z.infer<typeof QuestionShape>, ctx: z.RefinementCtx): void {
  const ids = q.options.map((o) => o.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `question ${q.id}: option ids must be unique` });
  for (const a of q.answer) {
    if (!ids.includes(a)) ctx.addIssue({ code: 'custom', message: `question ${q.id}: answer "${a}" is not one of its options` });
  }
  if (new Set(q.answer).size !== q.answer.length) ctx.addIssue({ code: 'custom', message: `question ${q.id}: answer lists an option twice` });
  if (q.type === 'single' && q.answer.length !== 1) ctx.addIssue({ code: 'custom', message: `question ${q.id}: a single-choice question has exactly one answer` });
  if (q.type === 'multi' && q.answer.length < 2) ctx.addIssue({ code: 'custom', message: `question ${q.id}: a multi-choice question has two or more answers` });
  if (q.type === 'multi' && q.answer.length >= q.options.length) ctx.addIssue({ code: 'custom', message: `question ${q.id}: not every option can be correct` });
}

export const QuestionSchema = QuestionShape.superRefine(refineQuestion);

/** How deep an onboarding question probes: recognising the thing, or a subtle behaviour of it. */
export const ONBOARDING_LEVELS = ['basic', 'advanced'] as const;

/** A lab quiz question plus the `level` the branching onboarding quiz needs. Lab questions have no level. */
export const OnboardingQuestionSchema = QuestionShape.extend({ level: z.enum(ONBOARDING_LEVELS) }).superRefine(refineQuestion);

/**
 * The one-time onboarding quiz, shared by every learner (packages/catalogue/
 * onboarding.json). It has no lessons of its own; its answers set a starting
 * level per module, and each lab's own diagnostic refines it per concept.
 *
 * It branches. The learner ticks the areas they have worked with (`areas`
 * gives each a one-line description for that checklist), and only those are
 * probed, with at most two questions each: the area's first `basic` question,
 * then, if that was right, its first `advanced` one, in file order. So every
 * area needs at least one of each level; more are allowed and go unused until
 * they lead the file.
 */
export const OnboardingSchema = z.object({
  version: z.literal(1),
  intro: markdown(600),
  /** One entry per quiz skill (concepts.json `quiz`): what the checklist says under its title. */
  areas: z.array(z.object({ area: z.string().regex(/^[a-z]+$/, 'an area id such as gateway'), blurb: plain(90) })).min(1).max(12),
  questions: z.array(OnboardingQuestionSchema).min(12).max(24),
});
export type Onboarding = z.infer<typeof OnboardingSchema>;

export function checkOnboarding(o: Onboarding, known: ReadonlySet<string> = KNOWN_CONCEPTS): string[] {
  const problems: string[] = [];
  const ids = o.questions.map((q) => q.id);
  if (new Set(ids).size !== ids.length) problems.push('two onboarding questions have the same id');
  for (const q of o.questions) {
    if (!known.has(q.concept)) problems.push(`onboarding question ${q.id} is about unknown concept "${q.concept}"`);
  }
  const listed = o.areas.map((a) => a.area);
  if (new Set(listed).size !== listed.length) problems.push('two onboarding areas have the same id');
  // The quiz's areas are the quiz skills (packages/catalogue/concepts.json `quiz`), each a skill of paths.json.
  const quiz = QUIZ_SKILLS.map((s) => s.id);
  for (const area of listed) {
    if (!quiz.includes(area)) problems.push(`onboarding area "${area}" is not an area: not a quiz skill in packages/catalogue/concepts.json`);
  }
  for (const q of o.questions) {
    const skill = q.concept.split('.')[0] ?? '';
    if (!quiz.includes(skill)) problems.push(`onboarding question ${q.id} is about "${skill}", which is not a quiz skill`);
  }
  for (const area of quiz) {
    if (!listed.includes(area)) problems.push(`the onboarding quiz has no entry for area "${area}" in its areas list`);
    const mine = o.questions.filter((q) => q.concept.startsWith(area + '.'));
    for (const level of ONBOARDING_LEVELS) {
      const n = mine.filter((q) => q.level === level).length;
      if (n < 1) problems.push(`the onboarding quiz needs at least 1 ${level} question on "${area}" (has ${n})`);
    }
  }
  return problems;
}

export function parseOnboarding(raw: unknown, known: ReadonlySet<string> = KNOWN_CONCEPTS): Onboarding {
  const parsed = OnboardingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Invalid onboarding quiz: ' + parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }
  const problems = checkOnboarding(parsed.data, known);
  if (problems.length > 0) throw new Error('Invalid onboarding quiz: ' + problems.join('; '));
  return parsed.data;
}

/** A graded question of an explore lab, answered through the console into answers.json. */
export const FieldSchema = z
  .object({
    /** The key in answers.json, exactly as the lab's checks read it. */
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    prompt: plain(300),
    kind: z.enum(['text', 'number', 'choice']),
    choices: z.array(plain(80)).min(2).max(8).optional(),
    /** Suggested answers for a text or number field, shown as buttons beside "Something else" (which opens the usual box). */
    options: z.array(plain(80)).min(2).max(4).optional(),
    placeholder: plain(80).optional(),
    help: plain(300).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.kind === 'choice' && !f.choices) ctx.addIssue({ code: 'custom', message: `field ${f.key}: a choice field needs choices` });
    if (f.kind !== 'choice' && f.choices) ctx.addIssue({ code: 'custom', message: `field ${f.key}: only a choice field has choices` });
    if (f.kind === 'choice' && f.options) ctx.addIssue({ code: 'custom', message: `field ${f.key}: a choice field has choices, not options` });
  });

/**
 * The games of the closing (learn/games.yaml): small declarative exercises the console plays after the
 * closing comic, each solved in the browser and followed by its `explanation`. Every kind is data only;
 * the console owns the interaction. Ids are local to the lab and unique across its games.
 */
const GameBase = {
  id: localId,
  title: plain(80),
  prompt: plain(300),
  /** Shown once the game is solved. */
  explanation: plain(420),
  /** Optional: who of the speaking cast hosts the game and reacts to each answer (default tomasz). */
  host: z
    .string()
    .refine((id) => SPEAKING_CAST_IDS.includes(id), { message: `host must be one of ${SPEAKING_CAST_IDS.join(', ')}` })
    .optional(),
};
/** Optional, sort and flag only: seconds each card stays on the clock (default 8 for sort, 10 for flag; 0 turns the clock off). */
const GameTimer = z.number().int().min(0).max(60).optional();

/** Drag each card into the bucket it belongs to. */
const SortGameShape = z.object({
  kind: z.literal('sort'),
  ...GameBase,
  buckets: z.array(z.object({ id: localId, label: plain(60) })).min(2).max(4),
  /** `why` (optional) is what the host says when the card is put in the wrong bucket, and the recap shows. */
  cards: z.array(z.object({ id: localId, text: plain(160), bucket: localId, why: plain(300).optional() })).min(3).max(10),
  timer: GameTimer,
});

/** Mark the items that are a problem; `why` is shown beside an item once the game is solved. */
const FlagGameShape = z.object({
  kind: z.literal('flag'),
  ...GameBase,
  items: z.array(z.object({ id: localId, text: plain(160), flag: z.boolean(), why: plain(300).optional() })).min(3).max(10),
  timer: GameTimer,
  /** Optional: the words of the two sides a card goes to (default "Flag it" on the right, "Leave it" on the left). */
  choices: z.object({ flag: plain(40), leave: plain(40) }).optional(),
  /** Optional: a small live status board shown above the cards (a provider up or down). */
  board: z.array(z.object({ name: plain(40), status: z.enum(['up', 'down']) })).min(1).max(4).optional(),
});

/**
 * Move the sliders and watch the readout: `formula` folds left from its first input
 * (`readout = in0 op1 in1 op2 in2 ...`; the first entry's op is ignored), and `ask` asks which input moves it most.
 */
const SlidersGameShape = z.object({
  kind: z.literal('sliders'),
  ...GameBase,
  inputs: z
    .array(
      z.object({
        id: localId,
        label: plain(80),
        min: z.number().finite(),
        max: z.number().finite(),
        step: z.number().finite().positive(),
        default: z.number().finite(),
        unit: plain(20).optional(),
      })
    )
    .min(1)
    .max(4),
  formula: z.array(z.object({ input: localId, op: z.enum(['*', '+', '-', '/']) })).min(1).max(8),
  readout: z.object({ label: plain(80), unit: plain(20), decimals: z.number().int().min(0).max(6) }),
  ask: z.object({ prompt: plain(300), answer: localId }),
  /** Optional: a readout to dial in before answering; points for how close it gets (within `tolerance` is full marks). */
  target: z.object({ value: z.number().finite(), tolerance: z.number().finite().min(0).optional() }).optional(),
});

/** Put the steps in order and nest each under its parent: one root, every parent a step of the game, no cycles. */
const OrderAndNestGameShape = z.object({
  kind: z.literal('order-and-nest'),
  ...GameBase,
  steps: z.array(z.object({ id: localId, text: plain(160), parent: localId.nullable(), order: z.number().int().min(0).max(99) })).min(3).max(10),
});

const GameUnion = z.discriminatedUnion('kind', [SortGameShape, FlagGameShape, SlidersGameShape, OrderAndNestGameShape]);

function refineGame(g: z.infer<typeof GameUnion>, ctx: z.RefinementCtx): void {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message: `game ${g.id}: ${message}` });
  const unique = (what: string, ids: string[]) => {
    if (new Set(ids).size !== ids.length) issue(`${what} ids must be unique`);
  };
  switch (g.kind) {
    case 'sort': {
      const buckets = g.buckets.map((b) => b.id);
      unique('bucket', buckets);
      unique('card', g.cards.map((c) => c.id));
      for (const c of g.cards) if (!buckets.includes(c.bucket)) issue(`card ${c.id} goes in bucket "${c.bucket}", which is not one of its buckets`);
      break;
    }
    case 'flag': {
      unique('item', g.items.map((i) => i.id));
      if (!g.items.some((i) => i.flag)) issue('flag at least one item');
      if (g.items.every((i) => i.flag)) issue('leave at least one item unflagged');
      break;
    }
    case 'sliders': {
      const inputs = g.inputs.map((i) => i.id);
      unique('input', inputs);
      for (const i of g.inputs) {
        if (!(i.min < i.max)) issue(`input ${i.id}: min must be below max`);
        else if (i.default < i.min || i.default > i.max) issue(`input ${i.id}: default must be between min and max`);
      }
      for (const f of g.formula) if (!inputs.includes(f.input)) issue(`the formula uses "${f.input}", which is not one of its inputs`);
      if (!inputs.includes(g.ask.answer)) issue(`ask.answer "${g.ask.answer}" is not one of its inputs`);
      break;
    }
    case 'order-and-nest': {
      const ids = g.steps.map((s) => s.id);
      unique('step', ids);
      const roots = g.steps.filter((s) => s.parent === null);
      if (roots.length !== 1) issue(`needs exactly one step with no parent (has ${roots.length})`);
      const parentOf = new Map(g.steps.map((s) => [s.id, s.parent]));
      for (const s of g.steps) {
        if (s.parent !== null && !parentOf.has(s.parent)) issue(`step ${s.id} has parent "${s.parent}", which is not one of its steps`);
      }
      for (const p of new Set(g.steps.map((s) => s.parent))) {
        const orders = g.steps.filter((s) => s.parent === p).map((s) => s.order);
        if (new Set(orders).size !== orders.length) issue(`two steps under ${p === null ? 'the root' : `"${p}"`} have the same order`);
      }
      // Walking up from any step must reach the root within as many hops as there are steps.
      for (const s of g.steps) {
        let at: string | null | undefined = s.id;
        let hops = 0;
        while (at != null && hops <= g.steps.length) {
          at = parentOf.get(at);
          hops += 1;
        }
        if (hops > g.steps.length) {
          issue(`step ${s.id} is in a cycle of parents`);
          break;
        }
      }
      break;
    }
  }
}

export const GameSchema = GameUnion.superRefine(refineGame);
export type LearnGame = z.infer<typeof GameSchema>;

/** Most distinct narration clips one lab may carry, and the largest one, in bytes (about 70 s of speech at 48 kbps is 400 KB). */
export const MAX_AUDIO_CLIPS = 80;
export const MAX_AUDIO_CLIP_BYTES = 400 * 1024;
/** A clip's file name is its key plus this; the key is sixteen hex digits (comic-kit.ts clipKey). */
export const CLIP_KEY = /^[0-9a-f]{16}$/;
/**
 * A clip's voice: whatever id the text-to-speech that made it uses (a Workers AI speaker such as `thalia`,
 * or another service's voice id when the clips were imported with `labs narrate --from-dir`). One token, no spaces.
 */
export const VOICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/**
 * The narration of the comic (learn/audio.json, written by `labs narrate`): which clip reads which
 * line. The mp3 files themselves are not in the bundle; `labs publish` uploads them beside it
 * (docs/api.md) and the console plays them from /api/audio/<slug>/<key>.mp3.
 *
 * `lines` has one entry per panel voiceover of the comic in reading order (comic-kit narrationLines):
 * `{ panel, kind: voiceover, clip }`. A narration with the cast's voices (imported with a manifest that names
 * who speaks each clip) also has one `{ panel, kind: bubble, bubble, clip }` per bubble of a speaking person
 * (comic-kit spokenLines), each after its panel's voiceover; its clips carry `who` (`narrator` or the
 * speaker's id) beside `voice`. A clip with no `who` is the narrator's (the single-voice shape, still read).
 * The older shape (`caption` and `bubble` lines with no `who`, several voices) still parses so that an old
 * comic keeps its old narration until it is rewritten, but a comic with any voiceover needs the new shape
 * (checkLearnBundle), and the console plays only the new one.
 */
export const AudioSchema = z
  .object({
    model: z.string().min(1).max(80),
    clips: z
      .record(
        z.string().regex(CLIP_KEY),
        z.object({
          /** Who speaks it: `narrator`, or a person of the speaking cast. Absent on the single-voice shape (the narrator's) and the old one. */
          who: z
            .string()
            .refine((w) => w === NARRATOR_ID || SPEAKING_CAST_IDS.includes(w), `narrator or one of ${SPEAKING_CAST_IDS.join(', ')}`)
            .optional(),
          voice: z.string().regex(VOICE_ID, 'a voice id: letters, digits and . _ : / - only'),
          text: plain(VOICEOVER_MAX),
          seconds: z.number().min(0.05).max(70),
          bytes: z.number().int().min(1).max(MAX_AUDIO_CLIP_BYTES),
        })
      )
      .refine((c) => Object.keys(c).length <= MAX_AUDIO_CLIPS, `at most ${MAX_AUDIO_CLIPS} clips`),
    lines: z
      .array(
        z.object({
          panel: z.number().int().min(0).max(35),
          kind: z.enum(['voiceover', 'caption', 'bubble']),
          /** Which bubble of the panel (a `bubble` line has one, a voiceover none). */
          bubble: z.number().int().min(0).max(1).optional(),
          clip: z.string().regex(CLIP_KEY),
        })
      )
      .max(108),
  })
  .superRefine((a, ctx) => {
    for (const l of a.lines) {
      if (!(l.clip in a.clips)) ctx.addIssue({ code: 'custom', message: `narration line for panel ${l.panel + 1} names clip ${l.clip}, which is not in clips` });
      if (l.kind === 'voiceover' && l.bubble !== undefined) ctx.addIssue({ code: 'custom', message: `narration line for panel ${l.panel + 1} is a voiceover and has no bubble number` });
      if (l.kind === 'bubble' && l.bubble === undefined) ctx.addIssue({ code: 'custom', message: `narration line for panel ${l.panel + 1} is a bubble and needs its bubble number` });
    }
    const used = new Set(a.lines.map((l) => l.clip));
    for (const k of Object.keys(a.clips)) {
      if (!used.has(k)) ctx.addIssue({ code: 'custom', message: `clip ${k} is not used by any line` });
    }
  });
export type LearnAudio = z.infer<typeof AudioSchema>;

export const LearnBundleSchema = z.object({
  version: z.literal(1),
  story: StorySchema.optional(),
  /** Optional motion-comic version of the story (learn/comic.yaml); the text story stays as the fallback. */
  comic: ComicSchema.optional(),
  /** Optional narration of the comic (learn/audio.json): which clip reads which line. */
  audio: AudioSchema.optional(),
  concepts: z.array(ConceptSchema).max(8),
  questions: z.array(QuestionSchema).max(40),
  answers_file: z.string().regex(/^[A-Za-z0-9._-]+$/).default('answers.json'),
  fields: z.array(FieldSchema).max(12).default([]),
  /**
   * Optional closing of the lab (learn/closing.md, learn/closing.yaml, learn/closing-audio.json): a second
   * story and comic shown after the lab, narrated like the opener. Its clips share learn/audio/.
   */
  closing: z.object({ story: StorySchema, comic: ComicSchema, audio: AudioSchema.optional() }).optional(),
  /** Games played after the closing (learn/games.yaml); a lab with games has a closing and no fields. */
  games: z.array(GameSchema).max(6).default([]),
});

export type LearnBundle = z.infer<typeof LearnBundleSchema>;
export type LearnQuestion = z.infer<typeof QuestionSchema>;
export type LearnConcept = z.infer<typeof ConceptSchema>;
export type LearnField = z.infer<typeof FieldSchema>;
export type LearnClosing = NonNullable<LearnBundle['closing']>;

/** Every concept id the platform knows about (packages/catalogue/concepts.json). */
export const KNOWN_CONCEPTS: ReadonlySet<string> = new Set(registry.concepts.map((c) => c.id));

/**
 * Whether a narration index is of exactly the words of its comic, or the voice would say something the
 * panel does not. `label` names the two files in the messages (learn/audio.json and comic.yaml for the
 * opener, learn/closing-audio.json and closing.yaml for the closing).
 */
export function checkNarration(comic: Comic, audio: LearnAudio, label: { audio: string; comic: string }): string[] {
  const problems: string[] = [];
  // The narration must be of exactly these words, or the voice would say something the panel does not.
  const stale = (msg: string) => problems.push(`${label.audio} is out of date with ${label.comic} (${msg}); run \`labs narrate\` on the lab again`);
  const have = audio.lines;
  const clipOf = (clip: string) => audio.clips[clip];
  if (usesVoiceover(comic)) {
    // The voiceover contract: one clip per panel voiceover, all in the one narrator voice. Made by Workers AI
    // that is NARRATOR_VOICE; imported from another model (`labs narrate --from-dir`) it is the voice those
    // clips were made in, the same for every line. A narration with the cast's voices adds the bubbles (checkBubbleClips).
    const old = have.some((l) => l.kind === 'caption' || (l.kind === 'bubble' && !clipOf(l.clip)?.who));
    const voiceovers = have.filter((l) => l.kind === 'voiceover');
    const want = narrationLines(comic);
    const narrator = audio.model === TTS_MODEL ? NARRATOR_VOICE : (clipOf(voiceovers[0]?.clip ?? '')?.voice ?? NARRATOR_VOICE);
    if (old) {
      stale('it is in the old caption-and-bubble format, and the comic is now told by a voiceover');
    } else if (want.length !== voiceovers.length) {
      stale(`the comic has ${want.length} voiceover${want.length === 1 ? '' : 's'}, the narration ${voiceovers.length}`);
    } else {
      for (let i = 0; i < want.length; i++) {
        const w = want[i]!;
        const h = voiceovers[i]!;
        const clip = clipOf(h.clip);
        if (w.panel !== h.panel) {
          stale(`voiceover ${i + 1} is not where the comic has it`);
          break;
        }
        if (!clip || clip.text !== w.text || clip.voice !== narrator || (clip.who !== undefined && clip.who !== NARRATOR_ID)) {
          stale(`panel ${w.panel + 1}: the voiceover or the narrator\x27s voice changed`);
          break;
        }
      }
      if (have.some((l) => l.kind === 'bubble')) problems.push(...checkBubbleClips(comic, audio, label, narrator));
    }
  } else {
    // An older comic (no voiceover) keeps its older narration (caption and bubble lines) until it is rewritten.
    const want = legacyNarrationLines(comic);
    if (want.length !== have.length) {
      stale(`the comic has ${want.length} spoken lines, the narration ${have.length}`);
    } else {
      for (let i = 0; i < want.length; i++) {
        const w = want[i]!;
        const h = have[i]!;
        const clip = clipOf(h.clip);
        if (w.panel !== h.panel || w.kind !== h.kind || (w.bubble ?? -1) !== (h.bubble ?? -1)) {
          stale(`line ${i + 1} is not where the comic has it`);
          break;
        }
        if (!clip || clip.text !== w.text || clip.voice !== w.voice) {
          stale(`panel ${w.panel + 1}: ${w.kind === 'caption' ? 'the caption' : `bubble ${(w.bubble ?? 0) + 1}`} or its voice changed`);
          break;
        }
      }
    }
  }
  return problems;
}

/**
 * The bubbles of a narration with the cast's voices (it has `bubble` lines whose clips carry `who`): once any
 * bubble is spoken, every bubble of a speaking person (comic-kit spokenLines) must be, in its speaker's own voice
 * (one voice per person, not the narrator's), with the bubble's exact words. A comic must never be half voiced:
 * a spoken bubble with no clip is named, panel and bubble.
 */
function checkBubbleClips(comic: Comic, audio: LearnAudio, label: { audio: string; comic: string }, narrator: string): string[] {
  const problems: string[] = [];
  const stale = (msg: string) => problems.push(`${label.audio} is out of date with ${label.comic} (${msg}); run \`labs narrate --from-dir\` on the lab again`);
  const nameOf = (id: string) => CAST.find((c) => c.id === id)?.name ?? id;
  const want = spokenLines(comic).filter((l) => l.kind === 'bubble');
  const wanted = new Map(want.map((w) => [`${w.panel}:${w.bubble}`, w]));
  const seen = new Set<string>();
  const voiceOf = new Map<string, string>();
  for (const h of audio.lines) {
    if (h.kind !== 'bubble') continue;
    const at = `panel ${h.panel + 1} bubble ${(h.bubble ?? 0) + 1}`;
    const key = `${h.panel}:${h.bubble}`;
    const w = wanted.get(key);
    const clip = audio.clips[h.clip];
    if (!w) {
      stale(`${at}: the comic has no bubble there that a person speaks`);
      continue;
    }
    if (seen.has(key)) {
      stale(`${at} has two clips`);
      continue;
    }
    seen.add(key);
    if (!clip || clip.who !== w.who || clip.text !== w.text) {
      stale(`${at}: the bubble\x27s words or its speaker changed`);
      continue;
    }
    const before = voiceOf.get(w.who);
    if (clip.voice === narrator) stale(`${at}: ${nameOf(w.who)} speaks in the narrator\x27s voice`);
    else if (before !== undefined && before !== clip.voice) stale(`${at}: ${nameOf(w.who)} speaks in two voices (${before} and ${clip.voice})`);
    else voiceOf.set(w.who, clip.voice);
  }
  for (const w of want) {
    if (seen.has(`${w.panel}:${w.bubble}`)) continue;
    problems.push(
      `${label.audio} voices some bubbles but not panel ${w.panel + 1} bubble ${(w.bubble ?? 0) + 1} of ${label.comic} (${nameOf(w.who)}: "${w.text}"): once one bubble is spoken every bubble of ${SPEAKING_CAST_IDS.join(', ')} must be; import its clip with \`labs narrate --from-dir\``
    );
  }
  return problems;
}

/**
 * A comic's diagram panels must name a diagram of packages/catalogue/diagrams.json (`diagrams`), and show no
 * more steps than it has. Messages are worded like checkComic's.
 */
export function checkComicDiagrams(comic: Comic, diagrams: ReadonlySet<string> = KNOWN_DIAGRAMS): string[] {
  const problems: string[] = [];
  const multi = comic.pages.length > 1;
  for (const { panel: p, page, indexInPage } of allPanels(comic)) {
    if (!p.diagram) continue;
    const at = multi ? `comic page ${page} panel ${indexInPage} (${p.scene})` : `comic panel ${indexInPage} (${p.scene})`;
    if (!diagrams.has(p.diagram)) {
      problems.push(`${at}: diagram "${p.diagram}" is not in packages/catalogue/diagrams.json`);
      continue;
    }
    const d = DIAGRAMS.find((x) => x.id === p.diagram);
    if (d && p.steps && p.steps.length > d.steps.length) {
      problems.push(`${at}: lists ${p.steps.length} steps, but diagram "${p.diagram}" has ${d.steps.length}`);
    }
  }
  return problems;
}

/**
 * A comic's clip panels must name a clip of packages/catalogue/clips.json (`clips`). Messages are worded like
 * checkComic's: `comic panel 3 (clip): clip "no-such" is not in packages/catalogue/clips.json`.
 */
export function checkComicClips(comic: Comic, clips: ReadonlySet<string> = KNOWN_CLIPS): string[] {
  const problems: string[] = [];
  const multi = comic.pages.length > 1;
  for (const { panel: p, page, indexInPage } of allPanels(comic)) {
    if (!p.clip) continue;
    const at = multi ? `comic page ${page} panel ${indexInPage} (${p.scene})` : `comic panel ${indexInPage} (${p.scene})`;
    if (!clips.has(p.clip)) problems.push(`${at}: clip "${p.clip}" is not in packages/catalogue/clips.json`);
  }
  return problems;
}

/** Every clip the bundle's narration names, opener and closing together (they share learn/audio/). */
export function learnAudioClips(bundle: Pick<LearnBundle, 'audio' | 'closing'>): LearnAudio['clips'] {
  return { ...(bundle.audio?.clips ?? {}), ...(bundle.closing?.audio?.clips ?? {}) };
}

/**
 * Cross-checks a schema-valid bundle: every reference must resolve, and every
 * lesson must be testable. Returns human-readable problems, empty when fine.
 * `known` defaults to the registry; tests pass their own.
 */
export function checkLearnBundle(
  bundle: LearnBundle,
  known: ReadonlySet<string> = KNOWN_CONCEPTS,
  diagrams: ReadonlySet<string> = KNOWN_DIAGRAMS,
  clipIds: ReadonlySet<string> = KNOWN_CLIPS
): string[] {
  const problems: string[] = [];

  // `::diagram[id]` lines must name a diagram in packages/catalogue/diagrams.json.
  const bodies: [string, string][] = bundle.concepts.map((c) => [`lesson "${c.id}"`, c.body]);
  if (bundle.story) bodies.push(['the story', bundle.story.body]);
  if (bundle.closing) bodies.push(['the closing story', bundle.closing.story.body]);
  for (const [where, body] of bodies) {
    for (const ref of diagramRefs(body)) {
      if (!diagrams.has(ref)) problems.push(`${where} embeds diagram "${ref}", which is not in packages/catalogue/diagrams.json`);
    }
  }

  const conceptIds = bundle.concepts.map((c) => c.id);
  if (new Set(conceptIds).size !== conceptIds.length) problems.push('two lessons have the same concept id');
  for (const id of conceptIds) {
    if (!known.has(id)) problems.push(`concept "${id}" is not in packages/catalogue/concepts.json (add it there first)`);
  }

  const questionIds = bundle.questions.map((q) => q.id);
  if (new Set(questionIds).size !== questionIds.length) problems.push('two questions have the same id');

  const defined = new Set(conceptIds);
  for (const q of bundle.questions) {
    if (!defined.has(q.concept)) problems.push(`question ${q.id} is about "${q.concept}", which has no lesson in this lab`);
  }
  for (const c of bundle.concepts) {
    const asked = bundle.questions.filter((q) => q.concept === c.id && q.diagnostic);
    if (asked.length === 0) problems.push(`lesson "${c.id}" has no diagnostic question, so it can never be skipped`);
  }

  if (bundle.comic) {
    problems.push(...checkComic(bundle.comic), ...checkComicDiagrams(bundle.comic, diagrams), ...checkComicClips(bundle.comic, clipIds));
    if (!bundle.story) problems.push('a comic needs learn/story.md too: the text story is what screen readers, skipped comics and old consoles show');
  }

  if (bundle.audio) {
    if (!bundle.comic) problems.push('learn/audio.json narrates the comic, but there is no comic.yaml');
    else problems.push(...checkNarration(bundle.comic, bundle.audio, { audio: 'learn/audio.json', comic: 'comic.yaml' }));
  }

  if (bundle.closing) {
    problems.push(
      ...[...checkComic(bundle.closing.comic), ...checkComicDiagrams(bundle.closing.comic, diagrams), ...checkComicClips(bundle.closing.comic, clipIds)].map((p) => `closing: ${p}`)
    );
    if (bundle.closing.audio) problems.push(...checkNarration(bundle.closing.comic, bundle.closing.audio, { audio: 'learn/closing-audio.json', comic: 'closing.yaml' }));
  }
  const clips = new Set(Object.keys(learnAudioClips(bundle)));
  if (clips.size > MAX_AUDIO_CLIPS) problems.push(`the opener and the closing need ${clips.size} distinct clips together; a lab may carry at most ${MAX_AUDIO_CLIPS}`);

  if (bundle.games.length > 0) {
    if (!bundle.closing) problems.push('games are played after the closing: write learn/closing.md and learn/closing.yaml too');
    if (bundle.fields.length > 0) problems.push('a lab has either games (games.yaml) or fields (questions.yaml), not both');
    const gameIds = bundle.games.map((g) => g.id);
    if (new Set(gameIds).size !== gameIds.length) problems.push('two games have the same id');
  }

  const keys = bundle.fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) problems.push('two fields have the same answers.json key');

  if (bundle.concepts.length === 0 && bundle.questions.length > 0) problems.push('questions without any lesson: write at least one concepts/<id>.md');
  if (!bundle.story && !bundle.comic && !bundle.closing && bundle.concepts.length === 0 && bundle.fields.length === 0) problems.push('the learn/ folder has no story, no lesson and no field');
  return problems;
}

/** Parses and cross-checks unknown JSON; throws an Error listing every problem. */
export function parseLearnBundle(
  raw: unknown,
  known: ReadonlySet<string> = KNOWN_CONCEPTS,
  diagrams: ReadonlySet<string> = KNOWN_DIAGRAMS,
  clipIds: ReadonlySet<string> = KNOWN_CLIPS
): LearnBundle {
  const parsed = LearnBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'Invalid learn bundle: ' + parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    );
  }
  const problems = checkLearnBundle(parsed.data, known, diagrams, clipIds);
  if (problems.length > 0) throw new Error('Invalid learn bundle: ' + problems.join('; '));
  return parsed.data;
}
