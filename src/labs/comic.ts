import { z } from 'zod';
import {
  BACKGROUNDS,
  BUBBLE_POSITIONS,
  CAST_IDS,
  MOODS,
  POSES,
  PROPS,
  RETIRED_CAST_IDS,
  SCENES,
  SCENE_IDS,
  SHOTS,
  STING_SOUNDS,
  VOICEOVER_MAX,
  castId,
  cuedCue,
  cueSpan,
  usesVoiceover,
} from './comic-kit';

/**
 * The story as a motion comic. Authors write `learn/comic.yaml`:
 *
 *   title: Which provider answered?
 *   panels:
 *     - scene: desk
 *       cast: [tomasz]
 *       caption: Tuesday, a little after ten.
 *       voiceover: Finance had a question on Tuesday, and nobody in the room could answer it.
 *       bubbles: [{ who: tomasz, text: "Which provider answered?" }]
 *       lines: ["$ $ $", "?"]
 *
 * The console plays it like a video: a camera moves across the comic page and
 * zooms into each panel as it pops in. Art is drawn from code (comic-kit.ts),
 * so a comic is a few lines of data per panel, never an image. The story is told
 * by ONE storyteller voice (the `voiceover` of each panel, read by Maren); `caption`
 * is a short on-screen label and `bubbles` are speech shown as text only, never voiced.
 *
 * Motion comic v2 (docs/learning-content.md): a caption, sfx, bubble or screen line can carry a `cue`, a
 * phrase of the voiceover it appears on; a panel can have a `shot` (close, wide); cast entries can carry a
 * `mood` and `pose`; `bg: night`; an `sfx` can make a `sound`; and two scenes draw no person of their own:
 * `black` (a dark card of stacked `captions`) and `diagram` (a diagram of the catalogue, stepped through).
 */

const plain = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[<>]/.test(s) && !s.includes('\n'), 'plain single-line text, no markup');

/** A phrase of the panel's voiceover that an element appears on (checkComic holds it to the voiceover). */
const cue = plain(VOICEOVER_MAX);
/** Plain text, or `{ text, cue }` to time it to its cue. */
const cued = (max: number) => z.union([plain(max), z.object({ text: plain(max), cue: cue.optional() }).strict()]);

export const BubbleSchema = z.object({
  who: z.enum(CAST_IDS).optional(),
  text: plain(150),
  pos: z.enum(BUBBLE_POSITIONS).optional(),
  /** The bubble pops once the voiceover has said this phrase (it reacts to the words). */
  cue: cue.optional(),
});

/** Who is drawn: an id, or the id with how they look and what they are doing. */
export const CastEntrySchema = z.union([
  z.enum(CAST_IDS),
  z.object({ who: z.enum(CAST_IDS), mood: z.enum(MOODS).optional(), pose: z.enum(POSES).optional() }).strict(),
]);

export const PanelSchema = z.object({
  scene: z.enum(SCENE_IDS),
  cast: z.array(CastEntrySchema).max(2).default([]),
  bg: z.enum(BACKGROUNDS).optional(),
  prop: z.enum(PROPS).default('none'),
  caption: cued(100).optional(),
  /** What the storyteller says over this panel (spoken, not shown as text on the panel). Optional: narration is optional. */
  voiceover: plain(VOICEOVER_MAX).optional(),
  bubbles: z.array(BubbleSchema).max(2).default([]),
  /** Sound effect word slammed onto the panel, e.g. PING!, optionally with a cue and a short sound (a sting). */
  sfx: z.union([plain(14), z.object({ text: plain(14), cue: cue.optional(), sound: z.enum(STING_SOUNDS).optional() }).strict()]).optional(),
  /** What a screen or laptop shows, one line per entry; typed out in order. */
  lines: z.array(cued(44)).max(6).optional(),
  /** The camera: `close` pushes in on the panel once it has landed, `wide` shows the panel's whole row. */
  shot: z.enum(SHOTS).optional(),
  /** A black card's heading. */
  title: plain(60).optional(),
  /** A black card's lines, stacked one under the other as the voiceover reaches their cues. */
  captions: z.array(cued(80)).max(5).optional(),
  /** A diagram scene's diagram: an id of packages/catalogue/diagrams.json. */
  diagram: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'a diagram id: lowercase letters, digits and hyphens').optional(),
  /** The diagram's steps to show, in order, one entry each (the first N of the diagram); all of them when absent. */
  steps: z.array(z.object({ cue: cue.optional() }).strict()).min(1).max(8).optional(),
});

export const PageSchema = z.object({
  /** Optional page heading, e.g. a chapter line shown when the camera turns the page. */
  title: plain(60).optional(),
  panels: z.array(PanelSchema).min(1).max(9),
});

/**
 * A comic has one or more pages. Write `pages:` for several, or a flat
 * `panels:` list for a single page; both normalise to `pages`.
 */
export const ComicSchema = z
  .object({
    title: plain(80),
    pages: z.array(PageSchema).min(1).max(6).optional(),
    panels: z.array(PanelSchema).min(1).max(9).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.pages && c.panels) ctx.addIssue({ code: 'custom', message: 'write either pages or panels, not both' });
    if (!c.pages && !c.panels) ctx.addIssue({ code: 'custom', message: 'a comic needs pages (or a flat panels list)' });
  })
  .transform((c) => ({ title: c.title, pages: c.pages ?? [{ panels: c.panels! }] }));

export type Comic = z.output<typeof ComicSchema>;
export type ComicPage = Comic['pages'][number];
export type ComicPanel = z.infer<typeof PanelSchema>;

/** Every panel of a comic in reading order, with the page it is on. */
export function allPanels(comic: Comic): { panel: ComicPanel; page: number; indexInPage: number; number: number }[] {
  const out: { panel: ComicPanel; page: number; indexInPage: number; number: number }[] = [];
  comic.pages.forEach((pg, pi) => pg.panels.forEach((panel, i) => out.push({ panel, page: pi + 1, indexInPage: i + 1, number: out.length + 1 })));
  return out;
}

/**
 * Every cue of a panel that is not a phrase of its voiceover (matched case-insensitively, white space as one
 * space), named by element: a cue on a panel with no voiceover has nothing to be timed to.
 */
export function checkCues(p: ComicPanel): string[] {
  const cues: [string, string | undefined][] = [
    ['the caption', cuedCue(p.caption)],
    ['the sfx', cuedCue(p.sfx)],
    ...p.bubbles.map((b, i): [string, string | undefined] => [`bubble ${i + 1}`, b.cue]),
    ...(p.lines ?? []).map((l, i): [string, string | undefined] => [`screen line ${i + 1}`, cuedCue(l)]),
    ...(p.captions ?? []).map((c, i): [string, string | undefined] => [`caption ${i + 1}`, cuedCue(c)]),
    ...(p.steps ?? []).map((st, i): [string, string | undefined] => [`step ${i + 1}`, st.cue]),
  ];
  const out: string[] = [];
  for (const [what, c] of cues) {
    if (!c) continue;
    if (!p.voiceover) out.push(`${what} has the cue "${c}", but the panel has no voiceover to time it to`);
    else if (!cueSpan(p.voiceover, c)) out.push(`${what} has the cue "${c}", which is not in the voiceover`);
  }
  return out;
}

/** Most panels a comic written to the voiceover contract may have in all. */
export const MAX_VOICED_PANELS = 9;

/**
 * Cross-checks a schema-valid comic: cast counts, speakers present, length.
 *
 * A comic with at least one `voiceover` is written to the storyteller contract and is held to it: only
 * maren, tomasz and you may be drawn or speak (Priya, Jonas and Anneke are mentioned, never drawn), and it
 * has at most 9 panels. A comic with no voiceover keeps the older rules, so the labs that have not been
 * rewritten yet keep working.
 */
export function checkComic(comic: Comic): string[] {
  const problems: string[] = [];
  const multi = comic.pages.length > 1;
  const voiced = usesVoiceover(comic);
  for (const { panel: p, page, indexInPage } of allPanels(comic)) {
    const at = multi ? `comic page ${page} panel ${indexInPage} (${p.scene})` : `comic panel ${indexInPage} (${p.scene})`;
    const rule = SCENES[p.scene];
    const cast = p.cast.map(castId);
    if (voiced) {
      const retired = new Set<string>();
      for (const id of cast) if (RETIRED_CAST_IDS.includes(id)) retired.add(id);
      for (const b of p.bubbles) if (b.who && RETIRED_CAST_IDS.includes(b.who)) retired.add(b.who);
      for (const id of retired) problems.push(`${at}: ${id} is retired: use maren, tomasz or you; mention them in the voiceover or caption instead`);
    }
    if (cast.length < rule.minCast || cast.length > rule.maxCast) {
      problems.push(`${at}: needs ${rule.minCast === rule.maxCast ? rule.minCast : `${rule.minCast} to ${rule.maxCast}`} cast member(s), has ${cast.length}`);
    }
    if (new Set(cast).size !== cast.length) problems.push(`${at}: the same person appears twice`);
    for (const b of p.bubbles) {
      if (b.who && !cast.includes(b.who)) problems.push(`${at}: ${b.who} speaks but is not in the panel's cast`);
    }
    if (p.bubbles.length === 0 && !p.caption && !p.voiceover && !(p.lines && p.lines.length > 0) && !(p.captions && p.captions.length > 0)) {
      problems.push(`${at}: says nothing (add a voiceover, a caption, a bubble or screen lines)`);
    }
    problems.push(...checkCues(p).map((m) => `${at}: ${m}`));
    if (p.scene === 'black' && !(p.captions && p.captions.length > 0)) problems.push(`${at}: a black card needs captions to show`);
    if (p.scene !== 'black' && (p.captions || p.title)) problems.push(`${at}: captions and title are only for a black card`);
    if (p.scene === 'diagram' && !p.diagram) problems.push(`${at}: a diagram scene needs a diagram (an id of packages/catalogue/diagrams.json)`);
    if (p.scene !== 'diagram' && (p.diagram || p.steps)) problems.push(`${at}: diagram and steps are only for a diagram scene`);
    if (p.voiceover && p.voiceover.length > VOICEOVER_MAX) {
      problems.push(`${at}: the voiceover is ${p.voiceover.length} characters; keep it under ${VOICEOVER_MAX} (about 35 words) so the storyteller says it in one breath`);
    }
    if ((p.scene === 'screen' || p.scene === 'you') && !(p.lines && p.lines.length > 0)) {
      problems.push(`${at}: a ${p.scene} scene needs lines to show`);
    }
    if (p.sfx && p.scene !== 'message' && p.scene !== 'portrait' && p.scene !== 'desk') {
      problems.push(`${at}: sfx is only for message, portrait and desk scenes`);
    }
  }
  const total = allPanels(comic).length;
  if (total < 4) problems.push(`a comic needs at least 4 panels in all (has ${total})`);
  if (total > 36) problems.push(`a comic can have at most 36 panels (has ${total})`);
  if (voiced && total > MAX_VOICED_PANELS) problems.push(`a comic told by a storyteller has at most ${MAX_VOICED_PANELS} panels in all (has ${total}); cut it to the story's turning points`);
  const words = (pg: ComicPage) => pg.panels.reduce((n, p) => n + p.bubbles.reduce((m, b) => m + b.text.split(/\s+/).length, 0), 0);
  comic.pages.forEach((pg, i) => {
    if (words(pg) > 130) problems.push(`page ${i + 1} has ${words(pg)} spoken words; keep a page under 130 so it reads in about a minute`);
  });
  const all = comic.pages.reduce((n, pg) => n + words(pg), 0);
  if (all > 520) problems.push(`the comic has ${all} spoken words in all; keep it under 520 so the whole thing plays in under six minutes`);
  return problems;
}
