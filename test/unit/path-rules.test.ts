import { describe, it, expect } from 'vitest';
import { applyRules, labArea, rulesOrder, skippedForStrong, stableTopo, type RulesInput } from '../../src/path/rules';
import { fixOrder } from '../../src/path/validate';
import { CATALOGUE, lab, slugs } from './path-fixtures';

const base = (over: Partial<RulesInput> = {}): RulesInput => ({ catalogue: CATALOGUE, levels: {}, plan: 'pro', completed: new Set(), ...over });

describe('labArea', () => {
  it('maps a lab to the skill of its module, or of its whole path when the path has no modules, and a lab outside every skill to null', () => {
    expect(labArea({ path: 'ai-platform', module: 1 })).toBe('gateway');
    expect(labArea({ path: 'ai-platform', module: 2 })).toBe('mcp');
    expect(labArea({ path: 'ai-platform', module: 3 })).toBe('rag');
    expect(labArea({ path: 'ai-platform', module: 5 })).toBe('runtime');
    expect(labArea({ path: 'production-agents', module: 1 })).toBe('agents');
    expect(labArea({ path: 'evals-releases', module: 1 })).toBe('evals');
    expect(labArea({ path: 'ai-platform', module: 99 })).toBeNull();
    expect(labArea({ path: 'nowhere', module: 1 })).toBeNull();
    expect(labArea({})).toBeNull();
  });
});

describe('skippedForStrong (rule 4 on its own)', () => {
  const labs = [lab('a1', { path: 'ai-platform', module: 1, order: 1, tier: 'free' }), lab('a2', { path: 'ai-platform', module: 1, order: 2, tier: 'free' }), lab('a3', { path: 'ai-platform', module: 1, order: 3 }), lab('b1', { path: 'ai-platform', module: 2, order: 1 })];
  const all = () => true;

  it('keeps the last startable lab of a strong area and skips the rest of it, and nothing else', () => {
    expect(skippedForStrong(labs, { gateway: 'strong' }, all)).toEqual({ skipped: new Set(['a1', 'a2']), capstones: new Set(['a3']) });
    expect(skippedForStrong(labs, { gateway: 'familiar', mcp: 'new' }, all)).toEqual({ skipped: new Set(), capstones: new Set() });
  });

  it('picks the capstone among the labs the plan can start, and never skips a completed lab', () => {
    const free = (l: { tier?: string }) => l.tier === 'free';
    expect(skippedForStrong(labs, { gateway: 'strong' }, free)).toEqual({ skipped: new Set(['a1', 'a3']), capstones: new Set(['a2']) });
    expect(skippedForStrong(labs, { gateway: 'strong' }, all, { completed: new Set(['a1']) }).skipped).toEqual(new Set(['a2']));
  });

  it('is what applyRules skips', () => {
    const r = applyRules(base({ catalogue: labs, levels: { gateway: 'strong' } }));
    expect(slugs(r.allowed)).toEqual(['a3', 'b1']);
    expect(r.capstones).toEqual(new Set(['a3']));
  });
});

describe('rules: the baseline order', () => {
  it('is the catalogue order with archived labs left out', () => {
    const r = applyRules(base());
    expect(slugs(r.allowed)).toEqual(['gw-intro', 'gw-routing', 'gw-capstone', 'mcp-intro', 'mcp-virtual', 'rag-basics', 'standalone']);
    expect(r.done).toEqual([]);
    expect(r.locked).toEqual([]);
  });

  it('does not depend on the order the catalogue arrives in', () => {
    const shuffled = [...CATALOGUE].reverse();
    expect(slugs(rulesOrder(base({ catalogue: shuffled })))).toEqual(slugs(rulesOrder(base())));
  });

  it('never lists an archived lab, even one that was completed', () => {
    const r = applyRules(base({ completed: new Set(['old-lab']) }));
    expect([...slugs(r.allowed), ...slugs(r.done), ...slugs(r.locked)]).not.toContain('old-lab');
  });
});

describe('rules: prerequisites', () => {
  it('puts a prerequisite before its dependent even when the catalogue order says otherwise', () => {
    const cat = [
      lab('a-late', { path: 'x', module: 1, order: 1, prerequisites: ['z-early'] }),
      lab('z-early', { path: 'x', module: 1, order: 2 }),
      lab('m-free', { path: 'x', module: 1, order: 3 }),
    ];
    expect(slugs(rulesOrder(base({ catalogue: cat })))).toEqual(['z-early', 'a-late', 'm-free']);
  });

  it('a completed prerequisite satisfies its dependent without being on the path', () => {
    const r = applyRules(base({ completed: new Set(['gw-intro', 'gw-routing']) }));
    expect(slugs(r.done)).toEqual(['gw-intro', 'gw-routing']);
    expect(slugs(r.allowed)).toEqual(['gw-capstone', 'mcp-intro', 'mcp-virtual', 'rag-basics', 'standalone']);
  });

  it('ignores a prerequisite that is not in the catalogue or is archived', () => {
    const cat = [lab('needs-ghost', { path: 'x', module: 1, order: 1, prerequisites: ['ghost', 'old-lab'] }), lab('old-lab', { archived: true })];
    expect(slugs(rulesOrder(base({ catalogue: cat })))).toEqual(['needs-ghost']);
  });

  it('survives a prerequisite cycle: every lab is still listed once', () => {
    const cat = [lab('a', { path: 'x', module: 1, order: 1, prerequisites: ['b'] }), lab('b', { path: 'x', module: 1, order: 2, prerequisites: ['a'] })];
    expect(slugs(rulesOrder(base({ catalogue: cat }))).sort()).toEqual(['a', 'b']);
  });
});

describe('rules: quiz levels', () => {
  it('a strong area keeps only its highest-order lab, and the skipped labs count as known', () => {
    const r = applyRules(base({ levels: { gateway: 'strong' } }));
    expect(slugs(r.allowed)).toEqual(['gw-capstone', 'mcp-intro', 'mcp-virtual', 'rag-basics', 'standalone']);
    expect([...r.capstones]).toEqual(['gw-capstone']);
  });

  it('a strong area whose labs are all completed adds nothing', () => {
    const r = applyRules(base({ levels: { mcp: 'strong' }, completed: new Set(['mcp-intro', 'mcp-virtual']) }));
    expect(slugs(r.allowed)).not.toContain('mcp-intro');
    expect(slugs(r.allowed)).not.toContain('mcp-virtual');
  });

  it("a 'new' area's foundation labs come first, the rest stays in catalogue order", () => {
    const r = applyRules(base({ levels: { rag: 'new', mcp: 'new' } }));
    expect(slugs(r.allowed)).toEqual(['mcp-intro', 'rag-basics', 'gw-intro', 'gw-routing', 'gw-capstone', 'mcp-virtual', 'standalone']);
    expect([...r.foundations].sort()).toEqual(['mcp-intro', 'rag-basics']);
  });

  it("with no intro lab in a 'new' area, its first lab is the foundation", () => {
    const cat = [
      lab('other', { path: 'ai-platform', module: 1, order: 1 }),
      lab('rag-1', { path: 'ai-platform', module: 3, order: 1, difficulty: 'core' }),
      lab('rag-2', { path: 'ai-platform', module: 3, order: 2, difficulty: 'core' }),
    ];
    expect(slugs(rulesOrder(base({ catalogue: cat, levels: { rag: 'new' } })))).toEqual(['rag-1', 'other', 'rag-2']);
  });

  it("'familiar' and an area the quiz did not report change nothing", () => {
    expect(slugs(rulesOrder(base({ levels: { gateway: 'familiar' } })))).toEqual(slugs(rulesOrder(base())));
  });
});

describe('rules: completed labs', () => {
  it('are listed as done, in catalogue order, and are not offered again', () => {
    const r = applyRules(base({ completed: new Set(['standalone', 'gw-intro']) }));
    expect(slugs(r.done)).toEqual(['gw-intro', 'standalone']);
    expect(slugs(r.allowed)).not.toContain('gw-intro');
    expect(slugs(r.allowed)).not.toContain('standalone');
  });
});

describe('rules: plan', () => {
  it('a free learner is offered only free labs; pro labs and labs behind them are locked', () => {
    const r = applyRules(base({ plan: 'free' }));
    expect(slugs(r.allowed)).toEqual(['gw-intro', 'mcp-intro', 'mcp-virtual', 'standalone']);
    expect(slugs(r.locked)).toEqual(['gw-routing', 'gw-capstone', 'rag-basics']);
  });

  it('says why each lab is locked: a pro-tier lab is a plan lock, even with a locked prerequisite of its own', () => {
    const r = applyRules(base({ plan: 'free' }));
    expect([...r.locks.keys()]).toEqual(expect.arrayContaining(slugs(r.locked)));
    expect(r.locks.size).toBe(r.locked.length);
    for (const slug of ['gw-routing', 'gw-capstone', 'rag-basics']) expect(r.locks.get(slug)).toEqual({ lock: 'plan' });
  });

  it('a free-tier lab behind a locked lab is a prerequisite lock, and names the lab that holds it', () => {
    const catalogue = [
      lab('a', { path: 'x', module: 1, order: 1, tier: 'free' }),
      lab('b', { path: 'x', module: 1, order: 2, prerequisites: ['a'] }), // pro tier
      lab('c', { path: 'x', module: 1, order: 3, prerequisites: ['b'], tier: 'free' }),
      lab('d', { path: 'x', module: 1, order: 4, prerequisites: ['c'], tier: 'free' }),
    ];
    const r = applyRules(base({ catalogue, plan: 'free' }));
    expect(slugs(r.locked)).toEqual(['b', 'c', 'd']);
    expect(r.locks.get('b')).toEqual({ lock: 'plan' });
    expect(r.locks.get('c')).toMatchObject({ lock: 'prerequisite', by: { slug: 'b' } });
    expect(r.locks.get('d')).toMatchObject({ lock: 'prerequisite', by: { slug: 'c' } });
  });

  it('a pro learner has nothing locked', () => {
    const r = applyRules(base({ plan: 'pro' }));
    expect(r.locked).toEqual([]);
    expect(r.locks.size).toBe(0);
  });

  it('a completed pro lab still shows as done for a free learner, and unlocks what needs it', () => {
    const r = applyRules(base({ plan: 'free', completed: new Set(['gw-intro', 'gw-routing']) }));
    expect(slugs(r.done)).toEqual(['gw-intro', 'gw-routing']);
    expect(slugs(r.locked)).toEqual(['gw-capstone', 'rag-basics']);
  });

  it("a strong area's capstone is the highest-order lab the plan can start", () => {
    const r = applyRules(base({ plan: 'free', levels: { gateway: 'strong' } }));
    expect([...r.capstones]).toEqual(['gw-intro']);
    expect(slugs(r.allowed)).toEqual(['gw-intro', 'mcp-intro', 'mcp-virtual', 'standalone']);
    expect(slugs(r.locked)).toEqual(['rag-basics']);
  });
});

describe('stableTopo', () => {
  const deps: Record<string, string[]> = { c: ['a'], d: ['c', 'b'] };
  const run = (items: string[]) => stableTopo(items, (s) => s, (s) => deps[s] ?? []);

  it('keeps an order that already respects the prerequisites', () => {
    expect(run(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });
  it('moves a lab only as far as its prerequisites force it', () => {
    expect(run(['d', 'c', 'b', 'a'])).toEqual(['b', 'a', 'c', 'd']);
  });
  it('is a permutation even with a cycle', () => {
    const cyc = stableTopo(['x', 'y'], (s) => s, (s) => (s === 'x' ? ['y'] : ['x']));
    expect(cyc.sort()).toEqual(['x', 'y']);
  });
});

describe('fixOrder: validating a proposed order', () => {
  const allowed = [lab('a'), lab('b', { prerequisites: ['a'] }), lab('c'), lab('d', { prerequisites: ['b'] })];

  it('keeps a valid proposal exactly', () => {
    expect(slugs(fixOrder(['c', 'a', 'b', 'd'], allowed))).toEqual(['c', 'a', 'b', 'd']);
  });
  it('drops a hallucinated slug', () => {
    expect(slugs(fixOrder(['c', 'imaginary-lab', 'a', 'b', 'd'], allowed))).toEqual(['c', 'a', 'b', 'd']);
  });
  it('appends a lab the model left out, in rules order', () => {
    expect(slugs(fixOrder(['d', 'b'], allowed))).toEqual(['a', 'b', 'd', 'c']);
    expect(slugs(fixOrder([], allowed))).toEqual(['a', 'b', 'c', 'd']);
  });
  it('moves a lab that precedes its prerequisite', () => {
    expect(slugs(fixOrder(['d', 'c', 'b', 'a'], allowed))).toEqual(['c', 'a', 'b', 'd']);
  });
  it('keeps the first of a duplicated slug', () => {
    expect(slugs(fixOrder(['c', 'a', 'c', 'a', 'b', 'b', 'd'], allowed))).toEqual(['c', 'a', 'b', 'd']);
  });
  it('is always a permutation of the allowed set', () => {
    const out = slugs(fixOrder(['zzz', 'd', 'd', 'x', 'a'], allowed));
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('never lets a slug outside the allowed set in, even one that exists elsewhere', () => {
    expect(slugs(fixOrder(['gw-routing'], allowed))).toEqual(['a', 'b', 'c', 'd']);
  });
});
