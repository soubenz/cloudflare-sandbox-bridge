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
  /** The text-to-speech voice (TTS_MODEL speaker) that reads this person's bubbles. The learner (`you`) has none: never spoken. */
  voice?: string;
}

/**
 * The recurring people of the story bible (docs/story-bible-ai-platform.md), plus the learner.
 * The voices are chosen here and only here (with NARRATOR_VOICE): change one, run `labs narrate`
 * again and only the clips of that voice are made anew.
 */
export const CAST: readonly CastMember[] = [
  { id: 'maren', name: 'Maren', role: 'Platform lead', voice: 'thalia' },
  { id: 'tomasz', name: 'Tomasz', role: 'Staff engineer', voice: 'orion' },
  { id: 'priya', name: 'Priya', role: 'Head of Support', voice: 'luna' },
  { id: 'jonas', name: 'Jonas', role: 'Finance', voice: 'arcas' },
  { id: 'anneke', name: 'Anneke', role: 'Data protection', voice: 'andromeda' },
  { id: 'you', name: 'You', role: 'New platform engineer' },
];

/** Reads every caption, and any bubble that names no speaker. */
export const NARRATOR_VOICE = 'atlas';
/** Workers AI text-to-speech model that makes the narration (`labs narrate`). */
export const TTS_MODEL = '@cf/deepgram/aura-2-en';
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

/** Width of a full row of three columns. */
export const PAGE_W = PAGE.columns * PAGE.colW + (PAGE.columns - 1) * PAGE.gap;

/**
 * Flows one page's panels into rows of up to three columns, in reading order,
 * and centres every row that does not fill the width. Any number of panels
 * works: a wide panel that does not fit the rest of a row starts the next row,
 * and a short row (one wide panel, two squares) simply sits in the middle of
 * the page. `problems` stays empty; it is kept so callers need not change.
 */
export function layoutComic(panels: readonly PanelLike[]): { placements: Placement[]; rows: number; height: number; problems: string[] } {
  const rows: { index: number; span: number }[][] = [[]];
  let used = 0;
  panels.forEach((p, index) => {
    const span = SCENES[p.scene].span;
    if (used + span > PAGE.columns) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]!.push({ index, span });
    used += span;
  });
  const placements: Placement[] = [];
  rows.forEach((row, r) => {
    if (row.length === 0) return;
    const cols = row.reduce((n, c) => n + c.span, 0);
    const gaps = row.length - 1 + row.reduce((n, c) => n + (c.span - 1), 0);
    const width = cols * PAGE.colW + gaps * PAGE.gap;
    let x = (PAGE_W - width) / 2;
    let col = 0;
    for (const c of row) {
      const w = c.span * PAGE.colW + (c.span - 1) * PAGE.gap;
      placements.push({ index: c.index, row: r, col, span: c.span, x, y: r * (PAGE.rowH + PAGE.gap), w, h: PAGE.rowH });
      x += w + PAGE.gap;
      col += c.span;
    }
  });
  placements.sort((a, b) => a.index - b.index);
  const usedRows = rows.filter((r) => r.length > 0).length;
  return { placements, rows: usedRows, height: usedRows * PAGE.rowH + (usedRows - 1) * PAGE.gap, problems: [] };
}

/**
 * Seconds a panel stays on screen: a base beat to take in the picture plus reading
 * time for its words (about 0.3 s a word, a relaxed 200 words a minute), so nobody
 * is hurried; the typing finishes well before the panel moves on.
 */
export function panelSeconds(words: number): number {
  return Math.min(18, Math.max(5, 4.4 + words * 0.3));
}

export interface TranscriptPanel {
  caption?: string;
  bubbles: { who?: string; text: string }[];
  lines?: string[];
}

export interface TranscriptPage {
  title?: string;
  panels: readonly TranscriptPanel[];
}

/** Plain text of a multi-page comic: panels are numbered across pages, pages get a heading line. */
export function comicPagesTranscript(pages: readonly TranscriptPage[]): string[] {
  if (pages.length === 1) return comicTranscript(pages[0]!.panels);
  const out: string[] = [];
  let n = 0;
  pages.forEach((pg, pi) => {
    out.push(`Page ${pi + 1}${pg.title ? `: ${pg.title}` : ''}.`);
    comicTranscript(pg.panels).forEach((line) => {
      n += 1;
      out.push(line.replace(/^Panel \d+\./, `Panel ${n}.`));
    });
  });
  return out;
}

/** Plain text of one page, for screen readers and the 'read as text' view. */
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

// ---------------------------------------------------------------------------
// Narration: which words are spoken, by whom, and the name of their clip
// ---------------------------------------------------------------------------

/** One spoken line of a comic. `panel` counts across pages from 0; `bubble` is the bubble's index within its panel. */
export interface NarrationLine {
  panel: number;
  kind: 'caption' | 'bubble';
  bubble?: number;
  voice: string;
  text: string;
}

/**
 * What is read aloud, in reading order: per panel the caption first (narrator), then
 * its bubbles in order (the speaker's voice; a bubble with no speaker is the narrator's).
 * Screen lines and sound effects are never spoken, and neither is the learner (`you`).
 */
export function narrationLines(comic: { pages: readonly { panels: readonly TranscriptPanel[] }[] }): NarrationLine[] {
  const voiceOf = new Map(CAST.map((c) => [c.id, c.voice]));
  const out: NarrationLine[] = [];
  let panel = 0;
  for (const pg of comic.pages) {
    for (const p of pg.panels) {
      if (p.caption) out.push({ panel, kind: 'caption', voice: NARRATOR_VOICE, text: p.caption });
      p.bubbles.forEach((b, bubble) => {
        const voice = b.who ? voiceOf.get(b.who) : NARRATOR_VOICE;
        if (voice && b.text) out.push({ panel, kind: 'bubble', bubble, voice, text: b.text });
      });
      panel += 1;
    }
  }
  return out;
}

/**
 * The file name (without .mp3) of a spoken line: sixteen hex digits of the hash of model, voice and
 * text, so identical words in the same voice share one file and a changed word, voice or model
 * makes a new one. `hash` returns a hex digest (sha256 in the CLI); it is passed in so this file
 * keeps no dependency the console bundle would have to carry.
 */
export function clipKey(model: string, voice: string, text: string, hash: (input: string) => string): string {
  return hash(`${model}\n${voice}\n${text}`).slice(0, 16);
}
