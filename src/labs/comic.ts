import { z } from 'zod';
import { BACKGROUNDS, BUBBLE_POSITIONS, CAST_IDS, PROPS, SCENES, SCENE_IDS } from './comic-kit';

/**
 * The story as a motion comic. Authors write `learn/comic.yaml`:
 *
 *   title: Which provider answered?
 *   panels:
 *     - scene: desk
 *       cast: [jonas]
 *       caption: Tuesday, a little after ten.
 *       bubbles: [{ who: jonas, text: "Which provider answered?" }]
 *       lines: ["$ $ $", "?"]
 *
 * The console plays it like a video: a camera moves across the comic page and
 * zooms into each panel as it pops in. Art is drawn from code (comic-kit.ts),
 * so a comic is a few lines of data per panel, never an image.
 */

const plain = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[<>]/.test(s) && !s.includes('\n'), 'plain single-line text, no markup');

export const BubbleSchema = z.object({
  who: z.enum(CAST_IDS).optional(),
  text: plain(150),
  pos: z.enum(BUBBLE_POSITIONS).optional(),
});

export const PanelSchema = z.object({
  scene: z.enum(SCENE_IDS),
  cast: z.array(z.enum(CAST_IDS)).max(2).default([]),
  bg: z.enum(BACKGROUNDS).optional(),
  prop: z.enum(PROPS).default('none'),
  caption: plain(100).optional(),
  bubbles: z.array(BubbleSchema).max(2).default([]),
  /** Sound effect word slammed onto the panel, e.g. PING! */
  sfx: plain(14).optional(),
  /** What a screen or laptop shows, one line per entry; typed out in order. */
  lines: z.array(plain(44)).max(6).optional(),
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

/** Cross-checks a schema-valid comic: cast counts, speakers present, length. */
export function checkComic(comic: Comic): string[] {
  const problems: string[] = [];
  const multi = comic.pages.length > 1;
  for (const { panel: p, page, indexInPage } of allPanels(comic)) {
    const at = multi ? `comic page ${page} panel ${indexInPage} (${p.scene})` : `comic panel ${indexInPage} (${p.scene})`;
    const rule = SCENES[p.scene];
    if (p.cast.length < rule.minCast || p.cast.length > rule.maxCast) {
      problems.push(`${at}: needs ${rule.minCast === rule.maxCast ? rule.minCast : `${rule.minCast} to ${rule.maxCast}`} cast member(s), has ${p.cast.length}`);
    }
    if (new Set(p.cast).size !== p.cast.length) problems.push(`${at}: the same person appears twice`);
    for (const b of p.bubbles) {
      if (b.who && !p.cast.includes(b.who)) problems.push(`${at}: ${b.who} speaks but is not in the panel's cast`);
    }
    if (p.bubbles.length === 0 && !p.caption && !(p.lines && p.lines.length > 0)) {
      problems.push(`${at}: says nothing (add a caption, a bubble or screen lines)`);
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
  const words = (pg: ComicPage) => pg.panels.reduce((n, p) => n + p.bubbles.reduce((m, b) => m + b.text.split(/\s+/).length, 0), 0);
  comic.pages.forEach((pg, i) => {
    if (words(pg) > 130) problems.push(`page ${i + 1} has ${words(pg)} spoken words; keep a page under 130 so it reads in about a minute`);
  });
  const all = comic.pages.reduce((n, pg) => n + words(pg), 0);
  if (all > 520) problems.push(`the comic has ${all} spoken words in all; keep it under 520 so the whole thing plays in under six minutes`);
  return problems;
}
