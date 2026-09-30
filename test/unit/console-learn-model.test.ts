import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileLearnDir } from '../../cli/src/learn-compile';
import registry from '../../packages/catalogue/concepts.json';
import paths from '../../packages/catalogue/paths.json';
import onboardingJson from '../../packages/catalogue/onboarding.json';

/**
 * What the console knows about a learner's learning (dashboard/src/learn-model.js):
 * grading, the mastery record in localStorage, the lesson plan and the
 * analytics body. Pure module, imported directly.
 */
type Q = { id: string; concept: string; type: 'single' | 'multi'; prompt: string; options: Array<{ id: string; text: string }>; answer: string[]; explanation: string; diagnostic?: boolean; level?: string };
type Result = { question_id: string; concept: string; correct: boolean };
type Step = { ask: Q } | { level: string };
type Concept = { id: string; title: string; minutes: number; recap: string; body: string };
type Learn = { story?: { title: string; minutes: number; body: string }; concepts: Concept[]; questions: Q[]; answers_file: string; fields: unknown[] };
type Mastery = {
  v: number;
  onboarding: { status: 'done' | 'skipped' | null; at: number; levels: Record<string, string> };
  concepts: Record<string, { known: boolean }>;
  overrides: Record<string, string>;
};
type Store = { get: () => Mastery; set: (m: Mastery) => Mastery; update: (fn: (m: Mastery) => Mastery) => Mastery };
const m = (await import('../../dashboard/src/learn-model.js' as string)) as {
  STORAGE_KEY: string;
  gradeQuestion: (q: unknown, selected: unknown) => boolean;
  areaOf: (id: string) => string;
  platformAreas: (r?: unknown) => Array<{ area: string; title: string; path: string; module: number }>;
  areaForModule: (path: string, n: number) => { area: string } | null;
  emptyMastery: () => Mastery;
  normalizeMastery: (raw: unknown) => Mastery;
  createMasteryStore: (o?: { storage?: unknown; key?: string }) => Store;
  MAX_PROBE: number;
  probeQuestion: (area: string, qs: Q[], tier: string, skip?: string[]) => Q | null;
  firstQuestionFor: (area: string, qs: Q[], asked?: string[]) => Q | null;
  nextStep: (area: string, qs: Q[], answers?: Array<boolean | { correct: boolean }>) => Step;
  orderSelected: (choice: unknown, areas?: Array<{ area: string }>) => string[];
  levelsFromProbe: (o: { areas?: Array<{ area: string }>; selected: string[]; questions: Q[]; results: Result[] }) => Record<string, string>;
  recordOnboarding: (m: Mastery, levels: Record<string, string>, now?: number) => Mastery;
  skipOnboarding: (m: Mastery, now?: number) => Mastery;
  onboardingState: (m: Mastery) => string | null;
  onboardingFinished: (m: Mastery) => boolean;
  areaLevel: (m: Mastery, area: string) => string | null;
  suggestStart: (mods: Array<{ path: string; number: number }>, m: Mastery) => { path: string; number: number } | null;
  diagnosticQuestions: (l: Learn, m: Mastery) => Q[];
  recordDiagnostic: (m: Mastery, results: Array<{ concept: string; correct: boolean }>) => Mastery;
  setOverride: (m: Mastery, concept: string, v: string | null) => Mastery;
  lessonReason: (concept: string, m: Mastery) => string | null;
  planLessons: (l: Learn, m: Mastery) => Array<{ concept: string; state: string }>;
  answersBody: (results: unknown[], o?: Record<string, unknown>) => Record<string, unknown> & { answers: Array<Record<string, unknown>> };
  readingTime: (n: number) => string;
  normalizeLearn: (e: unknown) => { version: string; learn: Learn } | null;
  normalizeOnboarding: (raw: unknown) => { intro: string; questions: Q[]; blurbs: Record<string, string> } | null;
};

const q = (id: string, concept: string, o: Partial<Q> = {}): Q => ({
  id,
  concept,
  type: 'single',
  prompt: `Prompt ${id}?`,
  options: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
  ],
  answer: ['a'],
  explanation: 'Because.',
  ...o,
});
const lesson = (id: string): Concept => ({ id, title: `Lesson ${id}`, minutes: 2, recap: `Recap ${id}.`, body: 'Body.' });
const learn = (concepts: string[], questions: Q[] = []): Learn => ({ concepts: concepts.map(lesson), questions, answers_file: 'answers.json', fields: [] });
const res = (concept: string, correct: boolean, id = `q-${concept}`) => ({ question_id: id, concept, correct });

// ------------------------------------------------------------------- grading

describe('gradeQuestion', () => {
  const single = q('s', 'gateway.routing-aliases');
  const multi = q('m', 'gateway.routing-aliases', { type: 'multi', answer: ['a', 'c'] });

  it('grades a single choice by its one answer', () => {
    expect(m.gradeQuestion(single, ['a'])).toBe(true);
    expect(m.gradeQuestion(single, ['b'])).toBe(false);
    expect(m.gradeQuestion(single, ['a', 'b'])).toBe(false);
  });

  it('grades a multiple choice by exact set match', () => {
    expect(m.gradeQuestion(multi, ['a', 'c'])).toBe(true);
    expect(m.gradeQuestion(multi, ['c', 'a'])).toBe(true);
    expect(m.gradeQuestion(multi, ['a'])).toBe(false);
    expect(m.gradeQuestion(multi, ['a', 'b', 'c'])).toBe(false);
    expect(m.gradeQuestion(multi, ['a', 'b'])).toBe(false);
  });

  it('counts repeats once and a Set as a list', () => {
    expect(m.gradeQuestion(multi, ['a', 'a', 'c'])).toBe(true);
    expect(m.gradeQuestion(multi, new Set(['a', 'c']))).toBe(true);
  });

  it('never grades nothing, or a question without an answer, as correct', () => {
    expect(m.gradeQuestion(single, [])).toBe(false);
    expect(m.gradeQuestion(single, undefined)).toBe(false);
    expect(m.gradeQuestion({ answer: [] }, [])).toBe(false);
    expect(m.gradeQuestion(undefined, ['a'])).toBe(false);
  });
});

// --------------------------------------------------------------------- areas

describe('areas from the concept registry', () => {
  it('lists every area in module order with its title', () => {
    const areas = m.platformAreas();
    expect(areas.map((a) => a.area)).toEqual(Object.entries(registry.areas).sort((a, b) => a[1].module - b[1].module).map(([k]) => k));
    expect(areas.map((a) => a.module)).toEqual([...areas.map((a) => a.module)].sort((a, b) => a - b));
    expect(areas[0]).toMatchObject({ area: 'gateway', path: 'ai-platform', module: 1 });
  });

  it('maps a launcher module to its area by path and number', () => {
    expect(m.areaForModule('ai-platform', 2)).toMatchObject({ area: 'mcp' });
    expect(m.areaForModule('ai-platform', 5)).toBeNull();
    expect(m.areaForModule('production-agents', 1)).toBeNull();
  });

  it('every area of the registry has a module in paths.json, so a chip can land on a card', () => {
    const modules = paths.paths.find((p) => p.slug === 'ai-platform')!.modules.map((x) => x.number);
    for (const a of m.platformAreas()) expect(modules, a.area).toContain(a.module);
  });

  it('reads the area off a concept id', () => {
    expect(m.areaOf('gateway.routing-aliases')).toBe('gateway');
    expect(m.areaOf('nodot')).toBe('');
  });
});

// ----------------------------------------------------------- mastery storage

/** A storage stand-in backed by a Map, optionally throwing. */
function fakeStorage(seed: Record<string, string> = {}, throws: 'never' | 'read' | 'write' | 'both' = 'never') {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem(k: string) {
      if (throws === 'read' || throws === 'both') throw new Error('blocked');
      return data.has(k) ? data.get(k)! : null;
    },
    setItem(k: string, v: string) {
      if (throws === 'write' || throws === 'both') throw new Error('quota');
      data.set(k, v);
    },
  };
}

describe('the mastery record', () => {
  it("lives under the key 'opalixLearn'", () => {
    expect(m.STORAGE_KEY).toBe('opalixLearn');
    const storage = fakeStorage();
    const store = m.createMasteryStore({ storage });
    store.update((x) => m.skipOnboarding(x, 5));
    expect([...storage.data.keys()]).toEqual(['opalixLearn']);
    expect(JSON.parse(storage.data.get('opalixLearn')!).onboarding.status).toBe('skipped');
  });

  it('starts empty and round-trips through storage', () => {
    const storage = fakeStorage();
    const store = m.createMasteryStore({ storage });
    expect(store.get()).toEqual(m.emptyMastery());
    store.update((x) => m.setOverride(x, 'gateway.routing-aliases', 'forced'));
    // A second store on the same storage (another tab, a reload) sees it.
    expect(m.createMasteryStore({ storage }).get().overrides).toEqual({ 'gateway.routing-aliases': 'forced' });
  });

  it('works with no storage at all, in memory', () => {
    const store = m.createMasteryStore({ storage: null });
    store.update((x) => m.recordDiagnostic(x, [{ concept: 'gateway.routing-aliases', correct: true }]));
    expect(store.get().concepts['gateway.routing-aliases']).toEqual({ known: true });
  });

  it('works when storage throws on read, on write, or both', () => {
    for (const mode of ['read', 'write', 'both'] as const) {
      const store = m.createMasteryStore({ storage: fakeStorage({}, mode) });
      expect(() => store.update((x) => m.skipOnboarding(x))).not.toThrow();
      expect(store.get().onboarding.status, mode).toBe('skipped');
    }
  });

  it('works when even reading window.localStorage throws', () => {
    // Some browsers throw a SecurityError on the property access itself.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      const store = m.createMasteryStore();
      expect(() => store.get()).not.toThrow();
      expect(() => store.update((x) => m.skipOnboarding(x))).not.toThrow();
      expect(store.get().onboarding.status).toBe('skipped');
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('uses window.localStorage by default when it is there', () => {
    const storage = fakeStorage();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    try {
      m.createMasteryStore().update((x) => m.skipOnboarding(x));
      expect(storage.data.has('opalixLearn')).toBe(true);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('survives garbage in storage', () => {
    for (const raw of ['{', 'null', '[]', '"x"', '42', '{"onboarding":7,"concepts":[],"overrides":"x"}']) {
      const store = m.createMasteryStore({ storage: fakeStorage({ opalixLearn: raw }) });
      expect(store.get(), raw).toEqual(m.emptyMastery());
    }
  });

  it('drops keys and values it does not recognise, including __proto__', () => {
    const raw = JSON.parse(
      '{"v":9,"onboarding":{"status":"weird","at":"x","levels":{"gateway":"strong","mcp":"expert","Bad":"new","__proto__":"new"}},' +
        '"concepts":{"gateway.routing-aliases":{"known":true},"nope":{"known":true},"mcp.what-is-mcp":{"known":"yes"},"__proto__":{"known":true}},' +
        '"overrides":{"gateway.usage-and-spend":"skipped","mcp.what-is-mcp":"maybe","bad id":"forced"}}'
    );
    const out = m.normalizeMastery(raw);
    expect(out.onboarding).toEqual({ status: null, at: 0, levels: { gateway: 'strong' } });
    expect(out.concepts).toEqual({ 'gateway.routing-aliases': { known: true } });
    expect(out.overrides).toEqual({ 'gateway.usage-and-spend': 'skipped' });
    expect(Object.getPrototypeOf(out.concepts)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).known).toBeUndefined();
  });
});

// ---------------------------------------------------------------- onboarding

describe('onboarding: the branching probe', () => {
  const ob = m.normalizeOnboarding(onboardingJson)!;
  const areas = m.platformAreas().map((a) => a.area);
  const qs = ob.questions;
  const basic = (area: string) => m.firstQuestionFor(area, qs)!;
  const advanced = (area: string) => m.probeQuestion(area, qs, 'advanced')!;
  const step = (area: string, ...answers: boolean[]) => m.nextStep(area, qs, answers);

  it('reads the shipped onboarding quiz whole, with a level on every question and a blurb per area', () => {
    expect(ob.questions).toHaveLength(onboardingJson.questions.length);
    expect(ob.intro).toBe(onboardingJson.intro);
    expect(ob.questions.every((x) => x.level === 'basic' || x.level === 'advanced')).toBe(true);
    for (const a of areas) {
      expect(ob.blurbs[a], a).toBeTruthy();
      expect(ob.blurbs[a]!.length).toBeLessThanOrEqual(90);
    }
  });

  it('every area has a basic and an advanced question to probe with, and they are different questions', () => {
    for (const a of areas) {
      expect(basic(a).concept.startsWith(`${a}.`)).toBe(true);
      expect(basic(a).level).toBe('basic');
      expect(advanced(a).level).toBe('advanced');
      expect(basic(a).id).not.toBe(advanced(a).id);
    }
  });

  it('uses the FIRST question of each level in file order, and can skip ones already asked', () => {
    const list = [q('b1', 'gateway.routing-aliases', { level: 'basic' }), q('a1', 'gateway.error-semantics', { level: 'advanced' }), q('b2', 'gateway.usage-and-spend', { level: 'basic' }), q('m1', 'mcp.what-is-mcp', { level: 'basic' })];
    expect(m.firstQuestionFor('gateway', list)!.id).toBe('b1');
    expect(m.firstQuestionFor('gateway', list, ['b1'])!.id).toBe('b2');
    expect(m.firstQuestionFor('mcp', list)!.id).toBe('m1');
    expect(m.firstQuestionFor('rag', list)).toBeNull();
    expect(m.probeQuestion('gateway', list, 'advanced')!.id).toBe('a1');
  });

  it('asks the basic question first', () => {
    expect(step('gateway')).toEqual({ ask: basic('gateway') });
  });

  it('a wrong basic answer settles the area as new, with no second question', () => {
    expect(step('gateway', false)).toEqual({ level: 'new' });
  });

  it('a right basic answer leads to the advanced question', () => {
    expect(step('gateway', true)).toEqual({ ask: advanced('gateway') });
  });

  it('basic right and advanced wrong is ok; both right is strong', () => {
    expect(step('gateway', true, false)).toEqual({ level: 'ok' });
    expect(step('gateway', true, true)).toEqual({ level: 'strong' });
  });

  it('"Not sure" is just an answer that is not correct: new at the basic question, ok at the advanced one', () => {
    expect(m.nextStep('gateway', qs, [{ correct: false }])).toEqual({ level: 'new' });
    expect(m.nextStep('gateway', qs, [{ correct: true }, { correct: false }])).toEqual({ level: 'ok' });
  });

  it('never asks a third question, whatever the answers', () => {
    expect(step('gateway', true, true, true)).toEqual({ level: 'strong' });
    expect(step('gateway', false, true, true)).toEqual({ level: 'new' });
  });

  it('an area with no basic question cannot be judged and stays new; with no advanced one a right answer is ok', () => {
    expect(m.nextStep('gateway', [], [])).toEqual({ level: 'new' });
    const onlyBasic = [q('b1', 'gateway.routing-aliases', { level: 'basic' })];
    expect(m.nextStep('gateway', onlyBasic, [true])).toEqual({ level: 'ok' });
  });

  it('orders the ticked areas by module and drops what is not an area', () => {
    expect(m.orderSelected(['sovereignty', 'gateway', 'rag', 'rag', 'nonsense'])).toEqual(['gateway', 'rag', 'sovereignty']);
    expect(m.orderSelected(new Set(['otel', 'mcp']))).toEqual(['mcp', 'otel']);
    expect(m.orderSelected([])).toEqual([]);
    expect(m.orderSelected(null)).toEqual([]);
  });

  // The walk the screen does: ask, answer, feed back, until every ticked area is settled.
  function walk(selected: string[], policy: (q: Q) => boolean) {
    const results: Result[] = [];
    const asked: Q[] = [];
    for (const area of m.orderSelected(selected)) {
      const answers: boolean[] = [];
      for (;;) {
        const s = m.nextStep(area, qs, answers);
        if ('level' in s) break;
        const correct = policy(s.ask);
        asked.push(s.ask);
        answers.push(correct);
        results.push({ question_id: s.ask.id, concept: s.ask.concept, correct });
      }
    }
    return { asked, results, levels: m.levelsFromProbe({ selected: m.orderSelected(selected), questions: qs, results }) };
  }
  const allLevels = (over: Record<string, string>) => ({ ...Object.fromEntries(areas.map((a) => [a, 'new'])), ...over });

  it('all wrong: one question per ticked area, every area new', () => {
    const { asked, levels } = walk(['gateway', 'mcp'], () => false);
    expect(asked.map((x) => x.level)).toEqual(['basic', 'basic']);
    expect(levels).toEqual(allLevels({}));
  });

  it('basic right, advanced wrong: two questions and ok', () => {
    const { asked, levels } = walk(['rag'], (x) => x.level === 'basic');
    expect(asked.map((x) => x.level)).toEqual(['basic', 'advanced']);
    expect(levels).toEqual(allLevels({ rag: 'ok' }));
  });

  it('both right: two questions and strong', () => {
    const { asked, levels } = walk(['otel'], () => true);
    expect(asked).toHaveLength(2);
    expect(levels).toEqual(allLevels({ otel: 'strong' }));
  });

  it('unticked areas get no questions and are new', () => {
    const { asked, levels } = walk(['gateway'], () => true);
    expect(new Set(asked.map((x) => m.areaOf(x.concept)))).toEqual(new Set(['gateway']));
    expect(levels).toEqual(allLevels({ gateway: 'strong' }));
  });

  it('"None of these yet" asks nothing and marks all six areas new', () => {
    const { asked, levels } = walk([], () => true);
    expect(asked).toEqual([]);
    expect(levels).toEqual(allLevels({}));
    expect(Object.keys(levels)).toHaveLength(6);
  });

  it('several areas are asked in module order, one area fully before the next', () => {
    const { asked } = walk(['sovereignty', 'mcp', 'gateway'], () => true);
    expect(asked.map((x) => m.areaOf(x.concept))).toEqual(['gateway', 'gateway', 'mcp', 'mcp', 'sovereignty', 'sovereignty']);
    expect(asked.map((x) => x.level)).toEqual(['basic', 'advanced', 'basic', 'advanced', 'basic', 'advanced']);
  });

  it('mixed outcomes by area', () => {
    const outcome: Record<string, [boolean, boolean]> = { gateway: [true, true], mcp: [true, false], rag: [false, true] };
    const { asked, levels } = walk(['gateway', 'mcp', 'rag'], (x) => outcome[m.areaOf(x.concept)]![x.level === 'basic' ? 0 : 1]);
    expect(levels).toEqual(allLevels({ gateway: 'strong', mcp: 'ok', rag: 'new' }));
    expect(asked).toHaveLength(5);
  });

  it('never asks more than 2 per area nor more than 2 x the ticked areas, for every tick set and every set of outcomes', () => {
    const outcomes: Array<[boolean, boolean]> = [[false, false], [true, false], [true, true]];
    let cases = 0;
    for (let mask = 0; mask < 1 << areas.length; mask++) {
      const selected = areas.filter((_, i) => mask & (1 << i));
      for (let pick = 0; pick < 3 ** areas.length; pick += 29) {
        const outcomeOf = (area: string) => outcomes[Math.floor(pick / 3 ** areas.indexOf(area)) % 3]!;
        const { asked, levels } = walk(selected, (x) => outcomeOf(m.areaOf(x.concept))[x.level === 'basic' ? 0 : 1]);
        expect(asked.length).toBeLessThanOrEqual(2 * selected.length);
        for (const a of areas) expect(asked.filter((x) => m.areaOf(x.concept) === a).length).toBeLessThanOrEqual(m.MAX_PROBE);
        for (const a of areas.filter((x) => !selected.includes(x))) expect(levels[a]).toBe('new');
        expect(Object.keys(levels).sort()).toEqual([...areas].sort());
        cases++;
      }
    }
    expect(cases).toBeGreaterThan(500);
  });

  it('levelsFromProbe ignores a result for a question the probe would not have asked, and answers after the level is settled', () => {
    const b = basic('gateway');
    const a = advanced('gateway');
    const stray = res('gateway.routing-aliases', true, 'ghost-question');
    // wrong at basic: the advanced answer that follows is never read.
    expect(m.levelsFromProbe({ selected: ['gateway'], questions: qs, results: [stray, res(b.concept, false, b.id), res(a.concept, true, a.id)] }).gateway).toBe('new');
    // an unfinished probe has no level for that area.
    expect(m.levelsFromProbe({ selected: ['gateway'], questions: qs, results: [res(b.concept, true, b.id)] }).gateway).toBeUndefined();
  });

  it('records a finished quiz and remembers it', () => {
    const levels = allLevels({ gateway: 'strong' });
    const next = m.recordOnboarding(m.emptyMastery(), levels, 123);
    expect(next.onboarding.status).toBe('done');
    expect(next.onboarding.at).toBe(123);
    expect(next.onboarding.levels).toEqual(levels);
    expect(m.onboardingState(next)).toBe('done');
    expect(m.onboardingFinished(next)).toBe(true);
    expect(m.areaLevel(next, 'gateway')).toBe('strong');
    expect(m.areaLevel(next, 'mcp')).toBe('new');
    expect(m.areaLevel(next, 'unknown')).toBeNull();
  });

  it('skipping is remembered, so the quiz does not come back', () => {
    const next = m.skipOnboarding(m.emptyMastery());
    expect(m.onboardingState(next)).toBe('skipped');
    expect(m.onboardingFinished(next)).toBe(true);
    expect(m.onboardingFinished(m.emptyMastery())).toBe(false);
    expect(next.onboarding.levels).toEqual({});
  });

  it('skipping a retake keeps the levels already earned', () => {
    const done = m.recordOnboarding(m.emptyMastery(), allLevels({ gateway: 'strong' }));
    const again = m.skipOnboarding(done);
    expect(again.onboarding).toEqual(done.onboarding);
  });

  it('a retake replaces the levels', () => {
    const first = m.recordOnboarding(m.emptyMastery(), allLevels({ gateway: 'strong' }));
    const second = m.recordOnboarding(first, allLevels({}));
    expect(m.areaLevel(second, 'gateway')).toBe('new');
  });

  it('suggests the first module whose area is new, in card order', () => {
    const cards = paths.paths.find((p) => p.slug === 'ai-platform')!.modules.map((x) => ({ path: 'ai-platform', number: x.number }));
    const base = m.emptyMastery();
    expect(m.suggestStart(cards, base)).toBeNull();
    const withLevels = (levels: Record<string, string>): Mastery => ({ ...base, onboarding: { status: 'done', at: 1, levels } });
    expect(m.suggestStart(cards, withLevels({ gateway: 'strong', mcp: 'ok', rag: 'new', otel: 'new' }))).toEqual({ path: 'ai-platform', number: 3 });
    expect(m.suggestStart(cards, withLevels({ gateway: 'strong', mcp: 'strong' }))).toBeNull();
    expect(m.suggestStart(cards, withLevels({ gateway: 'new' }))).toEqual({ path: 'ai-platform', number: 1 });
    // A module with no area (number 5) and other paths never get the chip.
    expect(m.suggestStart([{ path: 'ai-platform', number: 5 }, { path: 'other', number: 1 }], withLevels({ gateway: 'new' }))).toBeNull();
  });
});

// ---------------------------------------------------------------- diagnostics

describe('lab diagnostics', () => {
  const A = 'gateway.routing-aliases';
  const B = 'gateway.usage-and-spend';
  const lab = learn([A, B], [q('q-a1', A), q('q-a2', A), q('q-b1', B), q('q-b-extra', B, { diagnostic: false })]);

  it('asks the diagnostic questions of concepts not yet known, in the lab order', () => {
    expect(m.diagnosticQuestions(lab, m.emptyMastery()).map((x) => x.id)).toEqual(['q-a1', 'q-a2', 'q-b1']);
    const knowsA = m.recordDiagnostic(m.emptyMastery(), [res(A, true)]);
    expect(m.diagnosticQuestions(lab, knowsA).map((x) => x.id)).toEqual(['q-b1']);
  });

  it('never asks a question marked diagnostic: false', () => {
    expect(m.diagnosticQuestions(lab, m.emptyMastery()).some((x) => x.id === 'q-b-extra')).toBe(false);
  });

  it('marks a concept known only when EVERY diagnostic question about it was right', () => {
    const allRight = m.recordDiagnostic(m.emptyMastery(), [res(A, true, 'q-a1'), res(A, true, 'q-a2')]);
    expect(allRight.concepts[A]).toEqual({ known: true });
    for (const results of [
      [res(A, true, 'q-a1'), res(A, false, 'q-a2')],
      [res(A, false, 'q-a1'), res(A, true, 'q-a2')],
      [res(A, false, 'q-a1'), res(A, false, 'q-a2')],
    ]) {
      expect(m.recordDiagnostic(m.emptyMastery(), results).concepts[A]).toEqual({ known: false });
    }
  });

  it('judges each concept on its own questions', () => {
    const next = m.recordDiagnostic(m.emptyMastery(), [res(A, true, 'q-a1'), res(A, true, 'q-a2'), res(B, false, 'q-b1')]);
    expect(next.concepts).toEqual({ [A]: { known: true }, [B]: { known: false } });
  });

  it('a later diagnostic replaces an earlier one, and leaves other concepts alone', () => {
    const first = m.recordDiagnostic(m.emptyMastery(), [res(A, false), res(B, true)]);
    const second = m.recordDiagnostic(first, [res(A, true)]);
    expect(second.concepts).toEqual({ [A]: { known: true }, [B]: { known: true } });
  });

  it('ignores a result for something that is not a concept id', () => {
    expect(m.recordDiagnostic(m.emptyMastery(), [res('not a concept', true)]).concepts).toEqual({});
  });
});

// ---------------------------------------------------------------------- plan

describe('planLessons', () => {
  const A = 'gateway.routing-aliases';
  const B = 'gateway.usage-and-spend';
  const C = 'mcp.what-is-mcp';
  const lab = learn([A, B, C]);
  const plan = (mastery: Mastery) => Object.fromEntries(m.planLessons(lab, mastery).map((p) => [p.concept, p.state]));
  const withOnboarding = (levels: Record<string, string>, base = m.emptyMastery()): Mastery => ({ ...base, onboarding: { status: 'done', at: 1, levels } });

  it('opens everything for a learner the console knows nothing about', () => {
    expect(m.planLessons(lab, m.emptyMastery())).toEqual([
      { concept: A, state: 'expanded' },
      { concept: B, state: 'expanded' },
      { concept: C, state: 'expanded' },
    ]);
  });

  it('keeps the lab order and only the two keys', () => {
    expect(m.planLessons(lab, m.emptyMastery()).map((p) => Object.keys(p).sort())).toEqual([['concept', 'state'], ['concept', 'state'], ['concept', 'state']]);
  });

  it('collapses a known concept to its recap', () => {
    const known = m.recordDiagnostic(m.emptyMastery(), [res(A, true)]);
    expect(plan(known)).toEqual({ [A]: 'collapsed', [B]: 'expanded', [C]: 'expanded' });
  });

  it('keeps a missed concept open', () => {
    expect(plan(m.recordDiagnostic(m.emptyMastery(), [res(A, false)]))[A]).toBe('expanded');
  });

  it('opens a known concept the learner forced open', () => {
    const known = m.recordDiagnostic(m.emptyMastery(), [res(A, true)]);
    expect(plan(m.setOverride(known, A, 'forced'))[A]).toBe('expanded');
  });

  it('collapses a skipped concept, even one the diagnostic missed', () => {
    const missed = m.recordDiagnostic(m.emptyMastery(), [res(A, false)]);
    expect(plan(m.setOverride(missed, A, 'skipped'))[A]).toBe('collapsed');
    expect(plan(m.setOverride(m.emptyMastery(), B, 'skipped'))[B]).toBe('collapsed');
  });

  it('clearing an override gives the default back', () => {
    const skipped = m.setOverride(m.emptyMastery(), A, 'skipped');
    expect(plan(m.setOverride(skipped, A, null))[A]).toBe('expanded');
  });

  it("starts a 'strong' onboarding area collapsed while its lab diagnostic is unanswered", () => {
    expect(plan(withOnboarding({ gateway: 'strong' }))).toEqual({ [A]: 'collapsed', [B]: 'collapsed', [C]: 'expanded' });
  });

  it("does not collapse 'ok' or 'new' areas", () => {
    expect(plan(withOnboarding({ gateway: 'ok', mcp: 'new' }))).toEqual({ [A]: 'expanded', [B]: 'expanded', [C]: 'expanded' });
  });

  it("lets an answered diagnostic beat a 'strong' area: a missed concept opens", () => {
    const missed = m.recordDiagnostic(withOnboarding({ gateway: 'strong' }), [res(A, false)]);
    expect(plan(missed)).toEqual({ [A]: 'expanded', [B]: 'collapsed', [C]: 'expanded' });
  });

  it("lets the learner force open a lesson in a 'strong' area", () => {
    expect(plan(m.setOverride(withOnboarding({ gateway: 'strong' }), A, 'forced'))[A]).toBe('expanded');
  });

  it('says why each lesson starts the way it does', () => {
    let x = withOnboarding({ gateway: 'strong' });
    expect(m.lessonReason(A, x)).toBe('strong');
    x = m.recordDiagnostic(x, [res(A, false), res(B, true)]);
    expect([m.lessonReason(A, x), m.lessonReason(B, x), m.lessonReason(C, x)]).toEqual(['missed', 'known', null]);
    x = m.setOverride(m.setOverride(x, A, 'forced'), B, 'skipped');
    expect([m.lessonReason(A, x), m.lessonReason(B, x)]).toEqual(['forced', 'skipped']);
  });

  it('an empty bundle plans nothing', () => {
    expect(m.planLessons(learn([]), m.emptyMastery())).toEqual([]);
    expect(m.planLessons(undefined as unknown as Learn, m.emptyMastery())).toEqual([]);
  });
});

// ------------------------------------------------------------- analytics body

describe('answersBody', () => {
  const results = [{ question_id: 'q-one', concept: 'gateway.routing-aliases', correct: true, selected: ['a'] }];

  it('holds exactly the API keys for a diagnostic', () => {
    const body = m.answersBody(results, { phase: 'diagnostic', slug: 'see-what-a-gateway-does', version: '1.0.0' });
    expect(body).toEqual({
      lab_slug: 'see-what-a-gateway-does',
      lab_version: '1.0.0',
      answers: [{ question_id: 'q-one', concept: 'gateway.routing-aliases', correct: true, phase: 'diagnostic' }],
    });
  });

  it('leaves the lab out for the onboarding quiz, and never adds an identity', () => {
    const body = m.answersBody(results, { phase: 'onboarding' });
    expect(Object.keys(body)).toEqual(['answers']);
    expect(Object.keys(body.answers[0]!).sort()).toEqual(['concept', 'correct', 'phase', 'question_id']);
    expect(JSON.stringify(body)).not.toMatch(/user|session|subject|ip|selected/i);
  });

  it('never sends a version without its lab', () => {
    expect(m.answersBody(results, { phase: 'onboarding', version: '1.0.0' })).not.toHaveProperty('lab_version');
  });

  it('sends at most 60 answers', () => {
    const many = Array.from({ length: 75 }, (_, i) => ({ question_id: `q-${i}`, concept: 'gateway.routing-aliases', correct: i % 2 === 0 }));
    expect(m.answersBody(many, { phase: 'onboarding' }).answers).toHaveLength(60);
  });

  it('turns anything but true into false', () => {
    const body = m.answersBody([{ question_id: 'q', concept: 'a.b', correct: 'yes' as never }], { phase: 'onboarding' });
    expect(body.answers[0]!.correct).toBe(false);
  });
});

describe('reading time', () => {
  it('says how long a story takes', () => {
    expect(m.readingTime(2)).toBe('2 min read');
    expect(m.readingTime(0)).toBe('');
    expect(m.readingTime(NaN)).toBe('');
  });
});

// --------------------------------------------------- what the API sends us

describe('normalizing what the API sent', () => {
  it('keeps every lab bundle the repo ships whole', () => {
    const dirs = readdirSync('labs').filter((d) => existsSync(join('labs', d, 'learn')));
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const compiled = compileLearnDir(join('labs', dir));
      expect(compiled?.problems, dir).toEqual([]);
      const bundle = compiled!.bundle!;
      const out = m.normalizeLearn({ version: '1.0.0', learn: bundle })!;
      expect(out.version).toBe('1.0.0');
      expect(out.learn.concepts, dir).toHaveLength(bundle.concepts.length);
      expect(out.learn.questions, dir).toHaveLength(bundle.questions.length);
      expect(out.learn.fields, dir).toHaveLength(bundle.fields.length);
      expect(out.learn.story?.title, dir).toBe(bundle.story?.title);
      expect(out.learn.answers_file).toBe(bundle.answers_file);
    }
  });

  it('gives a lab with a quiz a plan that matches its concepts', () => {
    const bundle = compileLearnDir('labs/see-what-a-gateway-does')!.bundle!;
    const out = m.normalizeLearn({ version: '1.0.0', learn: bundle })!;
    expect(m.planLessons(out.learn, m.emptyMastery()).map((p) => p.concept)).toEqual(bundle.concepts.map((c) => c.id));
    expect(m.diagnosticQuestions(out.learn, m.emptyMastery()).length).toBeGreaterThan(0);
  });

  it('turns junk into null, and drops malformed pieces instead of trusting them', () => {
    expect(m.normalizeLearn(null)).toBeNull();
    expect(m.normalizeLearn({ version: '1', learn: 'x' })).toBeNull();
    const out = m.normalizeLearn({
      version: '1.0.0',
      learn: {
        story: { title: 'T', minutes: 2, body: 'B' },
        concepts: [lesson('gateway.routing-aliases'), { id: 'bad id', title: 'x', body: 'x' }, { id: 'mcp.what-is-mcp', title: 'no body' }],
        questions: [
          q('q-ok', 'gateway.routing-aliases'),
          q('q-orphan', 'mcp.what-is-mcp'),
          { ...q('q-one-option', 'gateway.routing-aliases'), options: [{ id: 'a', text: 'A' }] },
          { ...q('q-no-answer', 'gateway.routing-aliases'), answer: ['zzz'] },
        ],
        fields: [
          { key: 'ok_field', prompt: 'P', kind: 'number' },
          { key: 'Bad Key', prompt: 'P', kind: 'text' },
          { key: 'choice_no_choices', prompt: 'P', kind: 'choice' },
          { key: 'choice_ok', prompt: 'P', kind: 'choice', choices: ['a', 'b'], help: 'H' },
        ],
      },
    })!;
    expect(out.learn.concepts.map((c) => c.id)).toEqual(['gateway.routing-aliases']);
    expect(out.learn.questions.map((x) => x.id)).toEqual(['q-ok']);
    expect(out.learn.fields.map((f) => (f as { key: string }).key)).toEqual(['ok_field', 'choice_ok']);
    expect(out.learn.answers_file).toBe('answers.json');
  });

  it('a bundle with only fields is still a bundle', () => {
    const out = m.normalizeLearn({ version: '1.0.0', learn: { fields: [{ key: 'k', prompt: 'P', kind: 'text' }] } })!;
    expect(out.learn.concepts).toEqual([]);
    expect(out.learn.story).toBeUndefined();
    expect(out.learn.fields).toHaveLength(1);
  });

  it('reads the onboarding quiz, and nothing when it has no question to ask', () => {
    expect(m.normalizeOnboarding(null)).toBeNull();
    expect(m.normalizeOnboarding({ intro: 'x', questions: [] })).toBeNull();
    expect(m.normalizeOnboarding({ intro: 'x', questions: [q('q', 'gateway.routing-aliases', { level: 'basic' })] })!.questions).toHaveLength(1);
  });

  it('drops an onboarding question with no valid level, so an old-shaped quiz is not offered', () => {
    expect(m.normalizeOnboarding({ intro: 'x', questions: [q('q', 'gateway.routing-aliases')] })).toBeNull();
    expect(m.normalizeOnboarding({ intro: 'x', questions: [q('q', 'gateway.routing-aliases', { level: 'expert' })] })).toBeNull();
    const mixed = m.normalizeOnboarding({ intro: 'x', questions: [q('q1', 'gateway.routing-aliases'), q('q2', 'gateway.routing-aliases', { level: 'advanced' }), q('q3', 'mcp.what-is-mcp', { level: 'basic' })] })!;
    expect(mixed.questions.map((x) => x.id)).toEqual(['q2', 'q3']);
  });

  it('keeps an area blurb only when it is text for a real area id', () => {
    const raw = { intro: 'x', questions: [q('q', 'gateway.routing-aliases', { level: 'basic' })], areas: [{ area: 'gateway', blurb: 'One place.' }, { area: 'Bad Id', blurb: 'x' }, { area: 'mcp', blurb: '' }, { area: 'rag' }, null] };
    expect(m.normalizeOnboarding(raw)!.blurbs).toEqual({ gateway: 'One place.' });
    expect(m.normalizeOnboarding({ ...raw, areas: undefined })!.blurbs).toEqual({});
  });

  it('the shipped lab files stay readable by the tests above', () => {
    expect(readFileSync('packages/catalogue/onboarding.json', 'utf8').length).toBeGreaterThan(100);
  });
});
