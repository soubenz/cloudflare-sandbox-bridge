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
  PAGE_W,
  PROPS,
  SCENES,
  comicPagesTranscript,
  layoutComic,
  panelSeconds,
} from '../../src/labs/comic-kit.ts';

// ---------------------------------------------------------------------------
// The beats, in seconds
// ---------------------------------------------------------------------------

export const TIMING = {
  /** A beat on the first page before the camera moves in. */
  lead: 0.8,
  /** The camera travelling to the next page. */
  turn: 1.4,
  /** A page's title card, held after the camera has flown to it. */
  title: 1.6,
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
  word: 0.14,
  /** The panel stays this long after its last word, so it can be read. */
  hold: 1.0,
  /** Slowest a screen line may type, and the shortest. */
  line: 0.75,
  /** Pulling back to the whole comic at the end. */
  outro: 1.8,
  /** The shake that goes with a sound effect. */
  shake: 0.55,
};

/** The reel's geometry, in the units of the page (comic-kit's PAGE). */
export const REEL = { margin: 30, paper: 14, gap: 56, banner: 74, shotPad: 28 };

/** Longest the clock may advance in one frame, so a background tab or a hiccup never skips the comic ahead. */
export const MAX_STEP = 0.25;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wordsIn = (s) => (typeof s === 'string' ? s.split(/\s+/).filter(Boolean).length : 0);

/**
 * Where a scene's screen is, in the panel's own units: `lines` is the box the typed
 * text fills, `device` the monitor or laptop round it. The art draws to these (comic-art.js)
 * and, in a narrow container, the camera pushes in on `device` so the text can be read.
 */
export const SCREENS = {
  desk: { lines: { x: 352, y: 150, w: 294, h: 84 }, device: { x: 330, y: 132, w: 338, h: 118 } },
  screen: { lines: { x: 78, y: 54, w: 541, h: 170 }, device: { x: 48, y: 26, w: 601, h: 226 } },
  you: { lines: { x: 46, y: 184, w: 372, h: 104 }, device: { x: 20, y: 164, w: 424, h: 140 } },
};

/** A container narrower than this gets the push-in on screens (and a squarer frame). */
export const NARROW = 600;

/** The default background of a scene that names none. */
export const DEFAULT_BG = { desk: 'ice', message: 'sand', portrait: 'mint', screen: 'navy', duo: 'lilac', you: 'cobalt' };

/** Every word a panel shows: what is said, the caption and the screen lines. This is what the reader has to take in. */
export function panelWords(panel) {
  let n = 0;
  for (const b of panel.bubbles ?? []) n += wordsIn(b.text);
  n += wordsIn(panel.caption);
  for (const l of panel.lines ?? []) n += wordsIn(l);
  return n;
}

// ---------------------------------------------------------------------------
// Cleaning what the API sent
// ---------------------------------------------------------------------------

const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const castIds = new Set(CAST.map((c) => c.id));

function cleanPanel(p) {
  if (!p || typeof p !== 'object' || !Object.hasOwn(SCENES, p.scene)) return null;
  const rule = SCENES[p.scene];
  const cast = [...new Set((Array.isArray(p.cast) ? p.cast : []).filter((c) => castIds.has(c)))].slice(0, rule.maxCast || 0);
  const bubbles = (Array.isArray(p.bubbles) ? p.bubbles : [])
    .map((b) => {
      const text = b && typeof b === 'object' ? str(b.text, 150) : undefined;
      if (!text) return null;
      const out = { text };
      if (castIds.has(b.who)) out.who = b.who;
      if (BUBBLE_POSITIONS.includes(b.pos)) out.pos = b.pos;
      return out;
    })
    .filter(Boolean)
    .slice(0, 2);
  const lines = (Array.isArray(p.lines) ? p.lines : []).map((l) => str(l, 44)).filter(Boolean).slice(0, 6);
  const out = {
    scene: p.scene,
    cast,
    bg: BACKGROUNDS.includes(p.bg) ? p.bg : undefined,
    prop: PROPS.includes(p.prop) ? p.prop : 'none',
    bubbles,
  };
  const caption = str(p.caption, 100);
  if (caption) out.caption = caption;
  const sfx = str(p.sfx, 14);
  if (sfx) out.sfx = sfx;
  if (lines.length) out.lines = lines;
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
      const panels = (Array.isArray(pg.panels) ? pg.panels : []).map(cleanPanel).filter(Boolean).slice(0, 9);
      if (panels.length === 0) return null;
      const title = str(pg.title, 60);
      return title ? { title, panels } : { panels };
    })
    .filter(Boolean);
  return pages.length ? { title: raw.title.slice(0, 80), pages } : null;
}

/** The transcript lines (the accessible equivalent of the stage), numbered across pages. */
export const transcriptOf = (comic) => comicPagesTranscript(comic.pages);

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

/** A rectangle grown by `pad` on every side. */
const grow = (r, pad) => ({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad });

/**
 * The schedule of a comic.
 *
 * Returns
 *   total     seconds from the first frame to the finished comic
 *   parts     { lead, turns, titles, panels, outro } which add up to `total`;
 *             `panels` is the sum of panelSeconds() over every panel
 *   reel      { w, h } of the whole comic
 *   pages     [{ index, title, start, end, panelsStart, sheet, banner, body, panels }]
 *   shots     the camera's moves: { t, dur, rect, kind }, in time order
 *   outro     { start, end } the pull-back at the end
 *
 * and for each panel: start, end, dur, words, rect (its place on the reel),
 * popAt, captionAt, sfxAt, focusAt (when a narrow container's camera pushes in on its screen, or null),
 * bubbles [{ who, pos, start, end, step, wordTimes }] and lines [{ start, end }]. Every rectangle is in page units.
 */
export function buildTimeline(comic) {
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
      const dur = panelSeconds(words);
      const pStart = t;
      number += 1;

      // Bubbles speak one after the other; the typing pace eases off if a long panel hits the cap.
      const bubbles = panel.bubbles ?? [];
      const spoken = bubbles.reduce((n, b) => n + wordsIn(b.text), 0);
      const avail = dur - TIMING.content - TIMING.hold - bubbles.length * TIMING.bubblePop - Math.max(0, bubbles.length - 1) * TIMING.bubbleGap;
      const step = spoken > 0 ? clamp(avail / spoken, 0.03, TIMING.word) : TIMING.word;
      let cursor = pStart + TIMING.content;
      const timed = bubbles.map((b) => {
        const bStart = cursor;
        const n = wordsIn(b.text);
        const wordTimes = Array.from({ length: n }, (_, k) => bStart + TIMING.bubblePop + k * step);
        const bEnd = bStart + TIMING.bubblePop + n * step;
        cursor = bEnd + TIMING.bubbleGap;
        return { who: b.who, pos: b.pos, start: bStart, end: bEnd, step, wordTimes };
      });

      // Screen lines type one after the other, as quickly as the panel's time allows.
      const lines = panel.lines ?? [];
      const lineStep = lines.length ? Math.min(TIMING.line, (dur - TIMING.content - TIMING.hold) / lines.length) : 0;
      const timedLines = lines.map((_, k) => {
        const s = pStart + TIMING.content + k * lineStep;
        return { start: s, end: s + lineStep * 0.8 };
      });

      shots.push({ t: pStart, dur: TIMING.move, rect: grow(rect, REEL.shotPad), kind: 'panel' });
      // A screen is too small to read from the whole panel in a narrow container: once what is said has been said,
      // the camera moves in on it (only there: a wide stage does not need it, and never plays this shot).
      const screen = SCREENS[panel.scene];
      let focusAt = null;
      if (screen && lines.length) {
        const after = timed.length ? timed[timed.length - 1].end + 0.3 : pStart + TIMING.content;
        const at = Math.min(Math.max(after, pStart + TIMING.move + 0.2), pStart + dur - TIMING.hold - 0.6);
        const d = screen.device;
        focusAt = at;
        shots.push({ t: at, dur: 0.7, rect: grow({ x: rect.x + 4 + d.x, y: rect.y + 4 + d.y, w: d.w, h: d.h }, 8), kind: 'screen', narrowOnly: true });
      }
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
        captionAt: panel.caption ? pStart + TIMING.caption : null,
        sfxAt: panel.sfx ? pStart + TIMING.sfx : null,
        bubbles: timed,
        lines: timedLines,
        focusAt,
      };
    });

    pages.push({ index: pi, title: pg.title ?? null, start, end: t, panelsStart, sheet, banner, body, panels });
    y += sheet.h + REEL.gap;
  });

  const reel = { w: sheetW + 2 * M, h: y - REEL.gap + M };
  const outro = { start: t, end: t + TIMING.outro };
  shots.push({ t: outro.start, dur: TIMING.outro, rect: { x: 0, y: 0, w: reel.w, h: reel.h }, kind: 'outro' });
  return { total: outro.end, parts, reel, pages, shots, outro };
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
  };
}

/** A page's title banner shows once the camera is on its way to it. */
export const bannerOn = (page, t) => t >= page.start + (page.index === 0 ? 0 : TIMING.turn * 0.35);

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

/** The frame's shape for a container this wide: wide and short on a big screen, squarer in a narrow guide. */
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
