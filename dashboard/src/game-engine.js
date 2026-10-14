/**
 * The rules of the warm-up games, with no DOM: what a round is, what an answer scores, when a heart is
 * lost, how many stars a finished round earns, which keys do what. games.js draws and plays them; every
 * decision it makes about right, wrong, points and the end of a round is one of these pure functions, so
 * the unit tests can play a whole round without a browser.
 *
 *   sort, flag        a round is a deck of cards dealt one at a time. Each card goes to one of the game's
 *                     choices (a sort's buckets; a flag's "leave it" and "flag it"). Right: points, the streak
 *                     grows, the card is cleared. Wrong, or the card's clock runs out: a heart is lost, the
 *                     streak resets, and the card goes to the back of the deck to be answered again. The
 *                     round is won when the deck is empty, lost when the hearts are gone.
 *   order-and-nest    "what happens next": the steps are shown shuffled, and the learner taps the one that
 *                     happens next, again and again, until the route is complete. The right order is the
 *                     yaml's tree flattened depth first (orderOf). A right tap places the step (points, the
 *                     streak grows); a wrong one, or the step's clock running out, costs a heart and the step
 *                     stays in the pool. The hearts, points, combo and stars are the card games'.
 *   sliders           dial the readout (to the `target` when the game has one), then answer which slider
 *                     moves it most. No hearts: the stars count the answers.
 */

import { shuffle, outlineAnswer, evalFormula } from './game-grade.js';

/** Hearts a sort or flag round starts with. */
export const LIVES = 3;
/** Points for a right card before the speed bonus and the combo. */
export const BASE_POINTS = 100;
/** The most a right card earns for speed: all of it when answered at once, none when the clock is nearly out. */
export const SPEED_POINTS = 50;
/** The streak at which the combo stops growing (x1, x1.25, ... x2). */
export const COMBO_CAP = 5;
/** Seconds a card (a step, for order-and-nest) stays on the clock when a game names no `timer`. A `timer: 0` turns the clock off. */
export const DEFAULT_TIMER = { sort: 8, flag: 10, 'order-and-nest': 15 };
export const MAX_TIMER = 60;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** The combo multiplier for a streak (the streak counts the answer being scored): 1, 1.25, 1.5, 1.75, 2. */
export function comboFor(streak) {
  const s = Math.max(1, Math.floor(Number(streak) || 1));
  return 1 + (Math.min(s, COMBO_CAP) - 1) * 0.25;
}

/** Points for a right card: the base, plus the share of the clock left as a speed bonus, times the combo. */
export function pointsFor({ streak = 1, left = 0, limit = 0 } = {}) {
  const speed = limit > 0 ? Math.round(SPEED_POINTS * clamp(left / limit, 0, 1)) : 0;
  return Math.round((BASE_POINTS + speed) * comboFor(streak));
}

/** Stars for a finished sort, flag or order-and-nest round: 3 with no mistake, 2 with one, 1 with more; 0 for a lost round. */
export function starsFor({ won, mistakes }) {
  if (!won) return 0;
  return mistakes <= 0 ? 3 : mistakes === 1 ? 2 : 1;
}

/** The seconds each card gets, or 0 for no clock: off by the learner (`enabled: false`), by `timer: 0`, or for a kind without one. */
export function timerFor(game, { enabled = true } = {}) {
  if (!enabled || !game) return 0;
  if (game.timer === 0) return 0;
  if (Number.isFinite(game.timer) && game.timer > 0) return clamp(Math.round(game.timer), 1, MAX_TIMER);
  return DEFAULT_TIMER[game.kind] ?? 0;
}

// ---------------------------------------------------------------------------
// Sort and flag: a deck of cards and the choices they go to
// ---------------------------------------------------------------------------

/** The words of a flag game's two choices: the yaml's `choices`, or plain ones. */
export const FLAG_WORDS = { flag: 'Flag it', leave: 'Leave it' };

/**
 * The choices a card can go to, left to right: a sort's buckets in the yaml's order; a flag's
 * "leave" (left) and "flag" (right), so a swipe right means yes.
 */
export function choicesOf(game) {
  if (game?.kind === 'flag') {
    const words = { ...FLAG_WORDS, ...(game.choices ?? {}) };
    return [
      { id: 'leave', label: words.leave },
      { id: 'flag', label: words.flag },
    ];
  }
  return (Array.isArray(game?.buckets) ? game.buckets : []).map((b) => ({ id: b.id, label: b.label }));
}

/** The cards of a sort or flag game as { id, text, answer, why? }: `answer` is the id of the choice it goes to. */
export function deckOf(game) {
  if (game?.kind === 'flag') {
    return (Array.isArray(game.items) ? game.items : []).map((i) => ({ id: i.id, text: i.text, answer: i.flag === true ? 'flag' : 'leave', ...(i.why ? { why: i.why } : {}) }));
  }
  return (Array.isArray(game?.cards) ? game.cards : []).map((c) => ({ id: c.id, text: c.text, answer: c.bucket, ...(c.why ? { why: c.why } : {}) }));
}

/**
 * A fresh round: the deck shuffled by `seed`, every heart, no points.
 *   queue      the card ids still to answer, the one on show first
 *   cleared    the ids answered right, in that order
 *   misses     { id: times answered wrong or timed out }
 *   first      { id: the first choice given for it; null when its clock ran out first }
 *   status     'playing' | 'won' | 'lost'
 *   last       the latest answer: { id, choice, correct, points, timedOut } (null before any)
 */
export function newRound(game, { seed = 1, lives = LIVES } = {}) {
  const ids = deckOf(game).map((c) => c.id);
  return {
    queue: shuffle(ids, seed),
    total: ids.length,
    cleared: [],
    lives,
    maxLives: lives,
    score: 0,
    streak: 0,
    bestStreak: 0,
    mistakes: 0,
    misses: {},
    first: {},
    status: ids.length ? 'playing' : 'won',
    last: null,
  };
}

/** The card on show, or null when the round is over. */
export const currentCard = (state) => (state.status === 'playing' ? (state.queue[0] ?? null) : null);

/**
 * Answers the card on show with `choice` (a choice id; null when its clock ran out). `left` and `limit`
 * are the clock's seconds left and its length, for the speed bonus (0 and 0 with no clock).
 * Returns the next state; the state passed in is not changed. Answering a finished round changes nothing.
 */
export function answerCard(state, game, choice, { left = 0, limit = 0 } = {}) {
  const id = currentCard(state);
  if (id === null) return state;
  const card = deckOf(game).find((c) => c.id === id);
  const correct = choice !== null && choice !== undefined && card?.answer === choice;
  const next = {
    ...state,
    queue: state.queue.slice(1),
    cleared: [...state.cleared],
    misses: { ...state.misses },
    first: { ...state.first },
  };
  if (!Object.hasOwn(next.first, id)) next.first[id] = choice ?? null;
  let points = 0;
  if (correct) {
    next.streak = state.streak + 1;
    next.bestStreak = Math.max(state.bestStreak, next.streak);
    points = pointsFor({ streak: next.streak, left, limit });
    next.score = state.score + points;
    next.cleared.push(id);
  } else {
    next.streak = 0;
    next.lives = Math.max(0, state.lives - 1);
    next.mistakes = state.mistakes + 1;
    next.misses[id] = (state.misses[id] ?? 0) + 1;
    // Wrong cards come back at the end of the deck: the round is only won with every card in its place.
    next.queue.push(id);
  }
  if (next.lives <= 0) next.status = 'lost';
  else if (next.queue.length === 0) next.status = 'won';
  next.last = { id, choice: choice ?? null, correct, points, timedOut: choice === null || choice === undefined };
  return next;
}

/** The card's clock ran out: the same as a wrong answer, with no choice. */
export const expireCard = (state, game) => answerCard(state, game, null);

/** Share of the deck cleared, 0 to 1. */
export const progressOf = (state) => (state.total ? state.cleared.length / state.total : 1);

/**
 * What a won round placed where, in the shape the old graders take: a sort's `{ card: bucket }` and a
 * flag's list of flagged ids. Every cleared card went where it belongs, so gradeSort / gradeFlag agree.
 */
export function placementOf(state, game) {
  const byId = new Map(deckOf(game).map((c) => [c.id, c]));
  if (game?.kind === 'flag') return state.cleared.filter((id) => byId.get(id)?.answer === 'flag');
  return Object.fromEntries(state.cleared.map((id) => [id, byId.get(id)?.answer]));
}

// ---------------------------------------------------------------------------
// Order and nest: tap what happens next
// ---------------------------------------------------------------------------

/**
 * The steps of an order-and-nest game in the order they happen: its tree (`parent`, `order`) flattened depth
 * first, siblings by `order`. Takes the game or its list of steps; returns the step ids. The nesting stays in
 * the yaml (it is how the steps were written) but is not asked of the learner: only this order is.
 */
export function orderOf(gameOrSteps) {
  const game = Array.isArray(gameOrSteps) ? { steps: gameOrSteps } : gameOrSteps;
  return outlineAnswer(game).map((r) => r.id);
}

/** Is `id` the step that happens right after the `placed` ones (ids, in order)? `order` is orderOf's list. */
export function isNextStep(order, placed, id) {
  const done = Array.isArray(placed) ? placed : [];
  const list = Array.isArray(order) ? order : [];
  if (done.some((p, i) => list[i] !== p)) return false;
  return typeof id === 'string' && id !== '' && list[done.length] === id;
}

/**
 * A fresh round of "what happens next": the steps shuffled into the pool by `seed` (never left in the right
 * order), every heart, no points.
 *   order      the step ids in the order they happen (the answer)
 *   placed     the ids placed so far, in order
 *   pool       the ids still to place, as the cards are shown
 *   misses     { step id: wrong taps (or clocks run out) while it was the next step }
 *   status     'playing' | 'won' | 'lost'
 *   last       the latest answer: { id, expected, correct, points, timedOut } (null before any)
 */
export function newOrderRound(game, { seed = 1, lives = LIVES } = {}) {
  const order = orderOf(game);
  let pool = shuffle(order, seed);
  if (pool.length > 1 && pool.every((id, i) => id === order[i])) pool = [...pool.slice(1), pool[0]];
  return {
    order,
    placed: [],
    pool,
    total: order.length,
    lives,
    maxLives: lives,
    score: 0,
    streak: 0,
    bestStreak: 0,
    mistakes: 0,
    misses: {},
    status: order.length ? 'playing' : 'won',
    last: null,
  };
}

/** The step that must be placed next, or null when the round is over. */
export const nextStep = (state) => (state.status === 'playing' ? (state.order[state.placed.length] ?? null) : null);

/**
 * Taps the step `id` from the pool (null when the step's clock ran out). Right: it is placed, points (the
 * card games' points: base, speed, combo), the streak grows. Wrong: a heart is lost, the streak resets and the
 * step stays in the pool. Returns the next state; the state passed in is not changed. A tap on a step that
 * is not in the pool, or on a finished round, changes nothing.
 */
export function pickStep(state, id, { left = 0, limit = 0 } = {}) {
  const expected = nextStep(state);
  if (expected === null) return state;
  const timedOut = id === null || id === undefined;
  if (!timedOut && !state.pool.includes(id)) return state;
  const correct = !timedOut && isNextStep(state.order, state.placed, id);
  const next = { ...state, placed: [...state.placed], pool: [...state.pool], misses: { ...state.misses } };
  let points = 0;
  if (correct) {
    next.placed.push(id);
    next.pool = next.pool.filter((p) => p !== id);
    next.streak = state.streak + 1;
    next.bestStreak = Math.max(state.bestStreak, next.streak);
    points = pointsFor({ streak: next.streak, left, limit });
    next.score = state.score + points;
  } else {
    next.streak = 0;
    next.lives = Math.max(0, state.lives - 1);
    next.mistakes = state.mistakes + 1;
    next.misses[expected] = (state.misses[expected] ?? 0) + 1;
  }
  if (next.lives <= 0) next.status = 'lost';
  else if (next.placed.length === next.total) next.status = 'won';
  next.last = { id: timedOut ? null : id, expected, correct, points, timedOut };
  return next;
}

/** The step's clock ran out: the same as a wrong tap. */
export const expireStep = (state) => pickStep(state, null);

/** What a key does in the pool: the 1-based number of the card it picks (1 to 9, up to `count`), or 0. */
export function stepKey(key, count) {
  const n = /^[1-9]$/.test(String(key)) ? Number(key) : 0;
  return n >= 1 && n <= count ? n : 0;
}

// ---------------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------------

/** The smallest and largest readout the sliders can make (every slider at its min or max), finite values only. */
export function readoutRange(game) {
  const inputs = Array.isArray(game?.inputs) ? game.inputs : [];
  let lo = Infinity;
  let hi = -Infinity;
  const n = Math.min(inputs.length, 6);
  for (let mask = 0; mask < 1 << n; mask++) {
    const values = Object.fromEntries(inputs.slice(0, n).map((inp, b) => [inp.id, mask & (1 << b) ? inp.max : inp.min]));
    const v = evalFormula(game, values);
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return Number.isFinite(lo) ? { min: lo, max: hi } : { min: 0, max: 0 };
}

/**
 * How close a readout is to the game's `target`, 0 to 1 (1 within its tolerance), measured against the
 * readout's whole range. null for a game with no target.
 */
export function closeness(game, value) {
  const t = game?.target;
  if (!t || !Number.isFinite(t.value)) return null;
  if (!Number.isFinite(value)) return 0;
  const tol = Number.isFinite(t.tolerance) && t.tolerance > 0 ? t.tolerance : 0;
  const off = Math.abs(value - t.value) - tol;
  if (off <= 0) return 1;
  const { min, max } = readoutRange(game);
  const span = Math.max(max - min, Math.abs(t.value), 1e-9);
  return clamp(1 - off / span, 0, 1);
}

/** Points for a sliders game: up to 500 for closeness (500 with no target), and 500, 250 or 100 for the answer by its try. */
export function slidersScore({ close = null, tries = 1 } = {}) {
  const dial = close === null ? 500 : Math.round(500 * clamp(close, 0, 1));
  const ask = [500, 250, 100][clamp(tries, 1, 3) - 1];
  return dial + ask;
}

/** Stars for a sliders game: 3 for the answer first time (and the target within 90%), 2 by the second try, else 1. */
export function slidersStars({ close = null, tries = 1 } = {}) {
  if (tries <= 1 && (close === null || close >= 0.9)) return 3;
  return tries <= 2 ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * What a key does on a sort or flag card: { choose: choice id } or null. With two choices ← and → pick
 * the left and the right; with any number, 1 to 4 pick by position.
 */
export function choiceKey(key, choices) {
  const list = Array.isArray(choices) ? choices : [];
  if (list.length === 2 && key === 'ArrowLeft') return { choose: list[0].id };
  if (list.length === 2 && key === 'ArrowRight') return { choose: list[1].id };
  const n = /^[1-9]$/.test(key) ? Number(key) : 0;
  if (n >= 1 && n <= list.length) return { choose: list[n - 1].id };
  return null;
}

// ---------------------------------------------------------------------------
// Best scores (kept in this browser only)
// ---------------------------------------------------------------------------

export const BEST_KEY = 'opalix.gameBest';

/** A game's key among the best scores: its id and a hash of its title (ids are only unique inside one lab). */
export function bestId(game) {
  let h = 0;
  for (const ch of String(game?.title ?? '')) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0;
  return `${game?.id ?? 'game'}:${(h >>> 0).toString(36)}`;
}

/** The best score kept for `game` in `storage` (a Storage, or null), 0 when none or storage throws. */
export function readBest(storage, game) {
  try {
    const all = JSON.parse(storage?.getItem(BEST_KEY) ?? '{}');
    const v = all && typeof all === 'object' ? all[bestId(game)] : 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

/** Keeps `score` when it beats the best. Returns { best, isNew }; storage that throws keeps nothing. */
export function writeBest(storage, game, score) {
  const before = readBest(storage, game);
  if (!(score > before)) return { best: before, isNew: false };
  try {
    let all = {};
    try {
      all = JSON.parse(storage?.getItem(BEST_KEY) ?? '{}') || {};
    } catch {
      all = {};
    }
    if (typeof all !== 'object' || Array.isArray(all)) all = {};
    all[bestId(game)] = score;
    storage?.setItem(BEST_KEY, JSON.stringify(all));
  } catch {
    /* a private window just forgets */
  }
  return { best: score, isNew: true };
}
