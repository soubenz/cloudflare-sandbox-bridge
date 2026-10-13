/**
 * The motion comic's schedule, with no DOM: when every panel appears, when
 * each word of a bubble and each line of a screen is typed, where the camera
 * looks and when, and the little clock machine behind Replay and Skip.
 *
 * Everything the player draws is a pure function of one number, the time `t`
 * in seconds on the comic's single clock (comic.js advances it from
 * requestAnimationFrame and nothing else). That is what makes Replay and Skip
 * exact, the timecode honest, and a screenshot at "7.5 seconds" the same
 * picture every time.
 *
 * The comic is laid out as a reel: every page is a sheet of paper, the sheets
 * stacked top to bottom with a margin round them. The camera is a rectangle of
 * that reel. A page turn is the camera travelling down to the next sheet, and
 * the finish is the camera pulling back until the whole reel is in frame (and
 * the frame growing to fit it), which is also exactly what reduced motion
 * shows from the first moment.
 *
 * The art vocabulary (who, which scenes, panel sizes, `panelSeconds`) comes
 * from src/labs/comic-kit.ts, which the Worker and the CLI use as well.
 */

import {
  BACKGROUNDS,
  BUBBLE_POSITIONS,
  CAST,
  MOODS,
  PAGE_W,
  POSES,
  PROPS,
  SCENES,
  NARRATOR_ID,
  SHOTS,
  SPEAKING_CAST_IDS,
  STING_SOUNDS,
  castId,
  comicPagesTranscript,
  cueSpan,
  layoutComic,
  panelSeconds,
} from '../../src/labs/comic-kit.ts';
import library from '../../packages/catalogue/diagrams.json';
import clipLibrary from '../../packages/catalogue/clips.json';

// ---------------------------------------------------------------------------
// The beats, in seconds
// ---------------------------------------------------------------------------

export const TIMING = {
  /** A beat on the first page before the camera moves in. */
  lead: 1.2,
  /** The camera travelling to the next page. */
  turn: 1.6,
  /** A page's title card, held after the camera has flown to it. */
  title: 2.4,
  /** The camera travelling to a panel as it pops in. */
  move: 0.9,
  /** The panel pops in this long after the camera starts moving, so it lands as the camera arrives. */
  pop: 0.3,
  /** Caption, sound effect, first bubble and screen lines start this long into a panel. */
  caption: 0.5,
  sfx: 0.55,
  content: 0.8,
  /** A bubble pops, then its words type. */
  bubblePop: 0.25,
  /** Pause between one speaker and the next. */
  bubbleGap: 0.25,
  /** Seconds per word when typing a bubble (the pace panelSeconds() budgets for). */
  word: 0.2,
  /** The panel stays this long after its last word, so it can be read (and after its voiceover ends). */
  hold: 2.0,
  /** A voiced panel's storyteller starts this long into the panel, once the picture has landed. */
  voice: 0.6,
  /** Its bubbles (text only) start typing this long after the voiceover starts, one after the other. */
  bubbleLag: 0.8,
  /** The last bubble is finished by this long after the voiceover ends, however many words there are. */
  bubbleTail: 1.0,
  /** Silence the storyteller leaves between the end of one voiceover and the start of the next panel's (the panel hold covers it). */
  breath: 0.5,
  /** With the cast's voices: the silence between one clip of a panel and the next (the voiceover, then each spoken bubble). */
  speakerGap: 0.35,
  /** Slowest a screen line may type, and the shortest. */
  line: 1.0,
  /** Pulling back to the whole comic at the end. */
  outro: 1.8,
  /** The shake that goes with a sound effect. */
  shake: 0.55,
  /** Least time between two captions of a black card appearing, and between two steps of a diagram. */
  stackGap: 0.4,
  stepGap: 0.6,
};

/** How much closer than the usual framing a `shot: close` panel is framed. */
export const CLOSE_ZOOM = 1.35;

/** The reel's geometry, in the units of the page (comic-kit's PAGE). */
export const REEL = { margin: 30, paper: 14, gap: 56, banner: 74, shotPad: 28 };

/** Longest the clock may advance in one frame, so a background tab or a hiccup never skips the comic ahead. */
export const MAX_STEP = 0.25;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Words of a text, or of a cued element `{ text, cue }`. */
const wordsIn = (s) => {
  const text = typeof s === 'string' ? s : s && typeof s === 'object' ? s.text : undefined;
  return typeof text === 'string' ? text.split(/\s+/).filter(Boolean).length : 0;
};

const DIAGRAMS = new Map((Array.isArray(library?.diagrams) ? library.diagrams : []).map((d) => [d.id, d]));
/** A diagram of the shared library (packages/catalogue/diagrams.json) by id, or undefined: what a diagram panel draws. */
export const diagramFor = (id) => (typeof id === 'string' ? DIAGRAMS.get(id) : undefined);
/** How many of its diagram's steps a diagram panel shows: one per entry of `steps`, all of them when it lists none. */
function stepsShown(panel) {
  const d = diagramFor(panel.diagram);
  if (!d) return 0;
  return Array.isArray(panel.steps) && panel.steps.length > 0 ? Math.min(panel.steps.length, d.steps.length) : d.steps.length;
}

// ---------------------------------------------------------------------------
// The clip library (packages/catalogue/clips.json): what a clip panel plays
// ---------------------------------------------------------------------------

/** A clip file as the console serves it (dashboard/public/media/clips/): nothing else is ever put in a src. */
const CLIP_SRC = /^\/media\/clips\/[a-z0-9][a-z0-9._-]{0,99}\.(mp4|webm|webp|png|jpg|jpeg|avif)$/;
const CLIP_IMAGE = /\.(webp|png|jpg|jpeg|avif)$/;
const CLIP_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** A library entry as the player can trust it: `{ id, kind, src, poster?, alt, seconds?, loop }`, or null. */
function cleanClip(c) {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !CLIP_ID.test(c.id)) return null;
  if (c.kind !== 'video' && c.kind !== 'image') return null;
  if (typeof c.src !== 'string' || !CLIP_SRC.test(c.src) || (c.kind === 'image' && !CLIP_IMAGE.test(c.src))) return null;
  const out = { id: c.id, kind: c.kind, src: c.src, alt: typeof c.alt === 'string' ? c.alt.slice(0, 240) : '', loop: c.kind === 'video' && c.loop === true };
  if (typeof c.poster === 'string' && CLIP_SRC.test(c.poster) && CLIP_IMAGE.test(c.poster)) out.poster = c.poster;
  const seconds = Number(c.seconds);
  if (seconds > 0 && seconds <= 120) out.seconds = seconds;
  return out;
}
const CLIPS = new Map((Array.isArray(clipLibrary?.clips) ? clipLibrary.clips : []).map(cleanClip).filter(Boolean).map((c) => [c.id, c]));
/** A clip of the shared library (packages/catalogue/clips.json) by id, cleaned, or undefined: what a clip panel plays. */
export const clipFor = (id) => (typeof id === 'string' ? CLIPS.get(id) : undefined);

/** How far before its end a clip that does not loop rests (its last frame), in seconds. */
export const CLIP_LAST_FRAME = 0.05;

/**
 * The moment of a clip panel's clip (a timeline panel's `clip`, `{ start, end, loop, seconds }`) to show at
 * clock time `t`, for a video `duration` seconds long (the library's `seconds` until the video knows): its first
 * frame before the panel starts, then `(t - start) mod duration` while the panel is on (a clip that does not loop
 * rests on its last frame once it is over), and its last frame from the panel's end on (so Skip shows it too).
 * A pure function of the clock: a seek, Replay and Skip all land on the same frame as playing there would.
 */
export function clipTimeAt(clip, t, duration) {
  const d = Number(duration) > 0 && Number.isFinite(Number(duration)) ? Number(duration) : Number(clip?.seconds) > 0 ? Number(clip.seconds) : 0;
  if (!clip || !(d > 0)) return 0;
  const last = Math.max(0, d - CLIP_LAST_FRAME);
  if (!(t > clip.start)) return 0;
  if (t >= clip.end) return last;
  const run = t - clip.start;
  return clip.loop ? run % d : Math.min(run, last);
}

/** Whether a clip panel's clip is playing at clock time t: while its panel is on, from its start to its end. */
export const clipPlaying = (clip, t) => Boolean(clip) && t >= clip.start && t < clip.end;

/** How far through its panel a clip is at t, 0 to 1: what drives a still's slow push-in (the Ken Burns move). */
export const clipProgress = (clip, t) => (clip && clip.end > clip.start ? clamp((t - clip.start) / (clip.end - clip.start), 0, 1) : 0);

/**
 * Where a scene's screen is, in the panel's own units: `lines` is the box the typed
 * text fills, `device` the monitor or laptop round it. The art draws to these (comic-art.js)
 * and, in a narrow container, the camera pushes in on `device` so the text can be read.
 * A clip panel's screen is a small card over the clip, at its top right.
 */
export const SCREENS = {
  desk: { lines: { x: 352, y: 150, w: 294, h: 84 }, device: { x: 330, y: 132, w: 338, h: 118 } },
  screen: { lines: { x: 78, y: 54, w: 541, h: 170 }, device: { x: 48, y: 26, w: 601, h: 226 } },
  you: { lines: { x: 46, y: 184, w: 372, h: 104 }, device: { x: 20, y: 164, w: 424, h: 140 } },
  clip: { lines: { x: 436, y: 34, w: 226, h: 92 }, device: { x: 420, y: 20, w: 258, h: 120 } },
};

/** A container narrower than this gets the push-in on screens (and a squarer frame). */
export const NARROW = 600;

/** The default background of a scene that names none. */
export const DEFAULT_BG = { desk: 'ice', message: 'sand', portrait: 'mint', screen: 'navy', duo: 'lilac', you: 'cobalt', black: 'night', diagram: 'ice', clip: 'night' };

/**
 * Every word a panel shows: what is said, the caption and the screen lines, a black card's title and
 * captions, and the captions of the diagram steps a diagram panel shows. This is what the reader has to take in.
 */
export function panelWords(panel) {
  let n = 0;
  for (const b of panel.bubbles ?? []) n += wordsIn(b.text);
  n += wordsIn(panel.caption);
  for (const l of panel.lines ?? []) n += wordsIn(l);
  n += wordsIn(panel.title);
  for (const c of panel.captions ?? []) n += wordsIn(c);
  if (panel.diagram) for (const st of diagramFor(panel.diagram)?.steps.slice(0, stepsShown(panel)) ?? []) n += wordsIn(st.caption);
  return n;
}

// ---------------------------------------------------------------------------
// Cleaning what the API sent
// ---------------------------------------------------------------------------

const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const castIds = new Set(CAST.map((c) => c.id));
/** Longest a cue phrase may be: it is a part of a voiceover. */
const CUE_MAX = 240;

/** Plain text or `{ text, cue }` as `{ text, cue? }`, or null when there is no usable text. */
function cuedOf(v, max) {
  if (typeof v === 'string') {
    const text = str(v, max);
    return text ? { text } : null;
  }
  if (!v || typeof v !== 'object') return null;
  const text = str(v.text, max);
  if (!text) return null;
  const cue = str(v.cue, CUE_MAX);
  return cue ? { text, cue } : { text };
}

/** A cast entry as the art takes it: the id alone (as ever), or `{ who, mood?, pose? }` when it has a known mood or pose. */
function castOf(c) {
  if (typeof c === 'string') return castIds.has(c) ? c : null;
  if (!c || typeof c !== 'object' || !castIds.has(c.who)) return null;
  const out = { who: c.who };
  if (MOODS.includes(c.mood)) out.mood = c.mood;
  if (POSES.includes(c.pose)) out.pose = c.pose;
  return out.mood || out.pose ? out : c.who;
}

/**
 * One panel as the player can trust it. Text stays plain strings (`caption`, `sfx`, `lines`, `captions`, bubble
 * `text`), exactly as before; a cue goes beside its text: `captionCue`, `sfxCue`, bubble `cue`, `lineCues` and
 * `captionCues` (index for index, null where a line has none; only present when there is a cue). `sound` is the
 * sfx's sting, `shot` the framing. A diagram panel's `diagram` must be in the library (else it cannot be drawn)
 * and its `steps` are normalised to one `{ cue? }` per step shown. A clip panel keeps its `clip` id when the
 * library has it; one it does not have still plays, its words over a plain dark panel (never a broken comic).
 */
function cleanPanel(p) {
  if (!p || typeof p !== 'object' || !Object.hasOwn(SCENES, p.scene)) return null;
  const rule = SCENES[p.scene];
  const seen = new Set();
  const cast = (Array.isArray(p.cast) ? p.cast : [])
    .map(castOf)
    .filter((c) => {
      if (!c || seen.has(castId(c))) return false;
      seen.add(castId(c));
      return true;
    })
    .slice(0, rule.maxCast || 0);
  const bubbles = (Array.isArray(p.bubbles) ? p.bubbles : [])
    .map((b) => {
      const text = b && typeof b === 'object' ? str(b.text, 150) : undefined;
      if (!text) return null;
      const out = { text };
      if (castIds.has(b.who)) out.who = b.who;
      if (BUBBLE_POSITIONS.includes(b.pos)) out.pos = b.pos;
      const cue = str(b.cue, CUE_MAX);
      if (cue) out.cue = cue;
      return out;
    })
    .filter(Boolean)
    .slice(0, 2);
  const lines = (Array.isArray(p.lines) ? p.lines : []).map((l) => cuedOf(l, 44)).filter(Boolean).slice(0, 6);
  const out = {
    scene: p.scene,
    cast,
    bg: BACKGROUNDS.includes(p.bg) ? p.bg : undefined,
    prop: PROPS.includes(p.prop) ? p.prop : 'none',
    bubbles,
  };
  const caption = cuedOf(p.caption, 100);
  if (caption) {
    out.caption = caption.text;
    if (caption.cue) out.captionCue = caption.cue;
  }
  const voiceover = str(p.voiceover, 240);
  if (voiceover) out.voiceover = voiceover;
  const sfx = cuedOf(p.sfx, 14);
  if (sfx) {
    out.sfx = sfx.text;
    if (sfx.cue) out.sfxCue = sfx.cue;
    if (STING_SOUNDS.includes(p.sfx.sound)) out.sound = p.sfx.sound;
  }
  if (lines.length) {
    out.lines = lines.map((l) => l.text);
    if (lines.some((l) => l.cue)) out.lineCues = lines.map((l) => l.cue ?? null);
  }
  if (SHOTS.includes(p.shot)) out.shot = p.shot;
  if (p.scene === 'black') {
    const title = str(p.title, 60);
    if (title) out.title = title;
    const captions = (Array.isArray(p.captions) ? p.captions : []).map((c) => cuedOf(c, 80)).filter(Boolean).slice(0, 5);
    if (captions.length) {
      out.captions = captions.map((c) => c.text);
      if (captions.some((c) => c.cue)) out.captionCues = captions.map((c) => c.cue ?? null);
    }
  }
  if (p.scene === 'diagram') {
    // A diagram the console does not have cannot be drawn.
    if (!diagramFor(p.diagram)) return null;
    out.diagram = p.diagram;
    const listed = Array.isArray(p.steps) ? p.steps : [];
    out.steps = Array.from({ length: stepsShown({ diagram: p.diagram, steps: listed }) }, (_, k) => {
      const cue = listed[k] && typeof listed[k] === 'object' ? str(listed[k].cue, CUE_MAX) : undefined;
      return cue ? { cue } : {};
    });
  }
  if (p.scene === 'clip' && clipFor(p.clip)) out.clip = p.clip;
  // A scene that needs people it does not have cannot be drawn.
  if (cast.length < rule.minCast) return null;
  return out;
}

/**
 * A comic as the player can trust it: `{ title, pages: [{ title?, panels }] }`
 * with unknown scenes, people and props dropped, or null when there is nothing
 * to play. The API has already validated the comic (src/labs/comic.ts); this is
 * the console not taking its word for it, so a malformed bundle degrades to the
 * text story instead of a broken page.
 */
export function cleanComic(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.title !== 'string' || !raw.title) return null;
  const rawPages = Array.isArray(raw.pages) ? raw.pages : Array.isArray(raw.panels) ? [{ panels: raw.panels }] : [];
  const pages = rawPages
    .slice(0, 6)
    .map((pg) => {
      if (!pg || typeof pg !== 'object') return null;
      const panels = (Array.isArray(pg.panels) ? pg.panels : []).map(cleanPanel).filter(Boolean).slice(0, 12);
      if (panels.length === 0) return null;
      const title = str(pg.title, 60);
      return title ? { title, panels } : { panels };
    })
    .filter(Boolean);
  return pages.length ? { title: raw.title.slice(0, 80), pages } : null;
}

/**
 * The transcript lines (the accessible equivalent of the stage), numbered across pages; a diagram panel reads its
 * diagram's title and steps, a clip panel first what its clip shows (the library's `alt`).
 */
export const transcriptOf = (comic) => comicPagesTranscript(comic.pages, diagramFor, clipFor);

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

/** A rectangle grown by `pad` on every side. */
const grow = (r, pad) => ({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad });
/** The middle of a rectangle `k` times smaller: what a camera `k` times closer frames. */
const zoomIn = (r, k) => ({ x: r.x + (r.w - r.w / k) / 2, y: r.y + (r.h - r.h / k) / 2, w: r.w / k, h: r.h / k });

/**
 * When a voiced panel's storyteller says `cue`: the clip's start plus the same fraction of the clip as the
 * phrase's place in the voiceover (its first character, or with `end` just after its last, for a bubble that
 * reacts to the words), clamped inside the clip. Null when the phrase is not in the voiceover.
 */
function cueTime(voiceover, cue, clip, end = false) {
  if (!voiceover || !cue) return null;
  const span = cueSpan(voiceover, cue);
  if (!span) return null;
  return clamp(clip.start + ((end ? span.end : span.start) / span.length) * clip.seconds, clip.start, clip.end);
}

/**
 * `n` moments spread evenly from `from` over `len` seconds, each moved to its cue's time when it has one
 * (`timeOf(k)`, null for none), kept in order with at least `gap` between one and the next (a later one is pushed).
 */
function spread(n, from, len, gap, timeOf) {
  const out = [];
  for (let k = 0; k < n; k++) {
    let at = timeOf(k) ?? from + (k * len) / n;
    if (k > 0) at = Math.max(at, out[k - 1] + gap);
    out.push(at);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Narration: which clip reads which line
// ---------------------------------------------------------------------------

const CLIP_KEY = /^[0-9a-f]{16}$/;
const AUDIO_SLUG = /^[a-z0-9][a-z0-9._-]{0,80}$/;

/** Who may speak a bubble's clip: the speaking cast (everybody active but the learner). */
const SPEAKERS = new Set(SPEAKING_CAST_IDS);

/**
 * The narration of a learn bundle (`learn.audio` plus the lab's `slug`) as the player can trust it:
 * `{ slug, clips: { key: { seconds, text, who? } }, lines: [{ panel, kind: 'voiceover' | 'bubble', bubble?, clip }] }`,
 * or null when it is not that. Clips with a bad key or length and lines that name a missing clip are dropped.
 * A `bubble` line (the cast's voices) needs a bubble number and a clip that says who speaks it (`who`, a person of
 * the speaking cast). The older caption-and-bubble narration (several voices, no `who`) is not played: a
 * `caption` line, or a `bubble` line whose clip names no speaker, makes the whole narration null, so a lab that
 * has not been re-narrated plays in silence rather than half-voiced.
 */
export function cleanAudio(raw) {
  if (!raw || typeof raw !== 'object' || !raw.clips || typeof raw.clips !== 'object' || !Array.isArray(raw.lines)) return null;
  if (typeof raw.slug !== 'string' || !AUDIO_SLUG.test(raw.slug)) return null;
  const clips = {};
  for (const [key, c] of Object.entries(raw.clips)) {
    const seconds = c && typeof c === 'object' ? Number(c.seconds) : NaN;
    if (CLIP_KEY.test(key) && seconds > 0.05 && seconds <= 70) {
      clips[key] = { seconds, text: typeof c.text === 'string' ? c.text : '' };
      if (typeof c.who === 'string' && (c.who === NARRATOR_ID || SPEAKERS.has(c.who))) clips[key].who = c.who;
    }
  }
  const lines = [];
  for (const l of raw.lines.slice(0, 120)) {
    if (!l || typeof l !== 'object') continue;
    if (l.kind === 'bubble') {
      // The old shape's bubble lines name no speaker: that narration is not played at all.
      if (Object.hasOwn(clips, l.clip) && !SPEAKERS.has(clips[l.clip].who)) return null;
      if (!Number.isInteger(l.panel) || l.panel < 0 || !Object.hasOwn(clips, l.clip) || !Number.isInteger(l.bubble) || l.bubble < 0) continue;
      lines.push({ panel: l.panel, kind: 'bubble', bubble: l.bubble, clip: l.clip });
      continue;
    }
    if (l.kind !== 'voiceover') return null;
    if (!Number.isInteger(l.panel) || l.panel < 0 || !Object.hasOwn(clips, l.clip)) continue;
    lines.push({ panel: l.panel, kind: 'voiceover', clip: l.clip });
  }
  return lines.length ? { slug: raw.slug, clips, lines } : null;
}

/**
 * Narration matched to a cleaned comic: `{ voiceovers, bubbles }`, `voiceovers` a Map from the panel's global
 * index (from 0) to its voiceover clip `{ key, seconds }`, and `bubbles` (null when the narration voices no
 * bubble) a Map from the panel's index to an array, one entry per bubble of the panel, of its clip
 * `{ key, seconds, who }` or null for a bubble nobody voices (the learner's, or one with no speaker). Null when
 * there is no narration or anything does not match the comic: a line for a panel that has no voiceover, words
 * that are not the clip's words, a bubble whose speaker is not the clip's, a panel or a bubble twice, a
 * voiceover with no clip, or (once any bubble is voiced) a bubble of a speaking person with no clip. A voice
 * must never say something other than what the story says, and a story must never be half voiced, so any
 * mismatch turns the whole narration off.
 */
function resolveNarration(comic, rawAudio) {
  const audio = cleanAudio(rawAudio);
  if (!audio) return null;
  const panels = comic.pages.flatMap((pg) => pg.panels);
  const voiceovers = new Map();
  const bubbles = new Map();
  for (const l of audio.lines) {
    const panel = panels[l.panel];
    const clip = audio.clips[l.clip];
    if (l.kind === 'bubble') {
      const b = panel?.bubbles?.[l.bubble];
      if (!b || !SPEAKERS.has(b.who) || clip.who !== b.who || (clip.text && clip.text !== b.text)) return null;
      const row = bubbles.get(l.panel) ?? panel.bubbles.map(() => null);
      if (row[l.bubble]) return null;
      row[l.bubble] = { key: l.clip, seconds: clip.seconds, who: b.who };
      bubbles.set(l.panel, row);
      continue;
    }
    if (!panel || !panel.voiceover) return null;
    if ((clip.text && clip.text !== panel.voiceover) || voiceovers.has(l.panel) || (clip.who && clip.who !== NARRATOR_ID)) return null;
    voiceovers.set(l.panel, { key: l.clip, seconds: clip.seconds });
  }
  for (let i = 0; i < panels.length; i++) if (panels[i].voiceover && !voiceovers.has(i)) return null;
  if (bubbles.size > 0) {
    for (let i = 0; i < panels.length; i++) {
      const row = bubbles.get(i);
      if ((panels[i].bubbles ?? []).some((b, k) => SPEAKERS.has(b.who) && !row?.[k])) return null;
    }
  }
  return { voiceovers, bubbles: bubbles.size > 0 ? bubbles : null };
}

/**
 * When a voiced panel is spoken, from `pStart` (the panel's first moment): the storyteller's clip starts
 * TIMING.voice in. The panel's bubbles are text only: the first starts typing TIMING.bubbleLag after the
 * clip starts and the rest follow one after the other, at the reading pace (TIMING.word per word),
 * clamped so the last is finished by TIMING.bubbleTail after the clip ends; if there are more words than
 * fit they type faster (never slower than the reading pace). A bubble with a `cue` pops just after the
 * voiceover has said its phrase instead (still after the bubble before it, and the gap). Returns
 * `{ clip, need, bubbles }` (`need` is how long the panel must last, from its start), times in seconds on the clock.
 */
function voicedPanel(panel, voiced, pStart) {
  const start = pStart + TIMING.voice;
  const clip = { key: voiced.key, kind: 'voiceover', bubble: null, start, end: start + voiced.seconds, seconds: voiced.seconds };
  const bubbles = panel.bubbles ?? [];
  const spoken = bubbles.reduce((n, b) => n + wordsIn(b.text), 0);
  const first = start + TIMING.bubbleLag;
  const room = clip.end + TIMING.bubbleTail - first - bubbles.length * TIMING.bubblePop - Math.max(0, bubbles.length - 1) * TIMING.bubbleGap;
  const step = spoken > 0 ? clamp(room / spoken, 0.03, TIMING.word) : TIMING.word;
  let cursor = first;
  let prevEnd = null;
  let late = 0;
  const timed = bubbles.map((b) => {
    const n = wordsIn(b.text);
    // A cued bubble pops once its phrase has been said (never before the one before it is done and the gap has passed).
    const want = b.cue ? cueTime(panel.voiceover, b.cue, clip, true) : null;
    const bStart = want === null ? cursor : Math.max(want, prevEnd === null ? clip.start : cursor);
    const wordTimes = Array.from({ length: n }, (_, k) => bStart + TIMING.bubblePop + k * step);
    const bEnd = bStart + TIMING.bubblePop + n * step;
    cursor = bEnd + TIMING.bubbleGap;
    prevEnd = bEnd;
    late = Math.max(late, bEnd);
    return { start: bStart, end: bEnd, step, wordTimes };
  });
  // The panel lasts until the voice is done and the hold has passed. Only when the bubbles could not be fitted
  // within TIMING.bubbleTail of the clip's end (a great many words, typed at the fastest pace) does it wait for them too.
  const tail = Math.max(TIMING.hold, TIMING.breath - TIMING.voice);
  const need = Math.max(clip.end - pStart + tail, late > clip.end + TIMING.bubbleTail + 1e-9 ? late - pStart + TIMING.hold : 0);
  return { clip, clips: [clip], need, bubbles: timed };
}

/**
 * A panel spoken by the cast (the narration voices bubbles, and this panel has a bubble clip), from `pStart`: one
 * clip after another, never two at once. The storyteller's clip first (when the panel has a voiceover), starting
 * TIMING.voice in as on any voiced panel; then each bubble in the panel's order, TIMING.speakerGap after the clip
 * before it ends (the first one TIMING.voice in when there is no voiceover). A voiced bubble pops when its clip
 * starts and types its words over the clip (at the reading pace or faster, so the text is never behind the voice),
 * and its speaker talks until the clip ends; its `cue` is not used (the clip times it). A bubble nobody voices (the
 * learner's) takes its turn in the same order, typed at the reading pace. The panel lasts until the last clip (or
 * bubble) is done and the usual hold has passed. Returns `{ clip, clips, need, bubbles }` like voicedPanel: `clip`
 * the voiceover's clip or null, `clips` every clip of the panel in order (bubble clips `{ kind: 'bubble', bubble, who }`).
 */
function castPanel(panel, voiced, row, pStart) {
  const clips = [];
  let at = pStart + TIMING.voice;
  let clip = null;
  if (voiced) {
    clip = { key: voiced.key, kind: 'voiceover', bubble: null, start: at, end: at + voiced.seconds, seconds: voiced.seconds };
    clips.push(clip);
    at = clip.end + TIMING.speakerGap;
  }
  let last = clip ? clip.end : pStart;
  const timed = (panel.bubbles ?? []).map((b, i) => {
    const n = wordsIn(b.text);
    const said = row[i];
    const start = at;
    if (said) {
      const c = { key: said.key, kind: 'bubble', bubble: i, who: said.who, start, end: start + said.seconds, seconds: said.seconds };
      clips.push(c);
      const step = n > 0 ? clamp((said.seconds - TIMING.bubblePop) / n, 0.03, TIMING.word) : TIMING.word;
      const wordTimes = Array.from({ length: n }, (_, k) => start + TIMING.bubblePop + k * step);
      const end = Math.max(start + TIMING.bubblePop + n * step, c.end);
      at = c.end + TIMING.speakerGap;
      last = Math.max(last, end);
      return { start, end, step, wordTimes };
    }
    const wordTimes = Array.from({ length: n }, (_, k) => start + TIMING.bubblePop + k * TIMING.word);
    const end = start + TIMING.bubblePop + n * TIMING.word;
    at = end + TIMING.speakerGap;
    last = Math.max(last, end);
    return { start, end, step: TIMING.word, wordTimes };
  });
  const tail = Math.max(TIMING.hold, TIMING.breath - TIMING.voice);
  return { clip, clips, need: last - pStart + tail, bubbles: timed };
}

/**
 * The schedule of a comic.
 *
 * With `{ audio }` (the lab's narration, see cleanAudio) every panel with a voiceover gets its start and end
 * from its clip and is as long as the voice needs (the larger of what it takes to read everything the
 * panel shows and the clip's end plus TIMING.hold); with the cast's voices a panel's spoken bubbles follow its
 * voiceover clip by clip (castPanel); without it, or when the narration does not match the comic, the schedule
 * is the same as ever and `audio` is empty.
 *
 * Returns
 *   total     seconds from the first frame to the finished comic
 *   parts     { lead, turns, titles, panels, outro } which add up to `total`;
 *             `panels` is the sum of panelSeconds() over every panel
 *   reel      { w, h } of the whole comic
 *   pages     [{ index, title, start, end, panelsStart, sheet, banner, body, panels }]
 *   shots     the camera's moves: { t, dur, rect, kind }, in time order
 *   outro     { start, end } the pull-back at the end
 *   audio     the clips in start order: { key, kind: 'voiceover', bubble: null, panel (number), start, end, seconds } (empty without
 *             narration), one per voiced panel; with the cast's voices also { key, kind: 'bubble', bubble, who, panel, start, end,
 *             seconds } per spoken bubble, after its panel's voiceover; one after another, so never two at once
 *   stings    the sound effects that make a sound, in time order: { panel (number), sound, at } (at is the sfx's sfxAt)
 *   clips     the clip panels' clips (packages/catalogue/clips.json), in time order: { panel (number), id, start, end },
 *             the panel's own start and end (a clip plays while its panel is on; it never changes the panel's length)
 *
 * and for each panel: start, end, dur, words, rect (its place on the reel),
 * popAt, captionAt, sfxAt, focusAt (when a narrow container's camera pushes in on its screen, or null),
 * bubbles [{ who, pos, start, end, step, wordTimes }], lines [{ start, end }], shot ('close', 'wide' or null),
 * stack (when each caption of a black card appears), stepTimes (when each shown step of a diagram starts) and clip
 * ({ id, kind, loop, seconds?, start, end } for a clip panel whose clip the library has, else null; see clipTimeAt).
 * Every rectangle is in page units.
 *
 * Cues (a voiced panel's caption, sfx, bubbles, screen lines, black-card captions and diagram steps) move a
 * part to the moment the storyteller says its phrase (cueTime); without narration they change nothing.
 * Shots: `close` adds a push-in (kind 'close', CLOSE_ZOOM times closer) once the camera has arrived; `wide`
 * frames the panel's whole row instead of the panel.
 */
export function buildTimeline(comic, { audio } = {}) {
  const narration = resolveNarration(comic, audio);
  const voices = [];
  const stings = [];
  const media = [];
  const pages = [];
  const shots = [];
  const parts = { lead: 0, turns: 0, titles: 0, panels: 0, outro: TIMING.outro };
  const M = REEL.margin;
  const P = REEL.paper;
  const sheetW = PAGE_W + 2 * P;
  let t = 0;
  let y = M;
  let number = 0;

  comic.pages.forEach((pg, pi) => {
    const titled = Boolean(pg.title);
    const bannerH = titled ? REEL.banner : 0;
    const laid = layoutComic(pg.panels);
    const sheet = { x: M, y, w: sheetW, h: P + bannerH + laid.height + P };
    const banner = titled ? { x: M + P, y: y + P, w: PAGE_W, h: REEL.banner - 14 } : null;
    const body = { x: M + P, y: y + P + bannerH, w: PAGE_W, h: laid.height };

    const start = t;
    const travel = pi === 0 ? TIMING.lead : TIMING.turn;
    if (pi === 0) parts.lead += travel;
    else parts.turns += travel;
    if (titled) parts.titles += TIMING.title;
    const target = titled ? grow(banner, REEL.shotPad) : grow(sheet, 0);
    // The first page is already framed when the comic starts; the others are flown to.
    shots.push({ t: start, dur: pi === 0 ? 0 : travel, rect: target, kind: pi === 0 ? 'establish' : 'turn' });
    t += travel + (titled ? TIMING.title : 0);
    const panelsStart = t;

    const panels = pg.panels.map((panel, i) => {
      const place = laid.placements[i];
      const rect = { x: body.x + place.x, y: body.y + place.y, w: place.w, h: place.h };
      const words = panelWords(panel);
      const pStart = t;
      number += 1;
      const bubbles = panel.bubbles ?? [];

      // With narration the storyteller sets the pace: the panel stays until its voiceover is done and the
      // usual hold after it (the silence before the next panel's voiceover is that hold plus TIMING.voice,
      // never less than TIMING.breath), and never less than reading everything it shows takes.
      // With the cast's voices a panel with a bubble clip is spoken clip after clip (castPanel); any other voiced panel as ever.
      const voiced = narration?.voiceovers.get(number - 1);
      const row = narration?.bubbles?.get(number - 1);
      const said = row && row.some(Boolean) ? castPanel(panel, voiced, row, pStart) : voiced ? voicedPanel(panel, voiced, pStart) : null;
      let dur = said ? Math.max(panelSeconds(words), said.need) : panelSeconds(words);
      // Cues time a voiced panel's parts to the storyteller's words; a panel nobody voices ignores them.
      const cueAt = (cue) => (said?.clip && cue ? cueTime(panel.voiceover, cue, said.clip) : null);

      // Bubbles speak one after the other; the typing pace eases off if a long panel hits the cap.
      const spoken = bubbles.reduce((n, b) => n + wordsIn(b.text), 0);
      const avail = dur - TIMING.content - TIMING.hold - bubbles.length * TIMING.bubblePop - Math.max(0, bubbles.length - 1) * TIMING.bubbleGap;
      const step = spoken > 0 ? clamp(avail / spoken, 0.03, TIMING.word) : TIMING.word;
      let cursor = pStart + TIMING.content;
      const timed = said
        ? said.bubbles.map((b, i) => ({ who: bubbles[i].who, pos: bubbles[i].pos, ...b }))
        : bubbles.map((b) => {
            const bStart = cursor;
            const n = wordsIn(b.text);
            const wordTimes = Array.from({ length: n }, (_, k) => bStart + TIMING.bubblePop + k * step);
            const bEnd = bStart + TIMING.bubblePop + n * step;
            cursor = bEnd + TIMING.bubbleGap;
            return { who: b.who, pos: b.pos, start: bStart, end: bEnd, step, wordTimes };
          });
      if (said) for (const c of said.clips) voices.push({ ...c, panel: number });

      // Screen lines type one after the other, as quickly as the panel's time allows; a cued line starts on its
      // phrase, and a line never starts before the one above it is typed (a later one is pushed).
      const lines = panel.lines ?? [];
      const lineStep = lines.length ? Math.min(TIMING.line, (dur - TIMING.content - TIMING.hold) / lines.length) : 0;
      let lineFree = -Infinity;
      const timedLines = lines.map((_, k) => {
        const s = Math.max(cueAt(panel.lineCues?.[k]) ?? pStart + TIMING.content + k * lineStep, lineFree);
        lineFree = s + lineStep * 0.8;
        return { start: s, end: s + lineStep * 0.8 };
      });

      // A black card's captions appear one by one, and a diagram's steps follow one another: on their cues, or
      // spread evenly over the voiceover's clip (unvoiced: over the panel's reading time).
      const spanFrom = said?.clip ? said.clip.start : pStart + TIMING.content;
      const spanLen = said?.clip ? said.clip.seconds : dur - TIMING.content - TIMING.hold;
      const stack = spread(panel.captions?.length ?? 0, spanFrom, spanLen, TIMING.stackGap, (k) => cueAt(panel.captionCues?.[k]));
      const stepTimes = spread(panel.steps?.length ?? 0, spanFrom, spanLen, TIMING.stepGap, (k) => cueAt(panel.steps[k].cue));
      // Something pushed past the clip by the ones before it keeps the panel up until it, and the hold, are done.
      if (said) {
        const late = Math.max(-Infinity, ...timedLines.map((l) => l.end), ...stack, ...stepTimes);
        if (late > pStart + dur - TIMING.hold + 1e-9) dur = late - pStart + TIMING.hold;
      }

      // The camera: the panel, or with `shot: wide` its whole row; with `shot: close` it then pushes in.
      const framed = panel.shot === 'wide' ? { x: body.x, y: rect.y, w: body.w, h: rect.h } : rect;
      shots.push({ t: pStart, dur: TIMING.move, rect: grow(framed, REEL.shotPad), kind: 'panel' });
      if (panel.shot === 'close') shots.push({ t: pStart + TIMING.move, dur: TIMING.move, rect: zoomIn(grow(rect, REEL.shotPad), CLOSE_ZOOM), kind: 'close' });
      // A screen is too small to read from the whole panel in a narrow container: once what is said has been said,
      // the camera moves in on it (only there: a wide stage does not need it, and never plays this shot).
      const screen = SCREENS[panel.scene];
      let focusAt = null;
      if (screen && lines.length) {
        const after = timed.length ? timed[timed.length - 1].end + 0.3 : pStart + TIMING.content;
        const settled = pStart + TIMING.move * (panel.shot === 'close' ? 2 : 1) + 0.2;
        const at = Math.min(Math.max(after, settled), pStart + dur - TIMING.hold - 0.6);
        const d = screen.device;
        focusAt = at;
        shots.push({ t: at, dur: 0.7, rect: grow({ x: rect.x + 4 + d.x, y: rect.y + 4 + d.y, w: d.w, h: d.h }, 8), kind: 'screen', narrowOnly: true });
      }
      const sfxAt = panel.sfx ? (cueAt(panel.sfxCue) ?? pStart + TIMING.sfx) : null;
      if (sfxAt !== null && panel.sound) stings.push({ panel: number, sound: panel.sound, at: sfxAt });
      // A clip plays while its panel is on: from the panel's first moment to its last (the panel is timed as ever).
      const lib = panel.clip ? clipFor(panel.clip) : undefined;
      const clip = lib ? { id: lib.id, kind: lib.kind, loop: lib.loop, ...(lib.seconds ? { seconds: lib.seconds } : {}), start: pStart, end: pStart + dur } : null;
      if (clip) media.push({ panel: number, id: clip.id, start: clip.start, end: clip.end });
      t += dur;
      parts.panels += dur;
      return {
        index: i,
        number,
        page: pi,
        scene: panel.scene,
        start: pStart,
        end: pStart + dur,
        dur,
        words,
        rect,
        popAt: pStart + TIMING.pop,
        captionAt: panel.caption ? (cueAt(panel.captionCue) ?? pStart + TIMING.caption) : null,
        sfxAt,
        bubbles: timed,
        lines: timedLines,
        focusAt,
        shot: panel.shot ?? null,
        stack,
        stepTimes,
        clip,
      };
    });

    pages.push({ index: pi, title: pg.title ?? null, start, end: t, panelsStart, sheet, banner, body, panels });
    y += sheet.h + REEL.gap;
  });

  const reel = { w: sheetW + 2 * M, h: y - REEL.gap + M };
  const outro = { start: t, end: t + TIMING.outro };
  shots.push({ t: outro.start, dur: TIMING.outro, rect: { x: 0, y: 0, w: reel.w, h: reel.h }, kind: 'outro' });
  voices.sort((a, b) => a.start - b.start);
  stings.sort((a, b) => a.at - b.at);
  return { total: outro.end, parts, reel, pages, shots, outro, audio: voices, stings, clips: media };
}

/** Every panel of a timeline in reading order. */
export const panelsOf = (tl) => tl.pages.flatMap((p) => p.panels);

// ---------------------------------------------------------------------------
// What is showing at time t
// ---------------------------------------------------------------------------

/**
 * One panel at time t: which of its parts have appeared. All booleans and
 * counts, so the player only has to flip classes; and at the end of the
 * comic (t >= total) everything is on.
 */
export function panelState(panel, t) {
  return {
    on: t >= panel.popAt,
    active: t >= panel.start && t < panel.end,
    caption: panel.captionAt !== null && t >= panel.captionAt,
    sfx: panel.sfxAt !== null && t >= panel.sfxAt,
    shake: panel.sfxAt !== null && t >= panel.sfxAt && t < panel.sfxAt + TIMING.shake,
    bubbles: panel.bubbles.map((b) => ({
      on: t >= b.start,
      words: b.wordTimes.reduce((n, wt) => n + (t >= wt ? 1 : 0), 0),
      speaking: t >= b.start + TIMING.bubblePop && t < b.end + 0.1,
    })),
    lines: panel.lines.map((l) => clamp((t - l.start) / (l.end - l.start || 1), 0, 1)),
    stack: (panel.stack ?? []).map((at) => t >= at),
    step: diagramStep(panel, t),
  };
}

/** The step of a diagram panel's diagram showing at time t: -1 before its first (the diagram alone), then 0, 1, ...; -1 for any other panel. */
export function diagramStep(panel, t) {
  let step = -1;
  for (const at of panel.stepTimes ?? []) if (t >= at) step += 1;
  return step;
}

/** A page's title banner shows once the camera is on its way to it. */
export const bannerOn = (page, t) => t >= page.start + (page.index === 0 ? 0 : TIMING.turn * 0.35);

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

/** The frame's shape for a container this wide: wide and short on a big screen, squarer in a narrow one. */
export function playAspect(width) {
  if (width >= 900) return 16 / 9;
  if (width >= NARROW) return 4 / 3;
  return 1;
}

/** The camera that frames `rect` in a viewport `{ w, h }`: its centre on the reel and its zoom. */
export function cameraFor(rect, vp) {
  const k = Math.min(vp.w / rect.w, vp.h / rect.h);
  return { cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, k };
}

/** The CSS transform (origin at the top left) that puts the camera's centre in the middle of the viewport. */
export function cameraTransform(cam, vp) {
  const tx = vp.w / 2 - cam.k * cam.cx;
  const ty = vp.h / 2 - cam.k * cam.cy;
  return `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${cam.k.toFixed(5)})`;
}

export const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

function mixCamera(a, b, p) {
  return { cx: a.cx + (b.cx - a.cx) * p, cy: a.cy + (b.cy - a.cy) * p, k: Math.exp(Math.log(a.k) + (Math.log(b.k) - Math.log(a.k)) * p) };
}

/** The viewport at time t: `width` wide, as tall as the playing frame, easing to the whole comic's height at the end. */
export function viewportAt(tl, t, width) {
  const play = width / playAspect(width);
  const whole = tl.reel.h * (width / tl.reel.w);
  const p = clamp((t - tl.outro.start) / TIMING.outro, 0, 1);
  return { w: width, h: play + (whole - play) * easeInOut(p) };
}

/** The shots a viewport plays: all of them in a narrow one, all but the push-ins on screens in a wide one. */
const shotsFor = (tl, vp) => (vp.w < NARROW ? tl.shots : tl.shots.filter((s) => !s.narrowOnly));

/** The shot that is current at t, and the one before it. */
function shotsAt(tl, t, vp) {
  const shots = shotsFor(tl, vp);
  let i = 0;
  for (let k = 0; k < shots.length; k++) if (shots[k].t <= t) i = k;
  return { shot: shots[i], prev: shots[i - 1] ?? null };
}

/** The camera at time t in a viewport `vp` (see viewportAt): it eases from the previous shot to the current one. */
export function cameraAt(tl, t, vp) {
  const { shot, prev } = shotsAt(tl, t, vp);
  const to = cameraFor(shot.rect, vp);
  if (!prev || shot.dur <= 0) return to;
  const p = easeInOut(clamp((t - shot.t) / shot.dur, 0, 1));
  return p >= 1 ? to : mixCamera(cameraFor(prev.rect, vp), to, p);
}

/**
 * How much bigger than designed the words of a panel are drawn, so that they
 * are `minPx` tall on screen when the camera frames the panel in a narrow
 * container. 1 on a wide stage; up to `max` in a narrow one.
 */
export function textScale(panelRect, vp, { minPx = 13, basePx = 15, max = 1.9 } = {}) {
  const k = cameraFor(grow(panelRect, REEL.shotPad), vp).k;
  return clamp(minPx / (basePx * k), 1, max);
}

// ---------------------------------------------------------------------------
// The clock behind Replay and Skip
// ---------------------------------------------------------------------------

/**
 * The player's whole state: the time and whether it is still playing.
 * `reduced` (prefers-reduced-motion) starts finished: every page drawn, no
 * camera, nothing typing.
 */
export function initialClock(tl, { reduced = false } = {}) {
  return reduced ? { t: tl.total, status: 'done' } : { t: 0, status: 'playing' };
}

/** Actions: { type: 'tick', dt }, { type: 'replay' }, { type: 'skip' }, { type: 'seek', t }. */
export function clockReduce(state, action, total) {
  switch (action.type) {
    case 'tick': {
      if (state.status === 'done') return state;
      const dt = clamp(Number(action.dt) || 0, 0, MAX_STEP);
      const t = Math.min(total, state.t + dt);
      return t >= total ? { t: total, status: 'done' } : { t, status: 'playing' };
    }
    case 'skip':
      return state.status === 'done' ? state : { t: total, status: 'done' };
    case 'replay':
      return { t: 0, status: 'playing' };
    case 'seek': {
      const t = clamp(Number(action.t) || 0, 0, total);
      return t >= total ? { t: total, status: 'done' } : { t, status: 'playing' };
    }
    default:
      return state;
  }
}

/** Whether `next` is the moment playback finished (the one time onDone is called). */
export const justFinished = (prev, next) => prev.status !== 'done' && next.status === 'done';

/** "m:ss". */
export function mmss(seconds, round = Math.floor) {
  const n = Math.max(0, round(Number(seconds) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
