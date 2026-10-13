/**
 * Warm-up games: four small games a learner plays after a warm-up's closing story.
 *
 *   sort           cards come one at a time; drag or swipe each to one of the buckets, tap a bucket, or
 *                  press ← / → (1 to 4 when there are more than two buckets)
 *   flag           the same cards game with two sides: "leave it" (left) and "flag it" (right), or the
 *                  words of the game's `choices`; a `board` shows the providers' status above the card
 *   order-and-nest drag the steps into the order of the pipeline and nest them, then send a packet through
 *                  it: it stops and bounces at the first step out of place
 *   sliders        move the sliders, dial the readout (to the `target` when there is one), pick the slider
 *                  that moves it most
 *
 * Every game sits in one shell: a title and its one-line goal, a host from the comic's cast who reacts to
 * each answer, a Start button and a 3-2-1 count-in, the score, the combo, hearts (sort and flag), a
 * progress bar, Sound and Timer toggles, and an end screen with stars, the score, the best score kept in
 * this browser, a recap of every item with the right answer and why, Play again and Continue. "Skip this
 * game" (and on the first game "Skip all games") is always one press away. The rules (points, hearts,
 * stars, keys) are pure functions in game-engine.js; the graders are in game-grade.js.
 *
 * Accessibility: every action is a real button or a focusable card or tile with keys; drag and swipe are
 * extra ways, never the only one. A live region says each card, each verdict and the hearts left; the
 * picture never carries a result alone (words say Right, Not quite, Up, Down). The clock can be turned off
 * (the Timer toggle, remembered). Reduced motion (and test mode) draws no sliding, flying or shaking: the
 * feedback is immediate. Every string from a lab goes in as text; the only markup assigned is this
 * repository's own SVG (the glyphs below and the host's bust from comic-art.js, whose id is checked).
 *
 *   mountGame(host, game, { onResult, onContinue, onSkip, onSkipAll, previous, testMode, reducedMotion, clock, storage, seed })
 *     onResult({ id, solved: true, tries })  each time a round is won; `tries` counts the rounds played
 *                                            (each Start or Play again), so a first-round win is 1
 *     onContinue()   the end screen's Continue (shown only when given)
 *     onSkip()       "Skip this game"; onSkipAll() "Skip all games" (each shown only when given)
 *     previous       'solved' | 'skipped' | null: what the learner did with this game before
 *     testMode       no count-in, no clock, no delays, no sound, nothing moves (default: `?gameTest=1` in the
 *                    page address, or `globalThis.__opalixGameTest === true`)
 *   Returns { root, destroy }.
 */

import { make, button } from './learn-ui.js';
import { bust } from './comic-art.js';
import { unlockStings, playSting } from './comic-sfx.js';
import { CAST } from '../../src/labs/comic-kit.ts';
import { gradeSort, gradeFlag, gradeAsk, evalFormula, formatReadout, outlineAnswer, shuffle } from './game-grade.js';
import * as E from './game-engine.js';

export { shuffle, gradeSort, gradeFlag, evalFormula, formatReadout, gradeAsk, outlineAnswer, gradeOutline } from './game-grade.js';

/** The Sound toggle: the comic's own preference, so one switch silences both. */
export const SOUND_KEY = 'opalix.comicSound';
/** The Timer toggle: '0' when the learner turned the clock off. */
export const TIMER_KEY = 'opalix.gameTimer';
/** Who may host a game (the speaking cast), and who does when the game names nobody. */
export const HOSTS = ['maren', 'tomasz', 'graham', 'ollie', 'jess', 'priya'];
export const DEFAULT_HOST = 'tomasz';

/** How long feedback stays before the next card, in ms (test mode: none; reduced motion: shorter). */
const DELAY = { right: 650, count: 650, packet: 260, lost: 700 };

const SVG_NS = 'http://www.w3.org/2000/svg';
const GLYPHS = {
  heart: 'M12 20.5s-7.6-4.6-9.5-9.3C1 7.6 3.3 4 6.9 4c2.1 0 3.7 1.2 5.1 3 1.4-1.8 3-3 5.1-3 3.6 0 5.9 3.6 4.4 7.2-1.9 4.7-9.5 9.3-9.5 9.3z',
  star: 'M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z',
  sound: 'M4 9.5h3.5L12 6v12l-4.5-3.5H4z',
  waves: 'M15.5 9.2c1.4 1.5 1.4 4.1 0 5.6M18 6.8c2.8 2.9 2.8 7.5 0 10.4',
  mute: 'M16 9.5l5 5M21 9.5l-5 5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
};

function glyph(names, { size = 20, fill = false, cls = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);
  const paths = (Array.isArray(names) ? names : [names]).map((n) => `<path d="${GLYPHS[n]}"/>`).join('');
  // Markup this file wrote, never a lab's text.
  svg.innerHTML = paths;
  svg.setAttribute('fill', fill ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  return svg;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Where the game runs: test mode, motion, the clock, storage, sound
// ---------------------------------------------------------------------------

/** Test mode is only on when the page address or the test's own global asks for it. */
export function gameTestMode() {
  try {
    if (globalThis.__opalixGameTest === true) return true;
    return new URLSearchParams(globalThis.location?.search ?? '').get('gameTest') === '1';
  } catch {
    return false;
  }
}

function localStore() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readFlag(storage, key) {
  try {
    return storage?.getItem(key) !== '0';
  } catch {
    return true;
  }
}

function writeFlag(storage, key, on) {
  try {
    storage?.setItem(key, on ? '1' : '0');
  } catch {
    /* a private window just forgets */
  }
}

function envOf(opts) {
  const testMode = opts.testMode ?? gameTestMode();
  let reduced = opts.reducedMotion;
  if (reduced === undefined) {
    try {
      reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      reduced = false;
    }
  }
  const clock = opts.clock ?? {
    now: () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
  };
  const storage = opts.storage !== undefined ? opts.storage : localStore();
  const still = Boolean(testMode || reduced);
  return {
    testMode,
    still,
    clock,
    storage,
    seed: Number.isFinite(opts.seed) ? opts.seed : testMode ? 7 : Date.now(),
    /** A delay as this run takes it: none in test mode, at most 300 ms under reduced motion. */
    delay: (ms) => (testMode ? 0 : reduced ? Math.min(ms, 300) : ms),
  };
}

// ---------------------------------------------------------------------------
// The shell every game shares
// ---------------------------------------------------------------------------

let uid = 0;

function shell(game, env, opts) {
  const id = `game${++uid}`;
  const timers = new Set();
  const later = (fn, ms) => {
    if (ms <= 0) {
      fn();
      return null;
    }
    const h = env.clock.setTimeout(() => {
      timers.delete(h);
      fn();
    }, ms);
    timers.add(h);
    return h;
  };
  const cancelAll = () => {
    for (const h of timers) env.clock.clearTimeout(h);
    timers.clear();
  };

  let sound = !env.testMode && readFlag(env.storage, SOUND_KEY);
  let timerOn = readFlag(env.storage, TIMER_KEY);
  const play = (name) => {
    if (sound && !env.testMode) playSting(name);
  };

  const root = make('section', 'game');
  root.dataset.kind = game.kind;
  root.dataset.game = game.id;
  root.dataset.phase = 'intro';
  if (env.still) root.dataset.still = '';
  if (env.testMode) root.dataset.test = '';

  // --- top: the host and the title -------------------------------------------
  const who = HOSTS.includes(game.host) ? game.host : DEFAULT_HOST;
  const hostName = CAST.find((c) => c.id === who)?.name ?? who;
  const top = make('header', 'game-top');
  const hostBox = make('div', 'game-host');
  const art = document.createElementNS(SVG_NS, 'svg');
  art.setAttribute('viewBox', '-4 -4 128 138');
  art.setAttribute('class', 'game-host-art');
  art.setAttribute('aria-hidden', 'true');
  art.setAttribute('focusable', 'false');
  const hostTag = make('span', 'game-host-name', hostName);
  hostBox.append(art, hostTag);
  const titles = make('div', 'game-titles');
  const heading = make('h2', 'game-title', game.title);
  heading.tabIndex = -1;
  heading.id = `${id}-title`;
  root.setAttribute('aria-labelledby', heading.id);
  const prompt = make('p', 'game-prompt', game.prompt);
  titles.append(heading, prompt);
  const bubble = make('p', 'game-bubble');
  bubble.setAttribute('aria-hidden', 'true');
  bubble.hidden = true;
  // Its place is kept while a round plays, so the board does not jump when the host speaks.
  bubble.dataset.empty = '';
  top.append(hostBox, titles, bubble);

  const drawHost = (mood) => {
    // bust() checks the id and draws only this repository's art.
    art.innerHTML = bust(who, 0, 0, 120, 'game-host-char', mood ? { mood } : undefined);
    hostBox.dataset.mood = mood || 'idle';
  };
  drawHost(null);

  // --- the HUD -----------------------------------------------------------------
  const hud = make('div', 'game-hud');
  const scoreBox = make('div', 'game-hud-item game-score');
  const scoreValue = make('strong', 'game-score-value', '0');
  scoreBox.append(make('span', 'game-hud-label', 'Score'), scoreValue);
  const streakBox = make('div', 'game-hud-item game-streak');
  const pips = make('span', 'game-pips');
  pips.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < E.COMBO_CAP; i++) pips.append(make('i'));
  const comboValue = make('strong', 'game-combo', '×1');
  streakBox.append(make('span', 'game-hud-label', 'Combo'), pips, comboValue);
  // Only the card games keep a combo.
  streakBox.hidden = game.kind !== 'sort' && game.kind !== 'flag';
  const livesBox = make('div', 'game-hud-item game-lives');
  livesBox.setAttribute('role', 'img');
  const toggles = make('div', 'game-toggles');
  const soundBtn = button('', { kind: 'ghost' });
  soundBtn.classList.add('btn-tiny', 'game-toggle', 'game-sound');
  const timerBtn = button('', { kind: 'ghost' });
  timerBtn.classList.add('btn-tiny', 'game-toggle', 'game-timer-toggle');
  toggles.append(soundBtn, timerBtn);
  hud.append(scoreBox, streakBox, livesBox, toggles);

  const progress = make('div', 'game-progress');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-label', 'Progress');
  const fill = make('span', 'game-progress-fill');
  progress.append(fill);

  const drawSound = () => {
    soundBtn.replaceChildren(glyph(sound ? ['sound', 'waves'] : ['sound', 'mute'], { size: 16 }), make('span', 'game-toggle-text', sound ? 'Sound on' : 'Sound off'));
    soundBtn.setAttribute('aria-pressed', String(sound));
  };
  const drawTimer = () => {
    timerBtn.replaceChildren(glyph('clock', { size: 16 }), make('span', 'game-toggle-text', timerOn ? 'Timer on' : 'Timer off'));
    timerBtn.setAttribute('aria-pressed', String(timerOn));
  };
  soundBtn.addEventListener('click', () => {
    sound = !sound;
    writeFlag(env.storage, SOUND_KEY, sound);
    if (sound) unlockStings();
    drawSound();
  });
  drawSound();
  drawTimer();
  timerBtn.hidden = true;

  // --- the stage, the intro, the count-in, the end ------------------------------
  const stage = make('div', 'game-stage');
  const intro = make('div', 'game-intro');
  const count = make('div', 'game-count');
  count.setAttribute('aria-hidden', 'true');
  count.hidden = true;
  const end = make('div', 'game-end');
  end.hidden = true;
  const status = make('p', 'game-status sr-only');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const skipBar = make('div', 'game-skipbar');
  const skipOne = opts.onSkip ? button('Skip this game', { kind: 'quiet', id: 'btnSkipGame' }) : null;
  const skipAll = opts.onSkipAll ? button('Skip all games', { kind: 'quiet', id: 'btnSkipAllGames' }) : null;
  if (skipOne) skipBar.append(skipOne);
  if (skipAll) skipBar.append(skipAll);
  skipBar.hidden = !skipOne && !skipAll;

  root.append(top, hud, progress, stage, intro, count, end, status, skipBar);

  const sh = {
    id,
    root,
    stage,
    heading,
    get sound() {
      return sound;
    },
    get timerOn() {
      return timerOn;
    },
    play,
    later,
    cancelAll,
    solvedHere: false,
    onTimerToggle: null,
    phase(name) {
      root.dataset.phase = name;
      intro.hidden = name !== 'intro';
      count.hidden = name !== 'count';
      end.hidden = name !== 'end';
      stage.hidden = name !== 'play';
      hud.hidden = name === 'intro' || name === 'count';
      progress.hidden = hud.hidden;
      bubble.hidden = name !== 'play';
      skipBar.hidden = (!skipOne && !skipAll) || (name === 'end' && sh.solvedHere);
    },
    say(text) {
      // Emptied first so the same words said twice are said again.
      status.textContent = '';
      status.textContent = text;
    },
    react(mood, text) {
      drawHost(mood);
      bubble.textContent = text ?? '';
      if (text) delete bubble.dataset.empty;
      else bubble.dataset.empty = '';
      bubble.dataset.mood = mood || 'idle';
      if (!env.still && text) {
        bubble.classList.remove('game-pop');
        void bubble.offsetWidth;
        bubble.classList.add('game-pop');
      }
    },
    quiet() {
      bubble.dataset.empty = '';
      bubble.textContent = '';
    },
    score(n, gained = 0) {
      scoreValue.textContent = String(n);
      if (gained > 0 && !env.still) {
        const float = make('span', 'game-float', `+${gained}`);
        scoreBox.append(float);
        later(() => float.remove(), 900);
      }
    },
    streak(n) {
      const shown = Math.min(n, E.COMBO_CAP);
      [...pips.children].forEach((p, i) => (p.dataset.on = String(i < shown)));
      comboValue.textContent = `×${E.comboFor(Math.max(1, n))}`;
      streakBox.dataset.hot = String(n >= 3);
    },
    lives(n, max) {
      livesBox.hidden = n === null;
      if (n === null) return;
      livesBox.replaceChildren();
      livesBox.setAttribute('aria-label', `${n} of ${plural(max, 'heart', 'hearts')} left`);
      for (let i = 0; i < max; i++) {
        const h = glyph('heart', { size: 22, fill: i < n, cls: 'game-heart' });
        h.dataset.on = String(i < n);
        livesBox.append(h);
      }
    },
    progress(share, label) {
      const pct = Math.round(Math.max(0, Math.min(1, share)) * 100);
      fill.style.width = `${pct}%`;
      progress.setAttribute('aria-valuenow', String(pct));
      progress.setAttribute('aria-valuetext', label ?? `${pct}%`);
    },
    useTimer(on) {
      timerBtn.hidden = !on;
    },

    /** The intro: the rules and Start. `onStart` runs after the count-in. */
    intro({ rules, onStart }) {
      intro.replaceChildren();
      if (opts.previous === 'skipped' || opts.previous === 'solved') {
        const badge = make('p', 'game-badge', opts.previous === 'skipped' ? 'Skipped' : 'Solved');
        badge.dataset.state = opts.previous;
        intro.append(badge);
      }
      const list = make('ul', 'game-rules');
      for (const r of rules) list.append(make('li', '', r));
      const start = button('Start', { kind: 'accent', id: `${id}-start` });
      start.classList.add('btn-lg', 'game-start');
      start.addEventListener('click', () => {
        if (sound) unlockStings();
        sh.countIn(onStart);
      });
      intro.append(list, start);
      sh.phase('intro');
    },

    /** 3, 2, 1, Go: then `then()`. None in test mode. */
    countIn(then) {
      cancelAll();
      if (env.testMode) {
        sh.phase('play');
        then();
        return;
      }
      sh.phase('count');
      const steps = ['3', '2', '1', 'Go!'];
      const tick = (i) => {
        if (i >= steps.length) {
          sh.phase('play');
          then();
          return;
        }
        count.textContent = steps[i];
        count.dataset.n = String(i);
        count.classList.remove('game-pop');
        if (!env.still) {
          void count.offsetWidth;
          count.classList.add('game-pop');
        }
        play(i < 3 ? 'tick' : 'whoosh');
        later(() => tick(i + 1), i < 3 ? DELAY.count : 350);
      };
      sh.say('Starting in 3, 2, 1.');
      tick(0);
    },

    /**
     * The end screen. `won` decides the words; `recap` is [{ text, answer, why?, ok, note? }] or a node;
     * `onReplay` starts a new round. Focus moves to its heading.
     */
    end({ won, stars, score, title, line, recap, onReplay }) {
      cancelAll();
      sh.quiet();
      drawHost(won ? 'pleased' : 'worried');
      if (won) sh.solvedHere = true;
      const kept = won ? E.writeBest(env.storage, game, score) : { best: E.readBest(env.storage, game), isNew: false };
      end.replaceChildren();
      const head = make('h3', 'game-end-title', title);
      head.tabIndex = -1;
      head.id = `${id}-end`;
      end.setAttribute('aria-labelledby', head.id);
      const starRow = make('div', 'game-stars');
      starRow.setAttribute('role', 'img');
      starRow.setAttribute('aria-label', `${stars} of 3 stars`);
      for (let i = 0; i < 3; i++) {
        const s = glyph('star', { size: 40, fill: i < stars, cls: 'game-star' });
        s.dataset.on = String(i < stars);
        s.style.setProperty('--i', String(i));
        starRow.append(s);
      }
      const nums = make('p', 'game-end-score');
      nums.append(make('span', '', 'Score '), make('strong', 'game-end-points', String(score)), make('span', '', ` · Best ${Math.max(kept.best, 0)}`));
      if (kept.isNew && score > 0) nums.append(make('span', 'game-newbest', 'New best!'));
      const parts = [head, starRow, nums];
      if (line) parts.push(make('p', 'game-end-line', line));
      const recapBox = make('div', 'game-recap');
      recapBox.append(make('h4', 'game-recap-title', 'Recap'));
      if (Array.isArray(recap)) {
        const ul = make('ul', 'game-recap-list');
        for (const r of recap) {
          const li = make('li', 'game-recap-item');
          li.dataset.ok = String(r.ok);
          const mark = make('span', 'game-recap-mark', r.ok ? '✓' : '✗');
          mark.setAttribute('aria-hidden', 'true');
          const body = make('div', 'game-recap-body');
          body.append(make('span', 'sr-only', r.ok ? 'Right first time: ' : 'Missed at first: '), make('strong', 'game-recap-text', r.text));
          body.append(make('span', 'game-recap-answer', ` → ${r.answer}`));
          if (r.note) body.append(make('span', 'game-recap-note', ` (${r.note})`));
          if (r.why) body.append(make('span', 'game-recap-why', r.why));
          li.append(mark, body);
          ul.append(li);
        }
        recapBox.append(ul);
      } else if (recap) recapBox.append(recap);
      parts.push(recapBox);
      if (game.explanation) {
        const ex = make('div', 'game-explain');
        ex.append(make('strong', 'game-explain-head', 'Why it works this way'), make('p', 'game-explain-body', game.explanation));
        parts.push(ex);
      }
      const actions = make('div', 'game-end-actions');
      const again = button(won ? 'Play again' : 'Try again', { kind: won ? 'ghost' : 'accent', id: `${id}-again` });
      again.classList.add('game-again');
      again.addEventListener('click', () => onReplay());
      actions.append(again);
      if (opts.onContinue && (won || opts.previous)) {
        const go = button('Continue', { kind: 'accent', id: `${id}-continue` });
        go.classList.add('game-continue');
        go.addEventListener('click', () => opts.onContinue());
        actions.prepend(go);
      }
      parts.push(actions);
      end.append(...parts);
      sh.phase('end');
      sh.say(`${title} ${plural(stars, 'star', 'stars')}, score ${score}.`);
      head.focus();
      play(won ? 'register' : 'thud');
    },
  };

  timerBtn.addEventListener('click', () => {
    timerOn = !timerOn;
    writeFlag(env.storage, TIMER_KEY, timerOn);
    drawTimer();
    sh.onTimerToggle?.(timerOn);
  });
  skipOne?.addEventListener('click', () => {
    cancelAll();
    opts.onSkip();
  });
  skipAll?.addEventListener('click', () => {
    cancelAll();
    opts.onSkipAll();
  });
  return sh;
}

const CHEERS = ['Nice!', 'Spot on.', 'Yes!', "That's it."];

// ---------------------------------------------------------------------------
// sort and flag: one card at a time
// ---------------------------------------------------------------------------

function mountCards(game, sh, env, report) {
  const deck = E.deckOf(game);
  const byId = new Map(deck.map((c) => [c.id, c]));
  const choices = E.choicesOf(game);
  const two = choices.length === 2;
  let state = null;
  let rounds = 0;
  let locked = true;
  let waiting = false;
  let card = null;
  let clock = null;

  const arena = make('div', 'game-arena');
  if (game.kind === 'flag' && Array.isArray(game.board) && game.board.length) {
    const board = make('div', 'game-board');
    board.setAttribute('role', 'group');
    board.setAttribute('aria-label', 'Live status');
    board.append(make('span', 'game-board-title', 'Live status'));
    for (const b of game.board) {
      const row = make('span', 'game-board-item');
      row.dataset.status = b.status;
      const dot = make('i', 'game-board-dot');
      dot.setAttribute('aria-hidden', 'true');
      row.append(dot, make('span', 'game-board-name', b.name), make('span', 'game-board-state', b.status === 'down' ? 'Down' : 'Up'));
      board.append(row);
    }
    arena.append(board);
  }

  const lane = make('div', 'game-lane');
  lane.dataset.n = String(choices.length);
  const deckBox = make('div', 'game-deck');
  const slot = make('div', 'game-deck-slot');
  const ring = make('div', 'game-clock');
  ring.setAttribute('aria-hidden', 'true');
  const ringSvg = document.createElementNS(SVG_NS, 'svg');
  ringSvg.setAttribute('viewBox', '0 0 48 48');
  ringSvg.setAttribute('class', 'game-clock-ring');
  // Markup this file wrote.
  ringSvg.innerHTML = '<circle class="game-clock-track" cx="24" cy="24" r="20"/><circle class="game-clock-left" cx="24" cy="24" r="20"/>';
  const ringNum = make('span', 'game-clock-num');
  ring.append(ringSvg, ringNum);
  ring.hidden = true;
  deckBox.append(make('div', 'game-deck-under'), slot, ring);

  const buckets = new Map();
  choices.forEach((c, i) => {
    // Not a .btn: a bucket is a big flat zone of its own.
    const b = make('button', 'game-bucket');
    b.type = 'button';
    b.dataset.bucket = c.id;
    b.dataset.side = two ? (i === 0 ? 'left' : 'right') : 'slot';
    b.dataset.i = String(i);
    const key = two ? (i === 0 ? '←' : '→') : String(i + 1);
    const keyEl = make('span', 'game-bucket-key', key);
    keyEl.setAttribute('aria-hidden', 'true');
    b.append(keyEl, make('span', 'game-bucket-label', c.label));
    b.setAttribute('aria-keyshortcuts', two ? (i === 0 ? 'ArrowLeft' : 'ArrowRight') : String(i + 1));
    b.addEventListener('click', () => choose(c.id, 'tap'));
    buckets.set(c.id, b);
  });
  if (two) lane.append(buckets.get(choices[0].id), deckBox, buckets.get(choices[1].id));
  else lane.append(deckBox, ...buckets.values());

  const next = button('Next card', { kind: 'accent' });
  next.classList.add('game-next');
  next.hidden = true;
  next.addEventListener('click', () => advance());
  const keys = make('p', 'game-keys', two ? 'Drag or swipe the card to a side, tap a side, or press ← or →.' : `Drag the card onto a bucket, tap one, or press 1 to ${choices.length}.`);
  arena.append(lane, next, keys);
  sh.stage.append(arena);

  // --- the clock ---------------------------------------------------------------
  const limitNow = () => E.timerFor(game, { enabled: sh.timerOn && !env.testMode });
  function startClock() {
    stopClock();
    const limit = limitNow();
    ring.hidden = limit === 0;
    if (!limit) return;
    const began = env.clock.now();
    clock = { limit, began, handle: null, lastWhole: limit };
    const tick = () => {
      if (!clock) return;
      const left = Math.max(0, clock.limit - (env.clock.now() - clock.began) / 1000);
      drawRing(left, clock.limit);
      const whole = Math.ceil(left);
      if (whole !== clock.lastWhole) {
        clock.lastWhole = whole;
        if (whole <= 3 && whole > 0) sh.play('tick');
      }
      if (left <= 0) {
        expire();
        return;
      }
      clock.handle = env.clock.setTimeout(tick, 100);
    };
    drawRing(limit, limit);
    clock.handle = env.clock.setTimeout(tick, 100);
  }
  /** Stops the clock; returns { left, limit } as it stood (zeros with no clock). */
  function stopClock() {
    if (!clock) return { left: 0, limit: 0 };
    env.clock.clearTimeout(clock.handle);
    const left = Math.max(0, clock.limit - (env.clock.now() - clock.began) / 1000);
    const out = { left, limit: clock.limit };
    clock = null;
    return out;
  }
  function drawRing(left, limit) {
    const c = 2 * Math.PI * 20;
    const arc = ringSvg.lastChild;
    arc?.setAttribute?.('stroke-dasharray', c.toFixed(2));
    arc?.setAttribute?.('stroke-dashoffset', (c * (1 - left / limit)).toFixed(2));
    ringNum.textContent = String(Math.ceil(left));
    ring.dataset.low = String(left <= 3);
  }
  sh.onTimerToggle = (on) => {
    if (locked || waiting || !card) return;
    if (on) startClock();
    else {
      stopClock();
      ring.hidden = true;
    }
  };

  // --- a round -----------------------------------------------------------------
  function hud() {
    sh.score(state.score, state.last?.correct ? state.last.points : 0);
    sh.streak(state.streak);
    sh.lives(state.lives, state.maxLives);
    sh.progress(E.progressOf(state), `${state.cleared.length} of ${plural(state.total, 'card', 'cards')} cleared`);
  }

  function startRound() {
    rounds += 1;
    state = E.newRound(game, { seed: env.seed + rounds });
    sh.useTimer(E.timerFor(game) > 0 && !env.testMode);
    sh.quiet();
    sh.react(null, null);
    hud();
    deal();
  }

  function deal() {
    const id = E.currentCard(state);
    if (id === null) return finish();
    const c = byId.get(id);
    waiting = false;
    next.hidden = true;
    for (const b of buckets.values()) delete b.dataset.flash;
    card = make('article', 'game-cardx');
    card.dataset.card = id;
    card.tabIndex = 0;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-roledescription', 'card');
    const again = (state.misses[id] ?? 0) > 0;
    const label = `Card ${state.cleared.length + 1} of ${state.total}${again ? ', again' : ''}`;
    card.setAttribute('aria-label', label);
    if (again) card.append(make('span', 'game-card-again', 'Again'));
    card.append(make('p', 'game-card-text', c.text));
    if (!env.still) card.classList.add('game-enter');
    slot.replaceChildren(card);
    dragCard(card);
    sh.say(`${label}: ${c.text}`);
    locked = false;
    card.focus();
    startClock();
  }

  function choose(choice, how) {
    if (locked || waiting || !state || state.status !== 'playing') return;
    locked = true;
    const t = stopClock();
    state = E.answerCard(state, game, choice, t);
    verdict(how);
  }

  function expire() {
    if (locked || !state || state.status !== 'playing') return;
    locked = true;
    stopClock();
    state = E.expireCard(state, game);
    verdict('time');
  }

  function verdict(how) {
    const last = state.last;
    const c = byId.get(last.id);
    const right = choices.find((x) => x.id === c.answer);
    hud();
    ring.hidden = true;
    if (last.correct) {
      const b = buckets.get(last.choice);
      if (b) b.dataset.flash = 'right';
      card.dataset.result = 'right';
      if (!env.still) card.dataset.fly = buckets.get(last.choice)?.dataset.side ?? 'slot';
      const n = state.streak;
      sh.play(n >= 3 ? 'register' : 'ping');
      sh.react(n >= 3 ? 'surprised' : 'pleased', n >= 3 ? `${n} in a row!` : CHEERS[(state.cleared.length - 1) % CHEERS.length]);
      sh.say(`Right: ${right.label}. Plus ${last.points}.${n >= 2 ? ` ${n} in a row.` : ''}`);
      sh.later(() => advance(), env.delay(DELAY.right));
      return;
    }
    if (last.choice) {
      const b = buckets.get(last.choice);
      if (b) b.dataset.flash = 'wrong';
    }
    const rb = buckets.get(right.id);
    if (rb) rb.dataset.flash = 'answer';
    card.dataset.result = 'wrong';
    if (!env.still) card.classList.add('game-shake');
    sh.play('thud');
    const why = c.why ?? `That one is: ${right.label}.`;
    const head = last.timedOut ? 'Time is up.' : 'Not quite.';
    sh.react(last.timedOut ? 'surprised' : 'worried', `${head} ${why}`);
    const hearts = state.lives === 0 ? 'No hearts left.' : `${plural(state.lives, 'heart', 'hearts')} left.`;
    sh.say(`${head} It goes to: ${right.label}. ${c.why ?? ''} ${hearts}`.replace(/\s+/g, ' '));
    const answer = make('p', 'game-card-answer', `→ ${right.label}`);
    card.append(answer);
    waiting = true;
    next.textContent = state.status === 'lost' ? 'See how you did' : 'Next card';
    next.hidden = false;
    next.focus();
  }

  function advance() {
    if (!state) return;
    waiting = false;
    next.hidden = true;
    if (state.status !== 'playing') return finish();
    deal();
  }

  function finish() {
    stopClock();
    locked = true;
    const won = state.status === 'won';
    if (won) {
      // The round's placement agrees with the old graders: every card where it belongs.
      const placed = E.placementOf(state, game);
      const ok = game.kind === 'flag' ? gradeFlag(game, placed).correct : gradeSort(game, placed).correct;
      if (!ok) return;
    }
    const stars = E.starsFor({ won, mistakes: state.mistakes });
    const recap = deck.map((c) => {
      const misses = state.misses[c.id] ?? 0;
      return {
        text: c.text,
        answer: choices.find((x) => x.id === c.answer)?.label ?? '',
        why: c.why,
        ok: misses === 0 && state.cleared.includes(c.id),
        note: misses > 0 ? `missed ${plural(misses, 'time', 'times')}` : state.cleared.includes(c.id) ? '' : 'not reached',
      };
    });
    sh.end({
      won,
      stars,
      score: state.score,
      title: won ? (state.mistakes === 0 ? 'Perfect round!' : 'Round cleared!') : 'Out of hearts',
      line: won ? `Best streak: ${state.bestStreak}. Mistakes: ${state.mistakes}.` : 'A wrong card costs a heart and comes back later. Have another go.',
      recap,
      onReplay: () => sh.countIn(startRound),
    });
    if (won) report(rounds);
  }

  // --- keys and dragging -------------------------------------------------------
  sh.root.addEventListener('keydown', (e) => {
    if (sh.root.dataset.phase !== 'play' || waiting || locked) return;
    if (e.target?.closest?.('.game-toggles, .game-skipbar')) return;
    const act = E.choiceKey(e.key, choices);
    if (!act) return;
    e.preventDefault();
    choose(act.choose, 'key');
  });

  function dragCard(el) {
    let drag = null;
    const T = 70;
    const target = (e, dx) => {
      if (two) return dx <= -T ? choices[0].id : dx >= T ? choices[1].id : null;
      const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(e.clientX, e.clientY) : null;
      return hit?.closest?.('.game-bucket')?.dataset.bucket ?? null;
    };
    const mark = (id) => {
      for (const [bid, b] of buckets) {
        if (bid === id) b.dataset.hover = 'true';
        else delete b.dataset.hover;
      }
    };
    el.addEventListener('pointerdown', (e) => {
      if (locked || waiting || e.button > 0) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      el.setPointerCapture?.(e.pointerId);
      el.dataset.dragging = 'true';
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      el.style.transform = `translate(${dx}px, ${dy * (two ? 0.25 : 1)}px) rotate(${(dx / 18).toFixed(1)}deg)`;
      mark(target(e, dx));
    });
    const up = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const hit = e.type === 'pointerup' ? target(e, dx) : null;
      drag = null;
      delete el.dataset.dragging;
      mark(null);
      if (hit) {
        // Leave the card where it was dropped; the verdict's own fly takes it from there.
        el.style.transform = '';
        choose(hit, 'drag');
      } else el.style.transform = '';
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  const n = choices.length;
  const secs = E.timerFor(game);
  sh.intro({
    rules: [
      n === 2
        ? `Each card goes left (${choices[0].label}) or right (${choices[1].label}). Drag it, tap a side, or press ← or →.`
        : `Each card goes in one of ${n} buckets. Drag it onto one, tap one, or press 1 to ${n}.`,
      `${plural(E.LIVES, 'heart', 'hearts')}: a wrong card costs one and comes back later.`,
      secs > 0 ? `${secs} seconds a card, and the faster you answer the more points. You can turn the timer off.` : 'Take your time: there is no clock.',
      'Answer several right in a row for a combo.',
    ],
    onStart: startRound,
  });

  return {
    test: {
      expire: () => expire(),
      state: () => state,
    },
    destroy() {
      stopClock();
    },
  };
}

// ---------------------------------------------------------------------------
// order-and-nest: the pipeline
// ---------------------------------------------------------------------------

const ACTIONS = [
  ['up', 'Move up', '↑'],
  ['down', 'Move down', '↓'],
  ['outdent', 'Nest less', '⇤'],
  ['indent', 'Nest under the step above', '⇥'],
];

function mountPipeline(game, sh, env, report) {
  const steps = Array.isArray(game.steps) ? game.steps : [];
  const text = new Map(steps.map((s) => [s.id, s.text]));
  const answer = outlineAnswer(game);
  let rows = [];
  let sends = 0;
  let solved = false;
  let busy = false;
  let grabbed = null;
  let held = null;
  let rounds = 0;
  const tiles = new Map();

  const arena = make('div', 'game-pipe');
  const hintId = `${sh.id}-pipehint`;
  const hint = make('p', 'game-keys', 'Drag a step, or focus it and press Space to pick it up, the arrows to move it (← and → nest it), and Space to drop it.');
  hint.id = hintId;
  const ends = (label, cls) => {
    const e = make('div', `game-pipe-end ${cls}`, label);
    e.setAttribute('aria-hidden', 'true');
    return e;
  };
  const list = make('ol', 'game-pipeline');
  list.setAttribute('aria-label', 'The pipeline, in order');
  const packet = make('div', 'game-packet');
  packet.setAttribute('aria-hidden', 'true');
  const track = make('div', 'game-pipe-track');
  track.append(ends('In', 'game-pipe-in'), list, ends('Out', 'game-pipe-out'), packet);
  const send = button('Send it through', { kind: 'accent' });
  send.classList.add('btn-lg', 'game-send');
  arena.append(hint, track, send);
  sh.stage.append(arena);

  function tile(id) {
    if (tiles.has(id)) return tiles.get(id);
    const li = make('li', 'game-tile');
    li.dataset.id = id;
    li.tabIndex = 0;
    li.setAttribute('aria-describedby', hintId);
    const node = make('span', 'game-tile-node');
    node.setAttribute('aria-hidden', 'true');
    const grip = make('span', 'game-tile-grip', '⋮⋮');
    grip.setAttribute('aria-hidden', 'true');
    const body = make('span', 'game-tile-text', text.get(id));
    const level = make('span', 'game-tile-level');
    const bar = make('span', 'game-tile-actions');
    for (const [action, name, sign] of ACTIONS) {
      const b = button(sign, { kind: 'ghost' });
      b.classList.add('btn-tiny', 'game-tile-btn');
      b.dataset.action = action;
      b.tabIndex = -1;
      b.setAttribute('aria-label', `${name}: ${text.get(id)}`);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        act(id, action, { focus: true });
      });
      bar.append(b);
    }
    li.append(node, grip, body, level, bar);
    drag(li, id);
    tiles.set(id, li);
    return li;
  }

  function render() {
    rows.forEach((r, i) => {
      const li = tile(r.id);
      li.style.setProperty('--depth', String(r.depth));
      li.dataset.depth = String(r.depth);
      if (grabbed === r.id) li.dataset.grabbed = 'true';
      else delete li.dataset.grabbed;
      li.querySelector('.game-tile-level').textContent = `Level ${r.depth + 1}`;
      li.setAttribute('aria-label', `Step ${i + 1} of ${rows.length}, level ${r.depth + 1}: ${text.get(r.id)}${grabbed === r.id ? ', picked up' : ''}`);
      for (const b of li.querySelectorAll('[data-action]')) {
        const a = b.dataset.action;
        const can = !solved && !busy && E.moveRow(rows, i, a).rows !== rows;
        b.disabled = !can;
      }
      // Moved only when out of place: moving a node takes the focus off it.
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
    });
    send.disabled = solved || busy;
  }

  function clearMarks() {
    for (const li of tiles.values()) {
      delete li.dataset.state;
      li.classList.remove('game-shake');
    }
    delete packet.dataset.at;
    delete packet.dataset.bounce;
    packet.hidden = true;
  }

  function act(id, action, { focus = false, quiet = false } = {}) {
    if (solved || busy) return;
    const i = rows.findIndex((r) => r.id === id);
    const moved = E.moveRow(rows, i, action);
    if (moved.rows === rows) return;
    rows = moved.rows;
    clearMarks();
    render();
    sh.play('pop');
    if (!quiet) {
      const r = rows[moved.at];
      sh.say(`${text.get(id)}: step ${moved.at + 1} of ${rows.length}, level ${r.depth + 1}.`);
    }
    if (focus) tiles.get(id)?.focus();
  }

  list.addEventListener('keydown', (e) => {
    if (sh.root.dataset.phase !== 'play') return;
    const li = e.target?.closest?.('.game-tile');
    if (!li || e.target !== li) return;
    const id = li.dataset.id;
    const k = E.tileKey(e.key, { grabbed: grabbed === id });
    if (!k) return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id === id);
    if (k === 'focus-prev' || k === 'focus-next') {
      const j = k === 'focus-prev' ? i - 1 : i + 1;
      if (rows[j]) tiles.get(rows[j].id).focus();
      return;
    }
    if (k === 'grab') {
      if (solved || busy) return;
      grabbed = id;
      held = rows.map((r) => ({ ...r }));
      render();
      li.focus();
      sh.say(`Picked up: ${text.get(id)}. Step ${i + 1}, level ${rows[i].depth + 1}. Arrows move it, Space drops it, Escape puts it back.`);
      return;
    }
    if (k === 'drop') {
      grabbed = null;
      held = null;
      render();
      const r = rows[i];
      sh.say(`Dropped: ${text.get(id)} at step ${i + 1}, level ${r.depth + 1}.`);
      li.focus();
      return;
    }
    if (k === 'cancel') {
      if (held) rows = held;
      grabbed = null;
      held = null;
      render();
      sh.say(`Put back: ${text.get(id)}.`);
      li.focus();
      return;
    }
    act(id, k, { quiet: false });
    li.focus();
  });

  function drag(li, id) {
    let d = null;
    li.addEventListener('pointerdown', (e) => {
      if (solved || busy || e.button > 0 || e.target?.closest?.('button')) return;
      const from = rows.findIndex((r) => r.id === id);
      d = { x: e.clientX, y: e.clientY, pid: e.pointerId, from, depth: rows[from].depth };
      li.setPointerCapture?.(e.pointerId);
      li.dataset.dragging = 'true';
    });
    li.addEventListener('pointermove', (e) => {
      if (!d || e.pointerId !== d.pid) return;
      li.style.transform = `translate(${e.clientX - d.x}px, ${e.clientY - d.y}px)`;
    });
    const up = (e) => {
      if (!d || e.pointerId !== d.pid) return;
      const dx = e.clientX - d.x;
      const done = e.type === 'pointerup';
      const from = d.from;
      const depth = d.depth + Math.round(dx / 40);
      d = null;
      delete li.dataset.dragging;
      li.style.transform = '';
      if (!done) return;
      // The row it lands on: the tile under the pointer's height.
      let to = from;
      const others = rows.map((r) => tiles.get(r.id));
      others.forEach((t, j) => {
        const box = t.getBoundingClientRect?.();
        if (!box || !box.height) return;
        if (e.clientY > box.top && e.clientY < box.bottom) to = j;
      });
      const placed = E.placeRow(rows, from, to, depth);
      if (JSON.stringify(placed) === JSON.stringify(rows)) return;
      rows = placed;
      clearMarks();
      render();
      sh.play('pop');
      const at = rows.findIndex((r) => r.id === id);
      sh.say(`${text.get(id)}: step ${at + 1} of ${rows.length}, level ${rows[at].depth + 1}.`);
    };
    li.addEventListener('pointerup', up);
    li.addEventListener('pointercancel', up);
  }

  function startRound() {
    rounds += 1;
    sends = 0;
    solved = false;
    busy = false;
    grabbed = null;
    held = null;
    sh.lives(null);
    sh.useTimer(false);
    sh.score(0);
    sh.streak(0);
    // Shuffled for display, never left in the answer order.
    let order = shuffle(steps.map((s) => s.id), env.seed + rounds);
    if (order.length > 1 && order.every((id, i) => id === answer[i]?.id)) order = [...order.slice(1), order[0]];
    rows = order.map((id) => ({ id, depth: 0 }));
    clearMarks();
    sh.progress(0, `0 of ${plural(rows.length, 'step', 'steps')} through`);
    sh.react(null, null);
    render();
    tiles.get(rows[0]?.id)?.focus();
  }

  send.addEventListener('click', () => {
    if (solved || busy) return;
    sends += 1;
    grabbed = null;
    held = null;
    clearMarks();
    const res = E.sendPipeline(game, rows);
    busy = true;
    render();
    const travel = (k) => {
      if (k >= res.passed) return land();
      const li = tiles.get(rows[k].id);
      li.dataset.state = 'pass';
      packet.hidden = false;
      packet.dataset.at = String(k);
      packet.style.top = `${(li.offsetTop ?? 0) + (li.offsetHeight ?? 0) / 2}px`;
      sh.play('pop');
      sh.later(() => travel(k + 1), env.delay(DELAY.packet));
    };
    const land = () => {
      busy = false;
      sh.progress(res.passed / rows.length, `${res.passed} of ${plural(rows.length, 'step', 'steps')} through`);
      if (res.correct) {
        solved = true;
        packet.dataset.at = 'out';
        render();
        sh.react('pleased', 'Straight through!');
        const score = E.orderScore(sends);
        sh.score(score);
        const ol = make('ol', 'game-recap-outline');
        for (const r of answer) {
          const li = make('li', 'game-recap-step', text.get(r.id));
          li.style.setProperty('--depth', String(r.depth));
          ol.append(li);
        }
        sh.end({
          won: true,
          stars: E.orderStars(sends),
          score,
          title: sends === 1 ? 'Straight through!' : 'Through the pipeline!',
          line: `It took ${plural(sends, 'send', 'sends')}.`,
          recap: ol,
          onReplay: () => sh.countIn(startRound),
        });
        report(rounds);
        return;
      }
      const bad = rows[res.stop];
      const li = bad ? tiles.get(bad.id) : null;
      if (li) {
        li.dataset.state = 'wrong';
        if (!env.still) li.classList.add('game-shake');
      }
      // The call stops where it bounced: at the wrong step (or the end, for a step missing).
      packet.hidden = false;
      packet.dataset.at = String(res.stop);
      packet.dataset.bounce = String(res.stop);
      if (li) packet.style.top = `${(li.offsetTop ?? 0) + (li.offsetHeight ?? 0) / 2}px`;
      if (!env.still) {
        packet.classList.remove('game-bounce');
        void packet.offsetWidth;
        packet.classList.add('game-bounce');
      }
      sh.play('thud');
      const where = `Step ${res.stop + 1}`;
      const msg = bad ? `${where} is out of place or at the wrong level: "${text.get(bad.id)}".` : 'A step is missing.';
      sh.react('worried', `The call bounced at step ${res.stop + 1}.`);
      sh.say(`Bounced. ${msg} ${res.passed} ${res.passed === 1 ? 'step went' : 'steps went'} through.`);
      render();
      li?.focus();
    };
    sh.react('surprised', 'Here it goes…');
    sh.later(() => travel(0), env.delay(DELAY.packet));
  });

  sh.intro({
    rules: [
      'Put the steps in the order of one call, top to bottom. Nest a step under the one it belongs to.',
      'Drag a step, or use its buttons. From the keyboard: Space picks a step up, the arrows move it (← and → nest it), Space drops it.',
      'Then send it through: the call stops and bounces at the first step out of place. Fewer sends, more stars.',
    ],
    onStart: startRound,
  });
  return { test: { rows: () => rows }, destroy() {} };
}

// ---------------------------------------------------------------------------
// sliders
// ---------------------------------------------------------------------------

function mountSliders(game, sh, env, report) {
  const inputs = Array.isArray(game.inputs) ? game.inputs : [];
  let values = {};
  let tries = 0;
  let rounds = 0;
  let solved = false;
  const ranges = [];

  const panel = make('div', 'game-sliders');
  const readout = make('output', 'game-readout');
  readout.setAttribute('aria-live', 'off');
  const readoutLabel = make('span', 'game-readout-label', game.readout?.label ?? 'Result');
  const readoutValue = make('strong', 'game-readout-value');
  readout.append(readoutLabel, document.createTextNode(': '), readoutValue);
  const target = game.target && Number.isFinite(game.target.value) ? game.target : null;
  const meter = make('div', 'game-meter');
  const meterFill = make('span', 'game-meter-fill');
  const meterText = make('span', 'game-meter-text');
  meter.append(make('span', 'game-meter-bar'), meterText);
  meter.firstChild.append(meterFill);
  meter.hidden = !target;

  const current = () => evalFormula(game, values);
  const refresh = () => {
    const v = current();
    readoutValue.textContent = formatReadout(game, v);
    if (target) {
      const c = E.closeness(game, v) ?? 0;
      meterFill.style.width = `${Math.round(c * 100)}%`;
      meterText.textContent = `Target ${formatReadout(game, target.value)}: ${Math.round(c * 100)}% there`;
      meter.dataset.hit = String(c >= 1);
      sh.progress(c * 0.5, `${Math.round(c * 100)}% of the way to the target`);
    }
  };

  for (const inp of inputs) {
    const field = make('div', 'game-slider');
    const inputId = `${sh.id}-${inp.id}`;
    const label = make('label', 'game-slider-label', inp.label);
    label.htmlFor = inputId;
    const range = make('input', 'game-range');
    range.type = 'range';
    range.id = inputId;
    range.min = String(inp.min);
    range.max = String(inp.max);
    range.step = String(inp.step);
    const cur = make('span', 'game-slider-value');
    const show = () => {
      const t = `${range.value}${inp.unit ? (inp.unit === '%' ? '%' : ` ${inp.unit}`) : ''}`;
      cur.textContent = t;
      range.setAttribute('aria-valuetext', t);
    };
    range.addEventListener('input', () => {
      values[inp.id] = Number(range.value);
      show();
      refresh();
    });
    const top = make('div', 'game-slider-top');
    top.append(label, cur);
    field.append(top, range);
    panel.append(field);
    ranges.push({ inp, range, show });
  }
  panel.append(readout, meter);

  const ask = make('div', 'game-ask');
  const askPrompt = make('p', 'game-ask-prompt', game.ask?.prompt ?? '');
  askPrompt.id = `${sh.id}-ask`;
  const opts = make('div', 'game-ask-options');
  opts.setAttribute('role', 'group');
  opts.setAttribute('aria-labelledby', askPrompt.id);
  const optionBtns = inputs.map((inp) => {
    const b = make('button', 'game-ask-option', inp.label);
    b.type = 'button';
    b.dataset.option = inp.id;
    b.addEventListener('click', () => pick(inp.id, b));
    opts.append(b);
    return b;
  });
  ask.append(askPrompt, opts);
  sh.stage.append(panel, ask);

  function pick(choice, btn) {
    if (solved) return;
    tries += 1;
    if (gradeAsk(game, choice)) {
      solved = true;
      btn.dataset.result = 'right';
      for (const b of optionBtns) b.disabled = true;
      const close = E.closeness(game, current());
      const score = E.slidersScore({ close, tries });
      sh.score(score, score);
      sh.progress(1, 'Done');
      sh.play('ping');
      sh.react('pleased', 'Exactly.');
      const right = inputs.find((i) => i.id === game.ask.answer);
      sh.end({
        won: true,
        stars: E.slidersStars({ close, tries }),
        score,
        title: tries === 1 ? 'First time!' : 'Got it!',
        line: target ? `Readout ${formatReadout(game, current())}, target ${formatReadout(game, target.value)}. Answered in ${plural(tries, 'try', 'tries')}.` : `Answered in ${plural(tries, 'try', 'tries')}.`,
        recap: [{ text: game.ask?.prompt ?? '', answer: right?.label ?? '', ok: tries === 1 }],
        onReplay: () => sh.countIn(startRound),
      });
      report(rounds);
      return;
    }
    btn.dataset.result = 'wrong';
    btn.disabled = true;
    if (!env.still) {
      btn.classList.remove('game-shake');
      void btn.offsetWidth;
      btn.classList.add('game-shake');
    }
    sh.play('thud');
    sh.react('worried', 'Not that one. Move each slider on its own and watch the readout.');
    sh.say(`Not quite: not ${inputs.find((i) => i.id === choice)?.label}. Try another.`);
  }

  function startRound() {
    rounds += 1;
    tries = 0;
    solved = false;
    values = Object.fromEntries(inputs.map((i) => [i.id, Number(i.default)]));
    for (const { inp, range, show } of ranges) {
      range.value = String(inp.default);
      show();
    }
    for (const b of optionBtns) {
      b.disabled = false;
      delete b.dataset.result;
      b.classList.remove('game-shake');
    }
    sh.lives(null);
    sh.useTimer(false);
    sh.score(0);
    sh.streak(0);
    sh.progress(0, 'Not answered yet');
    sh.react(null, null);
    refresh();
    ranges[0]?.range.focus();
  }

  sh.intro({
    rules: [
      target ? `Move the sliders until ${game.readout?.label ?? 'the readout'} reads ${formatReadout(game, target.value)}: the closer, the more points.` : `Move the sliders and watch ${game.readout?.label ?? 'the readout'}.`,
      'Then pick the slider that moves it most. Right first time is three stars.',
    ],
    onStart: startRound,
  });
  return { test: {}, destroy() {} };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Draws `game` into `host` (replacing what was there). See the top of this file for the options.
 * Returns { root, destroy }; in test mode `root.gameTest` exposes the round (and a sort or flag card's `expire()`).
 */
export function mountGame(host, game, opts = {}) {
  const env = envOf(opts);
  const sh = shell(game, env, opts);
  const report = (tries) => opts.onResult?.({ id: game.id, solved: true, tries });
  let kind = null;
  switch (game.kind) {
    case 'sort':
    case 'flag':
      kind = mountCards(game, sh, env, report);
      break;
    case 'sliders':
      kind = mountSliders(game, sh, env, report);
      break;
    case 'order-and-nest':
      kind = mountPipeline(game, sh, env, report);
      break;
    default:
      sh.root.replaceChildren(make('p', 'game-status', 'This game is not available in this version of the console.'));
  }
  if (env.testMode && kind) sh.root.gameTest = kind.test;
  host.replaceChildren(sh.root);
  return {
    root: sh.root,
    destroy() {
      sh.cancelAll();
      kind?.destroy();
      sh.root.remove();
    },
  };
}
