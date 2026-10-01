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
  /**
   * A retired person is still drawn (so an older comic keeps playing) but may not appear in a comic
   * written to the voiceover contract: they are mentioned in the voiceover or a caption instead.
   */
  retired?: true;
}

/**
 * The team of the story: Maren (the platform lead, who is also the storyteller: she briefs you),
 * Tomasz (the engineer who built things) and You (the learner). Finance, Support and data protection
 * (Jonas, Priya, Anneke) are retired from the drawn cast: the story mentions them or shows their
 * messages, but they are never drawn, never in `cast`, never a bubble speaker, and never voiced.
 */
export const CAST: readonly CastMember[] = [
  { id: 'maren', name: 'Maren', role: 'Platform lead' },
  { id: 'tomasz', name: 'Tomasz', role: 'Staff engineer' },
  { id: 'priya', name: 'Priya', role: 'Head of Support', retired: true },
  { id: 'jonas', name: 'Jonas', role: 'Finance', retired: true },
  { id: 'anneke', name: 'Anneke', role: 'Data protection', retired: true },
  { id: 'you', name: 'You', role: 'New platform engineer' },
];
/** The people a comic written to the voiceover contract may draw. */
export const ACTIVE_CAST_IDS: readonly string[] = CAST.filter((c) => !c.retired).map((c) => c.id);
export const RETIRED_CAST_IDS: readonly string[] = CAST.filter((c) => c.retired).map((c) => c.id);

/**
 * The one storyteller voice: a single narrator (Maren, the platform lead, speaking to her team) reads
 * every `voiceover`. It is chosen here and only here: change it, run `labs narrate` again and every
 * clip is made anew. Other female Workers AI Aura-2 voices to try: athena, luna, helena, andromeda, juno, vesta.
 */
export const NARRATOR_VOICE = 'thalia';
/** Longest a panel's voiceover may be, in characters (about 40 words, a few breaths of speech). */
export const VOICEOVER_MAX = 240;
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
  /** What the storyteller says over the panel (also in the transcript: the story is told by it). */
  voiceover?: string;
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
    if (p.voiceover) parts.push(p.voiceover);
    for (const b of p.bubbles) parts.push(b.who ? `${nameOf.get(b.who) ?? b.who}: ${b.text}` : b.text);
    if (p.lines && p.lines.length > 0) parts.push(`On screen: ${p.lines.join(' / ')}`);
    out.push(`Panel ${i + 1}. ${parts.join(' ')}`);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Narration: which words are spoken, by whom, and the name of their clip
// ---------------------------------------------------------------------------

/** One spoken line of a comic: a panel's voiceover. `panel` counts across pages from 0. */
export interface NarrationLine {
  panel: number;
  kind: 'voiceover';
  voice: string;
  text: string;
}

/** Whether a comic is written to the voiceover contract: at least one panel has a `voiceover`. */
export function usesVoiceover(comic: { pages: readonly { panels: readonly { voiceover?: string }[] }[] }): boolean {
  return comic.pages.some((pg) => pg.panels.some((p) => Boolean(p.voiceover)));
}

/**
 * What is read aloud, in reading order: the voiceover of each panel that has one, all in the narrator's
 * voice (one storyteller). Captions, bubbles (text only), screen lines and sound effects are never
 * spoken; a panel with no voiceover has no clip.
 */
export function narrationLines(comic: { pages: readonly { panels: readonly TranscriptPanel[] }[] }): NarrationLine[] {
  const out: NarrationLine[] = [];
  let panel = 0;
  for (const pg of comic.pages) {
    for (const p of pg.panels) {
      if (p.voiceover) out.push({ panel, kind: 'voiceover', voice: NARRATOR_VOICE, text: p.voiceover });
      panel += 1;
    }
  }
  return out;
}

// ---- the old caption-and-bubble narration -----------------------------------------------------
// Before the voiceover contract a comic was read by several voices. The live labs still carry that
// narration (learn/audio.json with `caption` and `bubble` lines) until their comics are rewritten, and
// `labs learn-check` keeps accepting an old comic (no voiceover) with its own matching old narration.
// Nothing new is made this way, and the console never plays it.

export const LEGACY_NARRATOR_VOICE = 'atlas';
const LEGACY_VOICES: Readonly<Record<string, string>> = { maren: 'thalia', tomasz: 'orion', priya: 'luna', jonas: 'arcas', anneke: 'andromeda' };

export interface LegacyNarrationLine {
  panel: number;
  kind: 'caption' | 'bubble';
  bubble?: number;
  voice: string;
  text: string;
}

/** The old definition of what is spoken: per panel the caption (narrator), then each bubble in its speaker's voice. */
export function legacyNarrationLines(comic: { pages: readonly { panels: readonly TranscriptPanel[] }[] }): LegacyNarrationLine[] {
  const out: LegacyNarrationLine[] = [];
  let panel = 0;
  for (const pg of comic.pages) {
    for (const p of pg.panels) {
      if (p.caption) out.push({ panel, kind: 'caption', voice: LEGACY_NARRATOR_VOICE, text: p.caption });
      p.bubbles.forEach((b, bubble) => {
        const voice = b.who ? LEGACY_VOICES[b.who] : LEGACY_NARRATOR_VOICE;
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
