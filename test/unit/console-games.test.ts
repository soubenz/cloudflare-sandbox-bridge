import { describe, it, expect } from 'vitest';

/**
 * The warm-up games (dashboard/src/games.js): the graders, the formula
 * evaluator and the deterministic shuffle, imported directly. This repo has
 * no jsdom (the vitest pool is plain Node), so the mounted DOM is not
 * exercised here; everything that decides right or wrong is a pure function.
 */
type Game = Record<string, unknown>;
type Rows = Array<{ id: string; depth: number }>;
const g = (await import('../../dashboard/src/games.js' as string)) as {
  shuffle: <T>(items: T[], seed?: number | string) => T[];
  gradeSort: (game: Game, placement: Record<string, string>) => { correct: boolean; score: number; total: number; wrong: string[] };
  gradeFlag: (game: Game, flagged: string[] | Set<string>) => { correct: boolean; missed: string[]; extra: string[] };
  evalFormula: (game: Game, values?: Record<string, number>) => number;
  formatReadout: (game: Game, value: number) => string;
  gradeAsk: (game: Game, choice: unknown) => boolean;
  outlineAnswer: (game: Game) => Rows;
  gradeOutline: (game: Game, rows: Rows) => { correct: boolean; wrong: string[] };
};

const sortGame = {
  id: 'sort-1',
  kind: 'sort',
  buckets: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
  cards: [
    { id: 'c1', text: 'one', bucket: 'a' },
    { id: 'c2', text: 'two', bucket: 'b' },
    { id: 'c3', text: 'three', bucket: 'a' },
  ],
};

const flagGame = {
  id: 'flag-1',
  kind: 'flag',
  items: [
    { id: 'i1', text: 'x', flag: true, why: 'because' },
    { id: 'i2', text: 'y', flag: false },
    { id: 'i3', text: 'z', flag: true },
  ],
};

const slidersGame = {
  id: 'sl-1',
  kind: 'sliders',
  inputs: [
    { id: 'n', label: 'N', min: 0, max: 100, step: 1, default: 10 },
    { id: 'm', label: 'M', min: 0, max: 10, step: 1, default: 4, unit: 'ms' },
    { id: 'k', label: 'K', min: 0, max: 10, step: 1, default: 2 },
  ],
  formula: [
    { input: 'n', op: '+' },
    { input: 'm', op: '*' },
    { input: 'k', op: '-' },
  ],
  readout: { label: 'Total', unit: 'ms', decimals: 1 },
  ask: { prompt: 'Which?', answer: 'm' },
};

// Answer tree: root(1) > [a(1) > [a1(1), a2(2)], b(2)]; second root r2(2)
const outlineGame = {
  id: 'on-1',
  kind: 'order-and-nest',
  steps: [
    { id: 'a2', text: 'a2', parent: 'a', order: 2 },
    { id: 'r2', text: 'r2', parent: null, order: 2 },
    { id: 'a', text: 'a', parent: 'r', order: 1 },
    { id: 'b', text: 'b', parent: 'r', order: 2 },
    { id: 'r', text: 'r', parent: null, order: 1 },
    { id: 'a1', text: 'a1', parent: 'a', order: 1 },
  ],
};
const solvedRows: Rows = [
  { id: 'r', depth: 0 },
  { id: 'a', depth: 1 },
  { id: 'a1', depth: 2 },
  { id: 'a2', depth: 2 },
  { id: 'b', depth: 1 },
  { id: 'r2', depth: 0 },
];

describe('shuffle', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  it('is deterministic for a seed and does not mutate its input', () => {
    const before = [...items];
    expect(g.shuffle(items, 42)).toEqual(g.shuffle(items, 42));
    expect(items).toEqual(before);
  });
  it('is a permutation', () => {
    expect([...g.shuffle(items, 7)].sort((a, b) => a - b)).toEqual(items);
  });
  it('differs between seeds (at least one of a few)', () => {
    const base = g.shuffle(items, 1).join();
    expect([2, 3, 4, 5].some((s) => g.shuffle(items, s).join() !== base)).toBe(true);
  });
  it('accepts a string seed and handles empty and single-item input', () => {
    expect(g.shuffle(items, 'abc')).toEqual(g.shuffle(items, 'abc'));
    expect(g.shuffle([], 3)).toEqual([]);
    expect(g.shuffle(['x'], 3)).toEqual(['x']);
  });
});

describe('gradeSort', () => {
  it('is right when every card is in its bucket', () => {
    expect(g.gradeSort(sortGame, { c1: 'a', c2: 'b', c3: 'a' })).toEqual({ correct: true, score: 3, total: 3, wrong: [] });
  });
  it('names the wrong cards and scores the rest', () => {
    expect(g.gradeSort(sortGame, { c1: 'b', c2: 'b', c3: 'a' })).toEqual({ correct: false, score: 2, total: 3, wrong: ['c1'] });
  });
  it('counts unplaced cards as wrong, including an empty or missing placement', () => {
    expect(g.gradeSort(sortGame, {}).wrong).toEqual(['c1', 'c2', 'c3']);
    expect(g.gradeSort(sortGame, undefined as never).score).toBe(0);
  });
  it('ignores unknown card ids in the placement', () => {
    expect(g.gradeSort(sortGame, { c1: 'a', c2: 'b', c3: 'a', zz: 'a' }).correct).toBe(true);
  });
  it('a game with no cards is trivially solved', () => {
    expect(g.gradeSort({ cards: [] }, {})).toEqual({ correct: true, score: 0, total: 0, wrong: [] });
  });
});

describe('gradeFlag', () => {
  it('is right for exactly the flagged items, in any order, array or Set', () => {
    expect(g.gradeFlag(flagGame, ['i3', 'i1']).correct).toBe(true);
    expect(g.gradeFlag(flagGame, new Set(['i1', 'i3'])).correct).toBe(true);
  });
  it('reports what was missed and what was flagged by mistake', () => {
    expect(g.gradeFlag(flagGame, ['i1'])).toEqual({ correct: false, missed: ['i3'], extra: [] });
    expect(g.gradeFlag(flagGame, ['i1', 'i2', 'i3'])).toEqual({ correct: false, missed: [], extra: ['i2'] });
  });
  it('nothing flagged is wrong when something should be, and right when nothing should be', () => {
    expect(g.gradeFlag(flagGame, []).correct).toBe(false);
    expect(g.gradeFlag({ items: [{ id: 'q', text: 'q', flag: false }] }, []).correct).toBe(true);
    expect(g.gradeFlag(flagGame, undefined as never).correct).toBe(false);
  });
  it('duplicates in the selection do not matter', () => {
    expect(g.gradeFlag(flagGame, ['i1', 'i1', 'i3']).correct).toBe(true);
  });
});

describe('evalFormula', () => {
  const game = (ops: string[]) => ({
    inputs: [
      { id: 'a', default: 8 },
      { id: 'b', default: 2 },
      { id: 'c', default: 5 },
    ],
    formula: ['a', 'b', 'c'].map((input, i) => ({ input, op: i === 0 ? '+' : ops[i - 1] })),
  });
  it('folds left from the first input and ignores the first op', () => {
    // n=10, m=4, k=2: first op '+' ignored, then * and -: (10 * 4) - 2
    expect(g.evalFormula(slidersGame, {})).toBe(38);
    expect(g.evalFormula(game(['*', '*']), { a: 8, b: 2, c: 5 })).toBe(80);
  });
  it('handles * + - / and is left-to-right, not by precedence', () => {
    expect(g.evalFormula(game(['+', '*']), { a: 8, b: 2, c: 5 })).toBe(50);
    expect(g.evalFormula(game(['-', '-']), { a: 8, b: 2, c: 5 })).toBe(1);
    expect(g.evalFormula(game(['/', '+']), { a: 8, b: 2, c: 5 })).toBe(9);
    expect(g.evalFormula(game(['*', '/']), { a: 8, b: 2, c: 5 })).toBe(3.2);
  });
  it('uses each input default when no value is given', () => {
    expect(g.evalFormula(game(['+', '+']), {})).toBe(15);
    expect(g.evalFormula(game(['+', '+']), undefined)).toBe(15);
  });
  it('a first-op of anything is ignored; the sliders fixture folds + * -', () => {
    // n=10, m=4, k=2: ((10 * 4) - 2) = 38 (first op '+' ignored, then '*', '-')
    expect(g.evalFormula({ ...slidersGame, formula: [{ input: 'n', op: '/' }, { input: 'm', op: '*' }, { input: 'k', op: '-' }] }, {})).toBe(38);
    expect(g.evalFormula({ ...slidersGame, formula: [{ input: 'n', op: '+' }, { input: 'm', op: '+' }, { input: 'k', op: '-' }] }, { n: 1, m: 1, k: 1 })).toBe(1);
  });
  it('division by zero is not finite; an unknown op or empty formula is NaN', () => {
    expect(Number.isFinite(g.evalFormula(game(['/', '+']), { a: 1, b: 0, c: 1 }))).toBe(false);
    expect(g.evalFormula(game(['%', '+']), {})).toBeNaN();
    expect(g.evalFormula({ inputs: [], formula: [] }, {})).toBeNaN();
  });
  it('a single input is just its value', () => {
    expect(g.evalFormula({ inputs: [{ id: 'a', default: 3 }], formula: [{ input: 'a', op: '*' }] }, { a: 9 })).toBe(9);
  });
});

describe('formatReadout', () => {
  it('rounds to decimals and adds the unit', () => {
    expect(g.formatReadout(slidersGame, 12.345)).toBe('12.3 ms');
    expect(g.formatReadout({ readout: { unit: '%', decimals: 0 } }, 40.4)).toBe('40%');
    expect(g.formatReadout({ readout: { decimals: 2 } }, 1)).toBe('1.00');
  });
  it('says so rather than printing NaN or Infinity', () => {
    expect(g.formatReadout(slidersGame, Infinity)).toBe('not a number');
    expect(g.formatReadout(slidersGame, NaN)).toBe('not a number');
  });
});

describe('gradeAsk', () => {
  it('is right only for the named input', () => {
    expect(g.gradeAsk(slidersGame, 'm')).toBe(true);
    expect(g.gradeAsk(slidersGame, 'n')).toBe(false);
  });
  it('rejects empty and non-string choices', () => {
    expect(g.gradeAsk(slidersGame, '')).toBe(false);
    expect(g.gradeAsk(slidersGame, undefined)).toBe(false);
    expect(g.gradeAsk({}, undefined)).toBe(false);
  });
});

describe('gradeOutline', () => {
  it('flattens the answer tree pre-order, siblings by order', () => {
    expect(g.outlineAnswer(outlineGame)).toEqual(solvedRows);
  });
  it('is right for the pre-order rows at the tree depths', () => {
    expect(g.gradeOutline(outlineGame, solvedRows)).toEqual({ correct: true, wrong: [] });
  });
  it('is wrong when the order is right but the depths are not', () => {
    const flat = solvedRows.map((r) => ({ ...r, depth: 0 }));
    const res = g.gradeOutline(outlineGame, flat);
    expect(res.correct).toBe(false);
    expect(res.wrong).toEqual(['a', 'a1', 'a2', 'b']);
  });
  it('is wrong when the depths are right but two rows are swapped', () => {
    const swapped = [...solvedRows];
    [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
    const res = g.gradeOutline(outlineGame, swapped);
    expect(res.correct).toBe(false);
    expect(res.wrong).toEqual(['a2', 'a1']);
  });
  it('is wrong for missing, extra or unknown rows', () => {
    expect(g.gradeOutline(outlineGame, solvedRows.slice(0, 5)).correct).toBe(false);
    expect(g.gradeOutline(outlineGame, [...solvedRows, { id: 'extra', depth: 0 }])).toEqual({ correct: false, wrong: ['extra'] });
    expect(g.gradeOutline(outlineGame, [])).toEqual({ correct: false, wrong: [] });
    expect(g.gradeOutline(outlineGame, undefined as never).correct).toBe(false);
  });
  it('treats a parent that is not a step as the root', () => {
    const game = { steps: [{ id: 's2', parent: 'ghost', order: 2 }, { id: 's1', parent: null, order: 1 }] };
    expect(g.outlineAnswer(game)).toEqual([
      { id: 's1', depth: 0 },
      { id: 's2', depth: 0 },
    ]);
  });
  it('a game with no steps is solved by no rows', () => {
    expect(g.gradeOutline({ steps: [] }, [])).toEqual({ correct: true, wrong: [] });
  });
});
