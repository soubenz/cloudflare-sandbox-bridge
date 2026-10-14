import { describe, it, expect } from 'vitest';

/**
 * The rules of the warm-up games (dashboard/src/game-engine.js), pure: points, combo, hearts, stars, the
 * clock running out, the deck, what happens next (the order of the steps and the next-step check),
 * closeness, keys and the best score.
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
    expect(E.timerFor(outlineGame)).toBe(15);
    expect(E.timerFor({ ...outlineGame, timer: 0 })).toBe(0);
    expect(E.timerFor({ kind: 'sliders' })).toBe(0);
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

describe('what happens next (order-and-nest)', () => {
  // The game in games.yaml: one root (the app's call) holding five gateway steps.
  const door: Game = {
    id: 'through-the-door',
    kind: 'order-and-nest',
    title: 'Through the door',
    steps: [
      { id: 'write-usage', text: 'The gateway writes the usage', parent: 'app-sends', order: 4 },
      { id: 'look-up', text: 'The gateway looks support up in its table', parent: 'app-sends', order: 0 },
      { id: 'answer-back', text: 'The answer comes back', parent: 'app-sends', order: 3 },
      { id: 'app-sends', text: 'The app sends a call', parent: null, order: 0 },
      { id: 'call-provider', text: 'The gateway calls the provider', parent: 'app-sends', order: 2 },
      { id: 'add-key', text: 'The gateway adds the key', parent: 'app-sends', order: 1, why: 'The key comes after the look-up.' },
    ],
  };
  const DOOR = ['app-sends', 'look-up', 'add-key', 'call-provider', 'answer-back', 'write-usage'];
  /** Taps every step in `taps` in turn. */
  const tapAll = (s: any, taps: Array<string | null>) => taps.reduce((st, id) => (id === null ? E.expireStep(st) : E.pickStep(st, id)), s);

  it('the order is the tree flattened depth first, siblings by order; from the game or its steps', () => {
    expect(E.orderOf(door)).toEqual(DOOR);
    expect(E.orderOf(door.steps)).toEqual(DOOR);
    expect(E.orderOf(outlineGame)).toEqual(['r', 'a', 'b']);
    // A deeper tree: a child's own children come before its next sibling.
    const deep = [
      { id: 'r2', parent: null, order: 2 },
      { id: 'a1', parent: 'a', order: 1 },
      { id: 'r', parent: null, order: 1 },
      { id: 'b', parent: 'r', order: 2 },
      { id: 'a', parent: 'r', order: 1 },
    ];
    expect(E.orderOf(deep)).toEqual(['r', 'a', 'a1', 'b', 'r2']);
    expect(E.orderOf([])).toEqual([]);
    expect(E.orderOf(undefined)).toEqual([]);
  });

  it('the next-step check: only the step right after the placed ones, and only when those are in order', () => {
    expect(E.isNextStep(DOOR, [], 'app-sends')).toBe(true);
    expect(E.isNextStep(DOOR, [], 'look-up')).toBe(false);
    expect(E.isNextStep(DOOR, ['app-sends', 'look-up'], 'add-key')).toBe(true);
    expect(E.isNextStep(DOOR, ['app-sends', 'look-up'], 'write-usage')).toBe(false);
    expect(E.isNextStep(DOOR, ['look-up'], 'add-key')).toBe(false);
    expect(E.isNextStep(DOOR, DOOR, 'app-sends')).toBe(false);
    expect(E.isNextStep(DOOR, [], null)).toBe(false);
    expect(E.isNextStep(DOOR, [], '')).toBe(false);
  });

  it('a round: every step in the pool, shuffled by the seed and never already in order, every heart', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
      const s = E.newOrderRound(door, { seed });
      expect(s.order).toEqual(DOOR);
      expect([...s.pool].sort()).toEqual([...DOOR].sort());
      expect(s.pool).not.toEqual(DOOR);
      expect(s).toMatchObject({ placed: [], total: 6, lives: E.LIVES, score: 0, streak: 0, mistakes: 0, status: 'playing', last: null });
      expect(E.nextStep(s)).toBe('app-sends');
    }
    expect(E.newOrderRound(door, { seed: 3 }).pool).toEqual(E.newOrderRound(door, { seed: 3 }).pool);
    expect(E.newOrderRound({ steps: [] }).status).toBe('won');
  });

  it('a right tap places the step and scores like a card; the whole route in order wins with 3 stars', () => {
    let s = E.newOrderRound(door, { seed: 2 });
    const before = s;
    s = E.pickStep(s, 'app-sends');
    expect(before.placed).toEqual([]);
    expect(s.placed).toEqual(['app-sends']);
    expect(s.pool).not.toContain('app-sends');
    expect(s.last).toEqual({ id: 'app-sends', expected: 'app-sends', correct: true, points: E.BASE_POINTS, timedOut: false });
    s = E.pickStep(s, 'look-up', { left: 5, limit: 10 });
    expect(s.last.points).toBe(E.pointsFor({ streak: 2, left: 5, limit: 10 }));
    s = tapAll(s, DOOR.slice(2));
    expect(s.status).toBe('won');
    expect(s.placed).toEqual(DOOR);
    expect(s.pool).toEqual([]);
    expect(s.bestStreak).toBe(6);
    expect(E.starsFor({ won: true, mistakes: s.mistakes })).toBe(3);
    // A finished round takes no more taps.
    expect(E.pickStep(s, 'app-sends')).toBe(s);
    expect(E.nextStep(s)).toBeNull();
  });

  it('a wrong tap costs a heart, resets the streak, keeps the step in the pool and names the step expected', () => {
    let s = tapAll(E.newOrderRound(door, { seed: 1 }), ['app-sends', 'look-up']);
    s = E.pickStep(s, 'write-usage');
    expect(s.last).toEqual({ id: 'write-usage', expected: 'add-key', correct: false, points: 0, timedOut: false });
    expect(s).toMatchObject({ lives: 2, streak: 0, mistakes: 1, placed: ['app-sends', 'look-up'], misses: { 'add-key': 1 } });
    expect(s.pool).toContain('write-usage');
    expect(E.nextStep(s)).toBe('add-key');
    // A tap on a step that is not in the pool (already placed, or unknown) changes nothing.
    expect(E.pickStep(s, 'look-up')).toBe(s);
    expect(E.pickStep(s, 'nope')).toBe(s);
    // The clock running out is a wrong tap with no step.
    const t = E.expireStep(s);
    expect(t.last).toEqual({ id: null, expected: 'add-key', correct: false, points: 0, timedOut: true });
    expect(t.lives).toBe(1);
    expect(t.misses).toEqual({ 'add-key': 2 });
  });

  it('stars by mistakes (0: 3, 1: 2, 2: 1); the third mistake ends the round', () => {
    const won = (wrong: number) => {
      let s = E.newOrderRound(door, { seed: 4 });
      for (let i = 0; i < wrong; i++) s = E.pickStep(s, 'write-usage');
      s = tapAll(s, DOOR);
      return E.starsFor({ won: s.status === 'won', mistakes: s.mistakes });
    };
    expect([0, 1, 2].map(won)).toEqual([3, 2, 1]);
    const lost = tapAll(E.newOrderRound(door, { seed: 4 }), ['look-up', null, 'add-key']);
    expect(lost.status).toBe('lost');
    expect(lost.lives).toBe(0);
    expect(E.pickStep(lost, 'app-sends')).toBe(lost);
    expect(E.starsFor({ won: false, mistakes: 3 })).toBe(0);
  });

  it('agrees with the outline grader: the placed order at the tree depths is a right outline', () => {
    const s = tapAll(E.newOrderRound(door, { seed: 1 }), DOOR);
    const depth = new Map(grade.outlineAnswer(door).map((r: any) => [r.id, r.depth]));
    expect(grade.gradeOutline(door, s.placed.map((id: string) => ({ id, depth: depth.get(id) }))).correct).toBe(true);
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
  it('a step card: 1 to 9 pick by its number, up to the cards on show', () => {
    expect(E.stepKey('1', 6)).toBe(1);
    expect(E.stepKey('6', 6)).toBe(6);
    expect(E.stepKey('7', 6)).toBe(0);
    expect(E.stepKey('9', 12)).toBe(9);
    expect(E.stepKey('0', 6)).toBe(0);
    expect(E.stepKey('10', 12)).toBe(0);
    expect(E.stepKey('ArrowLeft', 6)).toBe(0);
    expect(E.stepKey(' ', 6)).toBe(0);
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
