/**
 * The motion comic player.
 *
 *   const comic = mountComic(container, learn.comic, { onDone })
 *   comic.destroy()
 *
 * Draws every page of the comic as a sheet on one reel, then plays it like a
 * video: a camera moves down the reel and zooms into each panel as it pops in,
 * bubbles type word by word, screen lines type line by line, captions fade in,
 * a sound effect slams in with a shake, the camera flies to the next page, and
 * at the end it pulls back until the whole comic is in frame.
 *
 * ONE clock drives all of it. requestAnimationFrame advances a single number
 * (comic-timeline.js has the schedule and the pure functions of it); each
 * frame this file turns that number into a camera transform, a frame height and
 * a handful of class flips. Nothing else keeps time, so Replay and Skip are
 * exact, the timecode is honest, and the clock stops itself at the end.
 * (CSS only eases a class flip, and the ambient loops of the art; both are
 * switched off for reduced motion, for a finished comic and for the test clock.)
 *
 * Three playback buttons: Pause, Replay and Skip. Pause stops the clock and the voice where they
 * are and turns into Play, which carries on from the same moment (the voice resumes mid-sentence);
 * it is disabled once the comic has finished. Skip goes to the finished comic and
 * calls onDone; Replay starts again from page 1 (and un-pauses). With prefers-reduced-motion
 * the comic starts finished (every page drawn, no camera, nothing typing).
 *
 * Narration (`{ audio }`, the lab's learn.audio plus its slug): when the lab has a storyteller
 * the same clock plays her. One narrator clip per voiced panel (its `voiceover`; speech bubbles are
 * text only and never voiced) starts when the clock reaches its start (the timeline already sized the
 * panel to its clip) and stops on Skip, Replay, a hidden tab, the Sound toggle and destroy; exactly one
 * clip plays at a time (comic-audio.js is the pure logic). A clip that cannot load is skipped in silence. If the browser refuses to start
 * sound before the learner has tapped anything, a small "Tap to turn the sound on" button
 * appears in the frame. The one other control, beside Replay and Skip and only on a comic
 * that has a storyteller, is the Sound on/off toggle (kept in localStorage `opalix.comicSound`,
 * on by default): browsers need a way to turn sound off. Captions, bubbles and the
 * transcript are always there, so nothing depends on hearing.
 * The stage is role="img" with the title; "Read as text" under it is the
 * accessible equivalent (the same transcript the CLI checks).
 *
 * The animated parts are aria-hidden, so a screen reader hears the title and
 * the transcript and nothing chatters. The clock only runs while the comic is
 * on screen (a hidden tab or a scrolled-away comic waits), so a learner never
 * misses it by switching tabs.
 *
 * Test seam: with `?comicTest=1` in the page address the clock does not start
 * by itself and window.__comicClock steps it (seek, pause, resume), so a
 * screenshot of "7.5 seconds" is the same picture every time. It does not
 * exist in normal use. With narration it also lists the scheduled clips (`audio`), records
 * every play and stop the player decides on (`audioLog()`; no real audio is started in test mode),
 * and `?comicAudio=blocked` makes play() refuse with NotAllowedError until the learner taps.
 */

import { CAST } from '../../src/labs/comic-kit.ts';
import { captionIsDisplay, sceneArt } from './comic-art.js';
import { audioReduce, audioWanted, clipUrl, initialAudio } from './comic-audio.js';
import {
  DEFAULT_BG,
  NARROW,
  bannerOn,
  buildTimeline,
  cameraAt,
  cameraTransform,
  cleanAudio,
  cleanComic,
  clockReduce,
  initialClock,
  justFinished,
  mmss,
  panelState,
  textScale,
  transcriptOf,
  viewportAt,
} from './comic-timeline.js';
import { svgIcon } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NAME = new Map(CAST.map((c) => [c.id, c.name]));
/** Where a panel comes from as it pops in, round the compass. */
const ENTER = ['left', 'top', 'right', 'zoom', 'left', 'up'];
/** Default places for a panel's bubbles: first speaker, then the answer. */
const BUBBLE_DEFAULT = { message: ['tr', 'bl'], duo: ['tl', 'tr'], default: ['tl', 'br'] };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The test seam is only there when the page address asks for it. */
function testModeOn() {
  try {
    return new URLSearchParams(window.location.search).get('comicTest') === '1';
  } catch {
    return false;
  }
}

/** The Sound toggle's remembered state: on unless the learner turned it off. Storage can be missing or throw. */
const SOUND_KEY = 'opalix.comicSound';
function readSound() {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeSound(on) {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? '1' : '0');
  } catch {
    /* a private window just forgets */
  }
}

/** The big two-line words of a closing panel, split near the middle at a space. */
function displayLines(text) {
  const words = text.split(/\s+/);
  if (words.length < 2) return [text];
  let best = 1;
  let gap = Infinity;
  for (let i = 1; i < words.length; i++) {
    const d = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
    if (d < gap) {
      gap = d;
      best = i;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** Everything one panel is made of, built once; `parts` is what the frame loop flips. */
function buildPanel(panel, tp, placement) {
  const fig = el('figure', `cm-pane cm-bg-${panel.bg ?? DEFAULT_BG[panel.scene]} cm-scene-${panel.scene} cm-enter-${ENTER[(tp.number - 1) % ENTER.length]}`);
  fig.style.left = `${placement.x}px`;
  fig.style.top = `${placement.y}px`;
  fig.style.width = `${placement.w}px`;
  fig.style.height = `${placement.h}px`;
  fig.dataset.panel = String(tp.number);
  fig.dataset.scene = panel.scene;
  fig.append(el('div', 'cm-halftone'));

  const art = sceneArt(panel);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'cm-art');
  svg.setAttribute('viewBox', art.viewBox);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.setAttribute('focusable', 'false');
  // Art is code this repository wrote and holds none of a lab's words (comic-art.js), so this is safe.
  svg.innerHTML = art.svg;
  fig.append(svg);

  const parts = { fig, cap: null, sfx: null, bubbles: [], lines: [], chars: [...svg.querySelectorAll('.cm-char')], last: '' };

  if (panel.caption) {
    if (captionIsDisplay(panel.scene)) {
      const d = el('p', 'cm-display');
      const [a, b] = displayLines(panel.caption);
      d.append(el('span', 'cm-display-a', a));
      if (b) d.append(el('span', 'cm-display-b', b));
      // The words have about 300 units to fit in; the longer they are, the smaller.
      d.style.fontSize = `${Math.min(72, Math.floor(232 / (0.56 * Math.max(a.length, (b ?? '').length, 1))))}px`;
      fig.append(d);
      parts.cap = d;
    } else {
      const cap = el('figcaption', 'cm-cap', panel.caption);
      fig.append(cap);
      parts.cap = cap;
    }
  } else if (captionIsDisplay(panel.scene)) {
    const d = el('p', 'cm-display');
    d.append(el('span', 'cm-display-a', 'Your'), el('span', 'cm-display-b', 'turn.'));
    fig.append(d);
    parts.cap = d;
  }

  if (art.lines && panel.lines?.length) {
    const box = el('div', 'cm-lines');
    box.style.left = `${(art.lines.x / art.width) * 100}%`;
    box.style.top = `${(art.lines.y / art.height) * 100}%`;
    box.style.width = `${(art.lines.w / art.width) * 100}%`;
    box.style.height = `${(art.lines.h / art.height) * 100}%`;
    box.style.setProperty('--maxlen', String(Math.max(...panel.lines.map((l) => l.length), 12)));
    const inner = el('div', 'cm-lines-in');
    panel.lines.forEach((text) => {
      const row = el('div', 'cm-scrline', text);
      row.dataset.kind = /^[$>]/.test(text) ? 'cmd' : /^(200|ok|ready)/i.test(text) ? 'ok' : /^(4\d\d|5\d\d|error|fail)/i.test(text) ? 'warn' : 'out';
      inner.append(row);
      parts.lines.push({ row, len: text.length, chars: -1 });
    });
    box.append(inner);
    fig.append(box);
  }

  const slots = BUBBLE_DEFAULT[panel.scene] ?? BUBBLE_DEFAULT.default;
  panel.bubbles.forEach((b, i) => {
    const bub = el('div', `cm-bub cm-pos-${b.pos ?? slots[i] ?? slots[0]}`);
    if (b.who && NAME.has(b.who)) bub.append(el('span', 'cm-tag', NAME.get(b.who)));
    const words = b.text.split(/\s+/).filter(Boolean).map((w) => el('span', 'cm-w', `${w} `));
    bub.append(...words);
    fig.append(bub);
    parts.bubbles.push({ bub, words, shown: -1, who: b.who });
  });

  if (panel.sfx) {
    const sfx = el('span', 'cm-sfx', panel.sfx);
    sfx.style.setProperty('--sfxlen', String(Math.max(panel.sfx.length, 4)));
    fig.append(sfx);
    parts.sfx = sfx;
  }
  return parts;
}

/** Replay's glyph, built as DOM like the console's others. */
const replayIcon = () => svgIcon('<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4"/>', 16, 24, 1.8);
const pauseIcon = () => svgIcon('<path d="M5 3.5v9M11 3.5v9"/>', 16, 16, 2);
const playIcon = () => svgIcon('<path d="M5 3.5l8 4.5-8 4.5z"/>', 16, 16, 1.6);
const arrowIcon = () => svgIcon('<path d="M3 8h10M9 4l4 4-4 4"/>', 16, 16, 1.8);
const SPEAKER = '<path d="M2.5 6h2.7L9 3v10L5.2 10H2.5z"/>';
const soundIcon = (on) => svgIcon(on ? `${SPEAKER}<path d="M11.4 5.6a3.4 3.4 0 0 1 0 4.8M13 3.8a6 6 0 0 1 0 8.4"/>` : `${SPEAKER}<path d="M11.5 6l3 4M14.5 6l-3 4"/>`, 16, 16, 1.6);

/**
 * Mounts the comic into `container` and starts it (unless the learner prefers reduced motion).
 * `comic` is `{ title, pages: [{ title?, panels }] }` as the learn bundle carries it; `audio` is its
 * narration (`{ slug, clips, lines }`, see comic-timeline.js cleanAudio), optional. Throws if
 * there is nothing to play, so the caller can fall back to the text story.
 * Returns { destroy }.
 */
export function mountComic(container, comic, { onDone, audio } = {}) {
  const clean = cleanComic(comic);
  if (!clean) throw new Error('comic: nothing to play');
  const tl = buildTimeline(clean, { audio });
  const voices = cleanAudio(audio);
  const hasAudio = voices !== null && tl.audio.length > 0;
  const testMode = testModeOn();
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = Boolean(mq?.matches);
  let clock = initialClock(tl, { reduced });
  let width = 0;
  let raf = 0;
  let lastTs = null;
  let paused = testMode;
  /** The learner's own Pause (the test seam's `paused` is separate, so a test can step a paused comic). */
  let userPaused = false;
  let visible = true;
  let gone = false;
  let lastKey = '';
  let doneCalls = 0;

  // ---- the DOM -----------------------------------------------------------

  const root = el('section', 'cm');
  root.dataset.state = clock.status;
  if (testMode) root.dataset.test = '1';
  if (reduced) root.dataset.reduced = '1';
  root.setAttribute('aria-label', `Motion comic: ${clean.title}`);

  const panelCount = tl.pages.reduce((n, p) => n + p.panels.length, 0);
  const stage = el('div', 'cm-stage');
  stage.setAttribute('role', 'img');
  stage.setAttribute(
    'aria-label',
    `${clean.title}. An animated comic of ${panelCount} panels${clean.pages.length > 1 ? ` over ${clean.pages.length} pages` : ''}. The text version is below, under Read as text.`
  );
  const view = el('div', 'cm-view');
  view.setAttribute('aria-hidden', 'true');
  const reel = el('div', 'cm-reel');
  reel.style.width = `${tl.reel.w}px`;
  reel.style.height = `${tl.reel.h}px`;

  const pageParts = tl.pages.map((page, pi) => {
    const sheet = el('div', 'cm-sheet');
    sheet.style.left = `${page.sheet.x}px`;
    sheet.style.top = `${page.sheet.y}px`;
    sheet.style.width = `${page.sheet.w}px`;
    sheet.style.height = `${page.sheet.h}px`;
    reel.append(sheet);
    let banner = null;
    if (page.banner) {
      banner = el('div', 'cm-banner');
      banner.style.left = `${page.banner.x}px`;
      banner.style.top = `${page.banner.y}px`;
      banner.style.width = `${page.banner.w}px`;
      banner.style.height = `${page.banner.h}px`;
      banner.append(el('span', 'cm-banner-n', `Page ${pi + 1}`), el('span', 'cm-banner-t', page.title));
      reel.append(banner);
    }
    const panels = page.panels.map((tp, i) => {
      const parts = buildPanel(clean.pages[pi].panels[i], tp, tp.rect);
      reel.append(parts.fig);
      return parts;
    });
    return { banner, panels };
  });
  view.append(reel);
  const barFill = el('span');
  const bar = el('div', 'cm-bar');
  bar.setAttribute('aria-hidden', 'true');
  bar.append(barFill);
  stage.append(view, bar);

  const replay = el('button', 'btn btn-ghost cm-btn');
  replay.type = 'button';
  replay.id = 'btnComicReplay';
  replay.append(replayIcon(), document.createTextNode('Replay'));
  const skip = el('button', 'btn btn-strong cm-btn');
  skip.type = 'button';
  skip.id = 'btnComicSkip';
  skip.append(document.createTextNode('Skip'), arrowIcon());
  const pauseBtn = el('button', 'btn btn-ghost cm-btn cm-pause');
  pauseBtn.type = 'button';
  pauseBtn.id = 'btnComicPause';
  const paintPause = () => {
    pauseBtn.setAttribute('aria-pressed', String(userPaused));
    pauseBtn.replaceChildren(userPaused ? playIcon() : pauseIcon(), document.createTextNode(userPaused ? 'Play' : 'Pause'));
  };
  paintPause();
  const time = el('span', 'cm-time');
  time.setAttribute('aria-hidden', 'true');
  const controls = el('div', 'cm-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Comic playback');
  controls.append(pauseBtn, replay, skip);

  // Sound: only a comic with voices has these two.
  let sound = hasAudio ? readSound() : false;
  const soundBtn = el('button', 'btn btn-ghost cm-btn cm-sound');
  soundBtn.type = 'button';
  soundBtn.id = 'btnComicSound';
  const soundLabel = el('span', 'cm-sound-label');
  const paintSound = () => {
    soundBtn.setAttribute('aria-pressed', String(sound));
    soundLabel.textContent = sound ? 'Sound on' : 'Sound off';
    soundBtn.replaceChildren(soundIcon(sound), soundLabel);
  };
  const tap = el('button', 'btn btn-strong cm-btn cm-sound-tap', 'Tap to turn the sound on');
  tap.type = 'button';
  tap.id = 'btnComicTapSound';
  tap.hidden = true;
  if (hasAudio) {
    paintSound();
    controls.append(soundBtn);
  }
  controls.append(time);

  const status = el('p', 'sr-only');
  status.setAttribute('role', 'status');

  const details = el('details', 'cm-text');
  const summary = el('summary', '', 'Read as text');
  const list = el('ol', 'cm-transcript');
  for (const t of transcriptOf(clean)) list.append(el('li', '', t));
  details.append(summary, list);

  root.append(stage, controls, status, details);
  if (hasAudio) root.append(tap);
  container.append(root);

  // ---- one frame ---------------------------------------------------------

  /** Flips a panel's classes and counters to what time `t` says; does nothing if nothing changed. */
  function paintPanel(parts, tp, t, calm) {
    const s = panelState(tp, t);
    // While a narrow container's camera is in on the screen, the rest of the panel is out of frame: it steps back.
    const focus = !calm && width < NARROW && tp.focusAt !== null && t >= tp.focusAt && t < tp.end;
    const bubbleKey = s.bubbles.map((b) => `${b.on ? 1 : 0}${calm && b.on ? 99 : b.words}${b.speaking ? 's' : ''}`).join(',');
    const lineKey = s.lines.map((p) => (calm ? (p > 0 ? 1 : 0) : (p >= 1 ? 1 : Math.ceil(p * 100) / 100))).join(',');
    const key = `${s.on}|${s.caption}|${s.sfx}|${s.shake}|${focus}|${bubbleKey}|${lineKey}`;
    if (key === parts.last) return;
    parts.last = key;
    parts.fig.classList.toggle('on', s.on);
    parts.fig.classList.toggle('shake', s.shake);
    parts.fig.classList.toggle('focus', focus);
    parts.cap?.classList.toggle('on', s.caption || (parts.cap.classList.contains('cm-display') && s.on));
    parts.sfx?.classList.toggle('on', s.sfx);
    let speaker = null;
    s.bubbles.forEach((b, i) => {
      const bp = parts.bubbles[i];
      bp.bub.classList.toggle('on', b.on);
      const n = calm ? bp.words.length : b.words;
      if (n !== bp.shown) {
        bp.words.forEach((w, k) => w.classList.toggle('on', k < n));
        bp.shown = n;
      }
      if (b.speaking && !speaker) speaker = bp.who ?? null;
    });
    for (const c of parts.chars) c.classList.toggle('speaking', speaker !== null && c.dataset.cast === speaker);
    s.lines.forEach((p, i) => {
      const lp = parts.lines[i];
      const q = calm ? (p > 0 ? 1 : 0) : p;
      const chars = q >= 1 ? lp.len : Math.ceil(q * lp.len);
      if (chars === lp.chars) return;
      lp.chars = chars;
      lp.row.classList.toggle('on', chars > 0);
      // Typed a character at a time: a clip, so the line's box (and the screen) never reflows.
      lp.row.style.clipPath = chars >= lp.len ? 'none' : `inset(0 ${(100 * (1 - chars / lp.len)).toFixed(2)}% 0 0)`;
    });
  }

  function render() {
    if (gone || width <= 0) return;
    const calm = reduced;
    // A calm (reduced motion) replay cuts from shot to shot instead of travelling.
    const t = clock.t;
    const camT = calm ? settledTime(t) : t;
    const vp = viewportAt(tl, camT, width);
    const cam = cameraAt(tl, camT, vp);
    const key = `${vp.w}|${vp.h.toFixed(1)}|${cam.cx.toFixed(1)}|${cam.cy.toFixed(1)}|${cam.k.toFixed(4)}`;
    if (key !== lastKey) {
      lastKey = key;
      stage.style.height = `${vp.h.toFixed(1)}px`;
      reel.style.transform = cameraTransform(cam, vp);
    }
    tl.pages.forEach((page, pi) => {
      const pp = pageParts[pi];
      pp.banner?.classList.toggle('on', bannerOn(page, t));
      page.panels.forEach((tp, i) => paintPanel(pp.panels[i], tp, t, calm));
    });
    const done = clock.status === 'done';
    barFill.style.width = `${(100 * (done ? 1 : t / tl.total)).toFixed(2)}%`;
    const label = `${mmss(done ? tl.total : t)} / ${mmss(tl.total)}`;
    if (time.textContent !== label) time.textContent = label;
    if (skip.disabled !== done) skip.disabled = done;
    if (pauseBtn.disabled !== done) pauseBtn.disabled = done;
    if (root.dataset.state !== clock.status) root.dataset.state = clock.status;
  }

  /** In calm mode the camera sits where the current shot ends, with no travelling in between. */
  function settledTime(t) {
    let shot = tl.shots[0];
    for (const s of tl.shots) if (s.t <= t) shot = s;
    return shot.t + shot.dur;
  }

  /** Sizes everything to the container: the stage is as wide as it, and the words of narrow panels are drawn larger. */
  function layout() {
    const w = Math.round(root.clientWidth);
    if (w === width) return;
    width = w;
    lastKey = '';
    for (const pp of pageParts) for (const p of pp.panels) p.last = '';
    if (w <= 0) return;
    const vp = viewportAt(tl, 0, w);
    for (const page of tl.pages) {
      const pp = pageParts[page.index];
      page.panels.forEach((tp, i) => {
        const fig = pp.panels[i].fig;
        // Bubbles and screens are 15px by design, captions and name tags 12 to 13: each is drawn larger by what its own floor needs.
        fig.style.setProperty('--ts', textScale(tp.rect, vp, { minPx: 13, basePx: 15, max: 1.9 }).toFixed(3));
        fig.style.setProperty('--tt', textScale(tp.rect, vp, { minPx: 11.5, basePx: 12, max: 2.4 }).toFixed(3));
      });
    }
    render();
  }

  // ---- the voices --------------------------------------------------------

  let ast = initialAudio();
  /** One Audio element per clip, made when its page is near (the first page at once) and kept for Replay. */
  const elements = new Map();
  /** In test mode: what the player decided, instead of real playback. */
  const audioLog = [];
  const blockedParam = testMode && new URLSearchParams(window.location.search).get('comicAudio') === 'blocked';
  let unlocked = false;
  const pageKeys = tl.pages.map((page) => {
    const numbers = new Set(page.panels.map((p) => p.number));
    return [...new Set(tl.audio.filter((c) => numbers.has(c.panel)).map((c) => c.key))];
  });
  const preloaded = new Set();

  function elementFor(key) {
    let a = elements.get(key);
    if (a || typeof Audio !== 'function') return a ?? null;
    a = new Audio();
    a.preload = 'auto';
    a.addEventListener('ended', () => feedAudio({ type: 'ended', key }));
    // A clip that is missing or will not decode is skipped in silence; the comic carries on.
    a.addEventListener('error', () => feedAudio({ type: 'errored', key }));
    a.src = clipUrl(voices.slug, key);
    elements.set(key, a);
    return a;
  }

  /** Makes the elements of a page (the first at mount, the next as the camera nears it), if sound is on. */
  function preloadPage(pi) {
    if (!hasAudio || !sound || pi >= pageKeys.length || preloaded.has(pi)) return;
    preloaded.add(pi);
    for (const key of pageKeys[pi]) elementFor(key);
  }

  function runAudio(cmd) {
    if (testMode) audioLog.push({ type: cmd.type, key: cmd.key, at: clock.t, ...(cmd.type === 'play' ? { offset: cmd.offset } : {}) });
    if (cmd.type === 'stop') {
      const a = elements.get(cmd.key);
      try {
        a?.pause();
        if (a) a.currentTime = 0;
      } catch {
        /* an element that cannot rewind is stopped all the same */
      }
      return;
    }
    if (testMode) {
      // No sound in a test: the browser's refusal can be staged, and nothing else is played.
      if (blockedParam && !unlocked) {
        const err = Object.assign(new Error('play() refused until the learner taps'), { name: 'NotAllowedError' });
        Promise.resolve().then(() => feedAudio({ type: 'rejected', key: cmd.key, name: err.name }));
      }
      return;
    }
    const a = elementFor(cmd.key);
    if (!a) {
      feedAudio({ type: 'errored', key: cmd.key });
      return;
    }
    try {
      if (cmd.offset > 0) a.currentTime = cmd.offset;
      const p = a.play();
      p?.catch?.((err) => feedAudio({ type: 'rejected', key: cmd.key, name: err?.name ?? 'Error' }));
    } catch (err) {
      feedAudio({ type: 'rejected', key: cmd.key, name: err?.name ?? 'Error' });
    }
  }

  function feedAudio(event) {
    const out = audioReduce(ast, event);
    ast = out.state;
    for (const cmd of out.commands) runAudio(cmd);
    tap.hidden = !(hasAudio && ast.blocked && sound && !gone);
  }

  /** Whether the clock is advancing, as far as the voices are concerned (a test steps it by hand, so only Skip and the end stop it). */
  const audioRunning = () => !gone && clock.status === 'playing' && (testMode || running());

  /** Asks the clock which clip should be sounding now and lets the state machine act on the answer. */
  function syncAudio() {
    if (!hasAudio) return;
    const wanted = audioWanted(tl.audio, clock.t, { running: audioRunning(), sound });
    if (clock.status === 'playing' && !gone) {
      let page = 0;
      tl.pages.forEach((p, i) => {
        if (p.start <= clock.t) page = i;
      });
      preloadPage(page);
      preloadPage(page + 1);
    }
    feedAudio({ type: 'sync', wanted });
  }

  function releaseAudio() {
    for (const a of elements.values()) {
      try {
        a.pause();
        a.removeAttribute('src');
        a.load();
      } catch {
        /* nothing left to release */
      }
    }
    elements.clear();
  }

  // ---- the clock ---------------------------------------------------------

  function dispatch(action) {
    const before = clock;
    clock = clockReduce(clock, action, tl.total);
    if (clock !== before) {
      render();
      syncAudio();
      if (justFinished(before, clock)) finished();
    }
  }

  function finished() {
    doneCalls += 1;
    status.textContent = 'The comic has finished. The text version is under Read as text.';
    try {
      onDone?.();
    } catch {
      /* a caller's mistake must not stop the comic */
    }
  }

  const running = () => !gone && !paused && !userPaused && visible && width > 0 && !document.hidden && clock.status === 'playing';

  function frame(ts) {
    raf = 0;
    if (gone) return;
    if (clock.status !== 'playing') return;
    raf = requestAnimationFrame(frame);
    if (!running()) {
      lastTs = null;
      // The voices wait with the clock (a hidden tab, a comic scrolled away).
      syncAudio();
      return;
    }
    const dt = lastTs === null ? 0 : (ts - lastTs) / 1000;
    lastTs = ts;
    dispatch({ type: 'tick', dt });
    syncAudio();
  }

  function ensureLoop() {
    if (gone || raf || clock.status !== 'playing') return;
    lastTs = null;
    raf = requestAnimationFrame(frame);
  }

  replay.addEventListener('click', () => {
    status.textContent = '';
    lastKey = '';
    userPaused = false;
    root.removeAttribute('data-paused');
    paintPause();
    clock = { t: 0, status: 'playing' };
    render();
    syncAudio();
    ensureLoop();
  });
  pauseBtn.addEventListener('click', () => {
    if (clock.status !== 'playing') return;
    userPaused = !userPaused;
    root.toggleAttribute('data-paused', userPaused);
    paintPause();
    status.textContent = userPaused ? 'Paused.' : 'Playing.';
    lastTs = null;
    syncAudio();
    ensureLoop();
  });
  soundBtn.addEventListener('click', () => {
    sound = !sound;
    writeSound(sound);
    paintSound();
    status.textContent = sound ? 'Sound on.' : 'Sound off.';
    syncAudio();
  });
  // Any tap is the browser's permission to make sound: if play() was refused, try again now,
  // inside the tap (this covers the "Tap to turn the sound on" button, Replay and the toggle).
  root.addEventListener('click', () => {
    unlocked = true;
    if (!ast.blocked) return;
    feedAudio({ type: 'gesture' });
    syncAudio();
  });
  skip.addEventListener('click', () => {
    dispatch({ type: 'skip' });
    // The button just switched itself off; keep the learner's place on the one that still works.
    if (document.activeElement === skip || document.activeElement === document.body) replay.focus();
  });

  // ---- watching the page -------------------------------------------------

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  ro?.observe(root);
  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          for (const e of entries) visible = e.isIntersecting;
          syncAudio();
        }, { threshold: [0, 0.15] })
      : null;
  io?.observe(root);
  const onMotionChange = () => {
    reduced = Boolean(mq?.matches);
    root.toggleAttribute('data-reduced', reduced);
    lastKey = '';
    if (reduced) dispatch({ type: 'skip' });
    else render();
  };
  mq?.addEventListener?.('change', onMotionChange);
  const onVisibility = () => {
    lastTs = null;
    syncAudio();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ---- the test seam -----------------------------------------------------

  const seam = {
    seek: (t) => dispatch({ type: 'seek', t }),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      ensureLoop();
    },
    time: () => clock.t,
    total: tl.total,
    status: () => clock.status,
    doneCalls: () => doneCalls,
    timeline: () => tl,
    audio: tl.audio.map((c) => ({ ...c, url: hasAudio ? clipUrl(voices.slug, c.key) : null })),
    audioLog: () => audioLog.slice(),
    userPaused: () => userPaused,
    audioState: () => ({ sound, blocked: ast.blocked, current: ast.current, failed: [...ast.failed] }),
  };
  if (testMode) window.__comicClock = seam;

  // ---- go ----------------------------------------------------------------

  function destroy() {
    if (gone) return;
    gone = true;
    syncAudio();
    releaseAudio();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ro?.disconnect();
    io?.disconnect();
    mq?.removeEventListener?.('change', onMotionChange);
    document.removeEventListener('visibilitychange', onVisibility);
    if (testMode && window.__comicClock === seam) delete window.__comicClock;
    root.remove();
  }

  try {
    layout();
    render();
    // The first page's clips start loading now (a reduced-motion comic starts finished and loads none until Replay).
    if (clock.status === 'playing') preloadPage(0);
  } catch (err) {
    // Nothing is left behind if the comic cannot be drawn; the caller falls back to the text story.
    destroy();
    throw err;
  }
  if (clock.status === 'done') {
    // Reduced motion: finished from the start. Say so once the caller has the handle.
    Promise.resolve().then(() => {
      if (!gone) finished();
    });
  } else {
    ensureLoop();
  }

  return { destroy };
}
