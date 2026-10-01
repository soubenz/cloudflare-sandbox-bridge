import { z } from 'zod';
import registry from '../../packages/catalogue/concepts.json';
import { KNOWN_DIAGRAMS, diagramRefs } from './diagram';
import { ComicSchema, checkComic } from './comic';
import { narrationLines } from './comic-kit';

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
  /** One entry per area of concepts.json: what the checklist says under its title. */
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
  for (const area of listed) {
    if (!(area in registry.areas)) problems.push(`onboarding area "${area}" is not an area in packages/catalogue/concepts.json`);
  }
  for (const area of Object.keys(registry.areas)) {
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
    placeholder: plain(80).optional(),
    help: plain(300).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.kind === 'choice' && !f.choices) ctx.addIssue({ code: 'custom', message: `field ${f.key}: a choice field needs choices` });
    if (f.kind !== 'choice' && f.choices) ctx.addIssue({ code: 'custom', message: `field ${f.key}: only a choice field has choices` });
  });

/** Most distinct narration clips one lab may carry, and the largest one, in bytes (about 70 s of speech at 48 kbps is 400 KB). */
export const MAX_AUDIO_CLIPS = 80;
export const MAX_AUDIO_CLIP_BYTES = 400 * 1024;
/** A clip's file name is its key plus this; the key is sixteen hex digits (comic-kit.ts clipKey). */
export const CLIP_KEY = /^[0-9a-f]{16}$/;

/**
 * The narration of the comic (learn/audio.json, written by `labs narrate`): which clip reads
 * which line. The mp3 files themselves are not in the bundle; `labs publish` uploads them
 * beside it (docs/api.md) and the console plays them from /api/audio/<slug>/<key>.mp3.
 * `lines` has one entry per spoken line of the comic in reading order (comic-kit narrationLines).
 */
export const AudioSchema = z
  .object({
    model: z.string().min(1).max(80),
    clips: z
      .record(
        z.string().regex(CLIP_KEY),
        z.object({
          voice: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
          text: plain(150),
          seconds: z.number().min(0.05).max(70),
          bytes: z.number().int().min(1).max(MAX_AUDIO_CLIP_BYTES),
        })
      )
      .refine((c) => Object.keys(c).length <= MAX_AUDIO_CLIPS, `at most ${MAX_AUDIO_CLIPS} clips`),
    lines: z
      .array(
        z.object({
          panel: z.number().int().min(0).max(35),
          kind: z.enum(['caption', 'bubble']),
          bubble: z.number().int().min(0).max(1).optional(),
          clip: z.string().regex(CLIP_KEY),
        })
      )
      .max(108),
  })
  .superRefine((a, ctx) => {
    for (const l of a.lines) {
      if (!(l.clip in a.clips)) ctx.addIssue({ code: 'custom', message: `narration line for panel ${l.panel + 1} names clip ${l.clip}, which is not in clips` });
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
});

export type LearnBundle = z.infer<typeof LearnBundleSchema>;
export type LearnQuestion = z.infer<typeof QuestionSchema>;
export type LearnConcept = z.infer<typeof ConceptSchema>;
export type LearnField = z.infer<typeof FieldSchema>;

/** Every concept id the platform knows about (packages/catalogue/concepts.json). */
export const KNOWN_CONCEPTS: ReadonlySet<string> = new Set(registry.concepts.map((c) => c.id));

/**
 * Cross-checks a schema-valid bundle: every reference must resolve, and every
 * lesson must be testable. Returns human-readable problems, empty when fine.
 * `known` defaults to the registry; tests pass their own.
 */
export function checkLearnBundle(
  bundle: LearnBundle,
  known: ReadonlySet<string> = KNOWN_CONCEPTS,
  diagrams: ReadonlySet<string> = KNOWN_DIAGRAMS
): string[] {
  const problems: string[] = [];

  // `::diagram[id]` lines must name a diagram in packages/catalogue/diagrams.json.
  const bodies: [string, string][] = bundle.concepts.map((c) => [`lesson "${c.id}"`, c.body]);
  if (bundle.story) bodies.push(['the story', bundle.story.body]);
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
    problems.push(...checkComic(bundle.comic));
    if (!bundle.story) problems.push('a comic needs learn/story.md too: the text story is what screen readers, skipped comics and old consoles show');
  }

  if (bundle.audio) {
    if (!bundle.comic) {
      problems.push('learn/audio.json narrates the comic, but there is no comic.yaml');
    } else {
      // The narration must be of exactly these words, or the voice would say something the panel does not.
      const want = narrationLines(bundle.comic);
      const have = bundle.audio.lines;
      const stale = (msg: string) => problems.push(`learn/audio.json is out of date with comic.yaml (${msg}); run \`labs narrate\` on the lab again`);
      if (want.length !== have.length) {
        stale(`the comic has ${want.length} spoken lines, the narration ${have.length}`);
      } else {
        for (let i = 0; i < want.length; i++) {
          const w = want[i]!;
          const h = have[i]!;
          const clip = bundle.audio.clips[h.clip];
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
  }

  const keys = bundle.fields.map((f) => f.key);
  if (new Set(keys).size !== keys.length) problems.push('two fields have the same answers.json key');

  if (bundle.concepts.length === 0 && bundle.questions.length > 0) problems.push('questions without any lesson: write at least one concepts/<id>.md');
  if (!bundle.story && !bundle.comic && bundle.concepts.length === 0 && bundle.fields.length === 0) problems.push('the learn/ folder has no story, no lesson and no field');
  return problems;
}

/** Parses and cross-checks unknown JSON; throws an Error listing every problem. */
export function parseLearnBundle(
  raw: unknown,
  known: ReadonlySet<string> = KNOWN_CONCEPTS,
  diagrams: ReadonlySet<string> = KNOWN_DIAGRAMS
): LearnBundle {
  const parsed = LearnBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      'Invalid learn bundle: ' + parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    );
  }
  const problems = checkLearnBundle(parsed.data, known, diagrams);
  if (problems.length > 0) throw new Error('Invalid learn bundle: ' + problems.join('; '));
  return parsed.data;
}
