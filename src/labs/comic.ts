import { z } from 'zod';
import { BACKGROUNDS, BUBBLE_POSITIONS, CAST_IDS, PROPS, SCENES, SCENE_IDS, layoutComic } from './comic-kit';

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

export const ComicSchema = z.object({
  title: plain(80),
  panels: z.array(PanelSchema).min(4).max(9),
});

export type Comic = z.infer<typeof ComicSchema>;
export type ComicPanel = z.infer<typeof PanelSchema>;

/** Cross-checks a schema-valid comic: cast counts, speakers present, page tiling. */
export function checkComic(comic: Comic): string[] {
  const problems: string[] = [];
  comic.panels.forEach((p, i) => {
    const at = `comic panel ${i + 1} (${p.scene})`;
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
  });
  problems.push(...layoutComic(comic.panels).problems);
  const words = comic.panels.reduce((n, p) => n + p.bubbles.reduce((m, b) => m + b.text.split(/\s+/).length, 0), 0);
  if (words > 160) problems.push(`the comic has ${words} spoken words; keep it under 160 so it plays in about a minute`);
  return problems;
}
