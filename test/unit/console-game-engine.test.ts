import { describe, it, expect } from 'vitest';

/**
 * The rules of the warm-up games (dashboard/src/game-engine.js), pure: points, combo, hearts, stars, the
 * clock running out, the deck, the pipeline's first wrong step, closeness, keys and the best score.
 */
type Game = Record<string, any>;
const E = (await import('../../dashboard/src/game-engine.js' as string)) as Record<string, any>;
const grade = (await import('../../dashboard/src/game-grade.js' as string)) as Record<string, any>;

const sortGame: Game = {
  id: 'sort-1',
  kind: 'sort',
  title: 'Sort',
  buckets: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
  cards: [
    { id: 'c1', text: 'one', bucket: 'a', why: 'One is A.' },
    { id: 'c2', text: 'two', bucket: 'b' },
    { id: 'c3', text: 'three', bucket: 'a' },
  ],
};
const flagGame: Game = {
  id: 'flag-1',
  kind: 'flag',
  title: 'Flag',
  choices: { flag: 'Keeps answering', leave: 'Goes dark' },
  items: [
    { id: 'i1', text: 'x', flag: true, why: 'because' },
    { id: 'i2', text: 'y', flag: false },
    { id: 'i3', text: 'z', flag: true },
  ],
};
const outlineGame: Game = {
  id: 'on-1',
  kind: 'order-and-nest',
  title: 'Order',
  steps: [
    { id: 'r', text: 'r', parent: null, order: 0 },
    { id: 'a', text: 'a', parent: 'r', order: 0 },
    { id: 'b', text: 'b', parent: 'r', order: 1 },
  ],
};
const answerOf = (g: Game, id: string) => E.deckOf(g).find((c: any) => c.id === id).answer;

/** Plays a round, answering each card with `pick(id)`. */
function play(g: Game, pick: (id: string, s: any) => string | null, seed = 1) {
  let s = E.newRound(g, { seed });
  for (let guard = 0; s.status === 'playing' && guard < 50; guard++) {
    const id = E.currentCard(s);
    const choice = pick(id, s);
    s = choice === null ? E.expireCard(s, g) : E.answerCard(s, g, choice);
  }
  return s;
}

describe('scoring', () => {
  it('combo grows by a quarter for each card in a row, up to x2', () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(E.comboFor)).toEqual([1, 1.25, 1.5, 1.75, 2, 2, 2]);
    expect(E.comboFor(0)).toBe(1);
  });
  it('points are the base, plus the speed bonus for the clock left, times the combo', () => {
    expect(E.pointsFor({ streak: 1 })).toBe(100);
    expect(E.pointsFor({ streak: 1, left: 8, limit: 8 })).toBe(150);
    expect(E.pointsFor({ streak: 1, left: 4, limit: 8 })).toBe(125);
    expect(E.pointsFor({ streak: 1, left: 0, limit: 8 })).toBe(100);
    expect(E.pointsFor({ streak: 3, left: 4, limit: 8 })).toBe(Math.round(125 * 1.5));
    expect(E.pointsFor({ streak: 1, left: 99, limit: 8 })).toBe(150);
  });
  it('stars: 3 with no mistake, 2 with one, 1 with more, 0 for a lost round', () => {
    expect(E.starsFor({ won: true, mistakes: 0 })).toBe(3);
    expect(E.starsFor({ won: true, mistakes: 1 })).toBe(2);
    expect(E.starsFor({ won: true, mistakes: 2 })).toBe(1);
    expect(E.starsFor({ won: false, mistakes: 0 })).toBe(0);
  });
  it('the timer: the default per kind, the yaml, 0 for none, and off when the learner turns it off', () => {
    expect(E.timerFor(sortGame)).toBe(8);
    expect(E.timerFor(flagGame)).toBe(10);
    expect(E.timerFor({ ...sortGame, timer: 12 })).toBe(12);
    expect(E.timerFor({ ...sortGame, timer: 0 })).toBe(0);
    expect(E.timerFor({ ...sortGame, timer: 500 })).toBe(E.MAX_TIMER);
    expect(E.timerFor(sortGame, { enabled: false })).toBe(0);
    expect(E.timerFor(outlineGame)).toBe(0);
  });
});

describe('a round of cards', () => {
  it('deals every card once, shuffled by the seed, with every heart', () => {
    const s = E.newRound(sortGame, { seed: 3 });
    expect([...s.queue].sort()).toEqual(['c1', 'c2', 'c3']);
    expect(E.newRound(sortGame, { seed: 3 }).queue).toEqual(s.queue);
    expect(s).toMatchObject({ lives: 3, score: 0, streak: 0, status: 'playing', total: 3 });
  });

  it('a flag game deals its items to "leave" (left) and "flag" (right), in the words of `choices`', () => {
    expect(E.choicesOf(flagGame)).toEqual([
      { id: 'leave', label: 'Goes dark' },
      { id: 'flag', label: 'Keeps answering' },
    ]);
    expect(E.choicesOf({ ...flagGame, choices: undefined }).map((c: any) => c.label)).toEqual(['Leave it', 'Flag it']);
    expect(E.deckOf(flagGame).map((c: any) => c.answer)).toEqual(['flag', 'leave', 'flag']);
    expect(E.choicesOf(sortGame).map((c: any) => c.id)).toEqual(['a', 'b']);
  });

  it('all right: won, a growing streak and combo, 3 stars, and the old grader agrees', () => {
    const s = play(sortGame, (id) => answerOf(sortGame, id));
    expect(s.status).toBe('won');
    expect(s.mistakes).toBe(0);
    expect(s.bestStreak).toBe(3);
    expect(s.score).toBe(100 + 125 + 150);
    expect(E.progressOf(s)).toBe(1);
    expect(grade.gradeSort(sortGame, E.placementOf(s, sortGame)).correct).toBe(true);
    expect(E.starsFor({ won: true, mistakes: s.mistakes })).toBe(3);
  });

  it('a wrong card costs a heart, resets the streak and comes back at the end of the deck', () => {
    let s = E.newRound(sortGame, { seed: 1 });
    const first = E.currentCard(s);
    const wrong = answerOf(sortGame, first) === 'a' ? 'b' : 'a';
    s = E.answerCard(s, sortGame, wrong);
    expect(s.lives).toBe(2);
    expect(s.streak).toBe(0);
    expect(s.mistakes).toBe(1);
    expect(s.misses).toEqual({ [first]: 1 });
    expect(s.first[first]).toBe(wrong);
    expect(s.queue[s.queue.length - 1]).toBe(first);
    expect(s.last).toMatchObject({ id: first, correct: false, points: 0, timedOut: false });
    // Answering the rest right still wins, with 2 stars.
    s = play(sortGame, (id) => answerOf(sortGame, id));
    const won = (() => {
      let st = E.newRound(sortGame, { seed: 1 });
      st = E.answerCard(st, sortGame, wrong);
      while (st.status === 'playing') st = E.answerCard(st, sortGame, answerOf(sortGame, E.currentCard(st)));
      return st;
    })();
    expect(won.status).toBe('won');
    expect(E.starsFor({ won: true, mistakes: won.mistakes })).toBe(2);
    expect(won.first[first]).toBe(wrong);
  });

  it('the clock running out is a miss with no choice: a heart lost', () => {
    let s = E.newRound(flagGame, { seed: 2 });
    const id = E.currentCard(s);
    s = E.expireCard(s, flagGame);
    expect(s.lives).toBe(2);
    expect(s.last).toMatchObject({ id, choice: null, correct: false, timedOut: true });
    expect(s.first[id]).toBeNull();
  });

  it('three misses lose the round, and a lost round takes no more answers', () => {
    const s = play(sortGame, () => null);
    expect(s.status).toBe('lost');
    expect(s.lives).toBe(0);
    expect(E.starsFor({ won: false, mistakes: s.mistakes })).toBe(0);
    expect(E.currentCard(s)).toBeNull();
    expect(E.answerCard(s, sortGame, 'a')).toBe(s);
  });

  it('the speed bonus counts the clock left on the answer', () => {
    let s = E.newRound(sortGame, { seed: 1 });
    s = E.answerCard(s, sortGame, answerOf(sortGame, E.currentCard(s)), { left: 8, limit: 8 });
    expect(s.last.points).toBe(150);
  });

  it('a won flag round agrees with gradeFlag', () => {
    const s = play(flagGame, (id) => answerOf(flagGame, id));
    expect(s.status).toBe('won');
    expect(grade.gradeFlag(flagGame, E.placementOf(s, flagGame)).correct).toBe(true);
  });
});

describe('the pipeline (order-and-nest)', () => {
  const solved = [
    { id: 'r', depth: 0 },
    { id: 'a', depth: 1 },
    { id: 'b', depth: 1 },
  ];
  it('finds the first step out of place or at the wrong level', () => {
    expect(E.firstWrong(outlineGame, solved)).toBe(-1);
    expect(E.firstWrong(outlineGame, [solved[0], solved[2], solved[1]])).toBe(1);
    expect(E.firstWrong(outlineGame, [solved[0], { id: 'a', depth: 0 }, solved[2]])).toBe(1);
    expect(E.firstWrong(outlineGame, [{ id: 'a', depth: 0 }, solved[0], solved[2]])).toBe(0);
    expect(E.firstWrong(outlineGame, solved.slice(0, 2))).toBe(2);
  });
  it('a send goes through when every step is right, and stops at the first wrong one', () => {
    expect(E.sendPipeline(outlineGame, solved)).toEqual({ correct: true, stop: -1, passed: 3 });
    expect(E.sendPipeline(outlineGame, [solved[0], { id: 'b', depth: 1 }, { id: 'a', depth: 1 }])).toEqual({ correct: false, stop: 1, passed: 1 });
  });
  it('stars and points by the sends', () => {
    expect([1, 2, 3, 9].map(E.orderStars)).toEqual([3, 2, 1, 1]);
    expect([1, 2, 3, 4, 9].map(E.orderScore)).toEqual([1000, 750, 500, 250, 250]);
  });
  it('moves rows and keeps the outline drawable', () => {
    const rows = [
      { id: 'a', depth: 0 },
      { id: 'r', depth: 0 },
      { id: 'b', depth: 0 },
    ];
    const up = E.moveRow(rows, 1, 'up');
    expect(up.at).toBe(0);
    expect(up.rows.map((r: any) => r.id)).toEqual(['r', 'a', 'b']);
    const nested = E.moveRow(up.rows, 1, 'indent');
    expect(nested.rows[1].depth).toBe(1);
    // Cannot nest twice under the row above, nor nest the first row, nor move past an end.
    expect(E.moveRow(nested.rows, 1, 'indent').rows).toBe(nested.rows);
    expect(E.moveRow(rows, 0, 'indent').rows).toBe(rows);
    expect(E.moveRow(rows, 0, 'up').rows).toBe(rows);
    expect(E.moveRow(rows, 2, 'down').rows).toBe(rows);
    // Moving a parent up leaves its child no deeper than one under the row above.
    expect(E.clampRows([{ id: 'x', depth: 2 }, { id: 'y', depth: 3 }])).toEqual([
      { id: 'x', depth: 0 },
      { id: 'y', depth: 1 },
    ]);
    expect(E.placeRow(rows, 1, 0, 0).map((r: any) => r.id)).toEqual(['r', 'a', 'b']);
    expect(E.placeRow(rows, 2, 1, 5)).toEqual([
      { id: 'a', depth: 0 },
      { id: 'b', depth: 1 },
      { id: 'r', depth: 0 },
    ]);
  });
});

describe('sliders', () => {
  const sl: Game = {
    id: 'sl',
    kind: 'sliders',
    inputs: [
      { id: 'n', label: 'N', min: 0, max: 10, step: 1, default: 2 },
      { id: 'm', label: 'M', min: 0, max: 10, step: 1, default: 2 },
    ],
    formula: [
      { input: 'n', op: '*' },
      { input: 'm', op: '*' },
    ],
    readout: { label: 'R', unit: '', decimals: 0 },
    ask: { prompt: '?', answer: 'n' },
    target: { value: 50, tolerance: 2 },
  };
  it('the readout ranges over every slider at its ends', () => {
    expect(E.readoutRange(sl)).toEqual({ min: 0, max: 100 });
  });
  it('closeness is 1 within the tolerance and falls off over the range', () => {
    expect(E.closeness(sl, 50)).toBe(1);
    expect(E.closeness(sl, 52)).toBe(1);
    expect(E.closeness(sl, 62)).toBeCloseTo(0.9);
    expect(E.closeness(sl, 1000)).toBe(0);
    expect(E.closeness({ ...sl, target: undefined }, 50)).toBeNull();
    expect(E.closeness(sl, NaN)).toBe(0);
  });
  it('points and stars', () => {
    expect(E.slidersScore({ close: 1, tries: 1 })).toBe(1000);
    expect(E.slidersScore({ close: 0.5, tries: 2 })).toBe(500);
    expect(E.slidersScore({ close: null, tries: 5 })).toBe(600);
    expect(E.slidersStars({ close: 0.95, tries: 1 })).toBe(3);
    expect(E.slidersStars({ close: 0.5, tries: 1 })).toBe(2);
    expect(E.slidersStars({ close: null, tries: 2 })).toBe(2);
    expect(E.slidersStars({ close: null, tries: 3 })).toBe(1);
  });
});

describe('keys', () => {
  const two = E.choicesOf(sortGame);
  const four = [1, 2, 3, 4].map((i) => ({ id: `b${i}`, label: `B${i}` }));
  it('← and → pick the sides of a two-way game; 1 to n pick by place', () => {
    expect(E.choiceKey('ArrowLeft', two)).toEqual({ choose: 'a' });
    expect(E.choiceKey('ArrowRight', two)).toEqual({ choose: 'b' });
    expect(E.choiceKey('2', two)).toEqual({ choose: 'b' });
    expect(E.choiceKey('3', two)).toBeNull();
    expect(E.choiceKey('ArrowLeft', four)).toBeNull();
    expect(E.choiceKey('4', four)).toEqual({ choose: 'b4' });
    expect(E.choiceKey('x', four)).toBeNull();
  });
  it('a tile: Space picks it up and drops it, the arrows move it, Escape puts it back', () => {
    expect(E.tileKey(' ')).toBe('grab');
    expect(E.tileKey('Enter')).toBe('grab');
    expect(E.tileKey('ArrowDown')).toBe('focus-next');
    expect(E.tileKey('ArrowUp')).toBe('focus-prev');
    expect(E.tileKey('ArrowLeft')).toBeNull();
    expect(E.tileKey(' ', { grabbed: true })).toBe('drop');
    expect(E.tileKey('Escape', { grabbed: true })).toBe('cancel');
    expect(['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft'].map((k) => E.tileKey(k, { grabbed: true }))).toEqual(['up', 'down', 'indent', 'outdent']);
  });
});

describe('the best score', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it('keeps the highest score per game, keyed by id and title', () => {
    const s = memory();
    expect(E.readBest(s, sortGame)).toBe(0);
    expect(E.writeBest(s, sortGame, 300)).toEqual({ best: 300, isNew: true });
    expect(E.writeBest(s, sortGame, 200)).toEqual({ best: 300, isNew: false });
    expect(E.readBest(s, sortGame)).toBe(300);
    expect(E.readBest(s, { ...sortGame, title: 'Another lab' })).toBe(0);
  });
  it('storage that is missing or throws keeps nothing and never throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(E.readBest(bad, sortGame)).toBe(0);
    expect(E.writeBest(bad, sortGame, 10)).toEqual({ best: 10, isNew: true });
    expect(E.readBest(null, sortGame)).toBe(0);
    const junk = { getItem: () => '{nope', setItem: () => {} };
    expect(E.readBest(junk, sortGame)).toBe(0);
  });
});
