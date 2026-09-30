/**
 * The motion comic's shared vocabulary: who can appear, which scene templates
 * exist, and how panels tile into the comic page. No dependencies, so the
 * Worker, the CLI and the console bundle can all import it.
 *
 * A comic is data (labs/<slug>/learn/comic.yaml, see docs/learning-content.md):
 * a list of panels, each naming a scene template, who is in it, what they
 * say. The console draws the art from code; nothing here is an image.
 */

export interface CastMember {
  id: string;
  name: string;
  role: string;
}

/** The recurring people of the story bible (docs/story-bible-ai-platform.md), plus the learner. */
export const CAST: readonly CastMember[] = [
  { id: 'maren', name: 'Maren', role: 'Platform lead' },
  { id: 'tomasz', name: 'Tomasz', role: 'Staff engineer' },
  { id: 'priya', name: 'Priya', role: 'Head of Support' },
  { id: 'jonas', name: 'Jonas', role: 'Finance' },
  { id: 'anneke', name: 'Anneke', role: 'Data protection' },
  { id: 'you', name: 'You', role: 'New platform engineer' },
];
export const CAST_IDS = CAST.map((c) => c.id) as [string, ...string[]];

/**
 * Scene templates. `span` is how many of the page's three columns the panel
 * takes: a wide panel is 2, a square one is 1.
 *   desk      a person at a desk with a screen (lines = what the screen shows)
 *   message   something arrives: a prop flies in with a sound effect
 *   portrait  one person, big, with light rays and an optional prop
 *   screen    close-up of a terminal (lines are typed one by one)
 *   duo       two people side by side
 *   you       the learner at a laptop, then the call to action
 */
export const SCENES = {
  desk: { span: 2, minCast: 1, maxCast: 1 },
  message: { span: 1, minCast: 1, maxCast: 1 },
  portrait: { span: 1, minCast: 1, maxCast: 1 },
  screen: { span: 2, minCast: 0, maxCast: 0 },
  duo: { span: 1, minCast: 2, maxCast: 2 },
  you: { span: 2, minCast: 0, maxCast: 0 },
} as const;
export type SceneId = keyof typeof SCENES;
export const SCENE_IDS = Object.keys(SCENES) as [SceneId, ...SceneId[]];

export const BACKGROUNDS = ['ice', 'sand', 'mint', 'navy', 'lilac', 'cobalt', 'rose'] as const;
export const PROPS = ['none', 'envelope', 'laptop', 'chart', 'map', 'key', 'document'] as const;
export const BUBBLE_POSITIONS = ['tl', 'tr', 'bl', 'br'] as const;

/** Page geometry shared by the renderer's camera. Three columns of this width. */
export const PAGE = { columns: 3, colW: 337.33, gap: 22, rowH: 320 } as const;

export interface PanelLike {
  scene: SceneId;
}
export interface Placement {
  index: number;
  row: number;
  col: number;
  span: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Packs panels into rows of three columns, in reading order. A set of panels
 * is valid only when every row fills exactly: a wide panel that cannot fit the
 * remaining space would leave a hole, so the author must reorder.
 */
export function layoutComic(panels: readonly PanelLike[]): { placements: Placement[]; rows: number; problems: string[] } {
  const placements: Placement[] = [];
  const problems: string[] = [];
  let row = 0;
  let col = 0;
  panels.forEach((p, index) => {
    const span = SCENES[p.scene].span;
    if (col + span > PAGE.columns) {
      problems.push(`panel ${index + 1} (${p.scene}) does not fit the rest of row ${row + 1}: reorder so every row fills (a wide panel counts 2 of 3 columns)`);
      row += 1;
      col = 0;
    }
    const w = span * PAGE.colW + (span - 1) * PAGE.gap;
    placements.push({ index, row, col, span, x: col * (PAGE.colW + PAGE.gap), y: row * (PAGE.rowH + PAGE.gap), w, h: PAGE.rowH });
    col += span;
    if (col === PAGE.columns) {
      row += 1;
      col = 0;
    }
  });
  if (col !== 0) problems.push(`the last row is not full (${col} of ${PAGE.columns} columns used)`);
  return { placements, rows: row + (col > 0 ? 1 : 0), problems };
}

/** Seconds a panel stays on screen: a base beat plus reading time for its words. */
export function panelSeconds(words: number): number {
  return Math.min(7.5, Math.max(3.6, 2.6 + words * 0.14));
}

export interface TranscriptPanel {
  caption?: string;
  bubbles: { who?: string; text: string }[];
  lines?: string[];
}

/** Plain text of the whole comic, for screen readers and the 'read as text' view. */
export function comicTranscript(panels: readonly TranscriptPanel[]): string[] {
  const nameOf = new Map(CAST.map((c) => [c.id, c.name]));
  const out: string[] = [];
  panels.forEach((p, i) => {
    const parts: string[] = [];
    if (p.caption) parts.push(p.caption);
    for (const b of p.bubbles) parts.push(b.who ? `${nameOf.get(b.who) ?? b.who}: ${b.text}` : b.text);
    if (p.lines && p.lines.length > 0) parts.push(`On screen: ${p.lines.join(' / ')}`);
    out.push(`Panel ${i + 1}. ${parts.join(' ')}`);
  });
  return out;
}
