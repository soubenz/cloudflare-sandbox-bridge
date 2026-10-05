import { describe, it, expect } from 'vitest';
import { nextLabs, type NextCandidate, type NextState } from '../../src/path/next';
import { SKILLS } from '../../src/skills';

/** A catalogue lab, done or not. Pro unless it says otherwise, like a manifest. */
const lab = (slug: string, extra: Partial<NextCandidate> = {}, done = false): NextState => ({
  lab: { slug, title: `Lab ${slug}`, path: 'ai-platform', module: 1, order: 1, ...extra },
  completion: done ? { at: 1 } : null,
});

const CATALOGUE: NextState[] = [
  lab('gw-1', { order: 1, tier: 'free' }),
  lab('gw-2', { order: 2, prerequisites: ['gw-1'] }),
  lab('gw-3', { order: 3, prerequisites: ['gw-2'] }),
  lab('rag-1', { module: 3, order: 1, tier: 'free' }),
  lab('pa-1', { path: 'production-agents', module: 1, order: 1, tier: 'free' }),
  lab('old', { order: 0, tier: 'free', archived: true }),
];
const done = (...slugs: string[]) => CATALOGUE.map((s) => (slugs.includes(s.lab.slug) ? { ...s, completion: { at: 1 } } : s));

describe('nextLabs without a path: the catalogue rule', () => {
  it('is the first lab in catalogue order (path, module, order, slug) that is not done and whose prerequisites are done', () => {
    const r = nextLabs(null, CATALOGUE, 'pro');
    expect(r.overall).toEqual({ slug: 'gw-1', title: 'Lab gw-1', skill: 'gateway', path: 'ai-platform', module: 1 });
    expect(nextLabs(null, done('gw-1'), 'pro').overall?.slug).toBe('gw-2');
    expect(nextLabs(null, done('gw-1', 'gw-2'), 'pro').overall?.slug).toBe('gw-3');
  });

  it('does not depend on the order the states arrive in, and never offers an archived lab', () => {
    expect(nextLabs(null, [...CATALOGUE].reverse(), 'pro')).toEqual(nextLabs(null, CATALOGUE, 'pro'));
    const onlyArchived = nextLabs(null, [lab('old', { tier: 'free', archived: true })], 'pro');
    expect(onlyArchived.overall).toBeNull();
  });

  it('skips what the plan cannot start; a missing tier is pro', () => {
    const free = nextLabs(null, done('gw-1'), 'free');
    expect(free.overall?.slug).toBe('rag-1');
    expect(free.bySkill.gateway).toBeNull();
    expect(nextLabs(null, [lab('x', {})], 'free').overall).toBeNull();
  });

  it('waits for prerequisites, ignores one the catalogue does not list, and counts a skipped one as met', () => {
    expect(nextLabs(null, [lab('a', { order: 1, prerequisites: ['b'] }), lab('b', { order: 2 })], 'pro').overall?.slug).toBe('b');
    expect(nextLabs(null, [lab('a', { prerequisites: ['ghost'] })], 'pro').overall?.slug).toBe('a');
    expect(nextLabs(null, CATALOGUE, 'pro', { skipped: new Set(['gw-1', 'gw-2']) }).overall?.slug).toBe('gw-3');
  });

  it('never offers a skipped lab', () => {
    expect(nextLabs(null, CATALOGUE, 'pro', { skipped: new Set(['gw-1', 'gw-2', 'gw-3']) }).bySkill.gateway).toBeNull();
  });

  it('is null when everything is done', () => {
    const all = nextLabs(null, CATALOGUE.map((s) => ({ ...s, completion: { at: 1 } })), 'pro');
    expect(all.overall).toBeNull();
    expect(Object.values(all.bySkill).every((v) => v === null)).toBe(true);
  });
});

describe('nextLabs per skill', () => {
  it('has one entry per skill, with the first next lab of that skill or null', () => {
    const r = nextLabs(null, CATALOGUE, 'pro');
    expect(Object.keys(r.bySkill)).toEqual(SKILLS.map((s) => s.id));
    expect(r.bySkill.gateway?.slug).toBe('gw-1');
    expect(r.bySkill.rag?.slug).toBe('rag-1');
    expect(r.bySkill.agents).toEqual({ slug: 'pa-1', title: 'Lab pa-1', skill: 'agents', path: 'production-agents', module: 1 });
    expect(r.bySkill.mcp).toBeNull();
  });

  it('a lab in no skill can be next overall, with no skill', () => {
    const r = nextLabs(null, [lab('loose', { path: 'nowhere', tier: 'free' })], 'free');
    expect(r.overall).toEqual({ slug: 'loose', title: 'Lab loose', skill: null, path: 'nowhere', module: 1 });
  });
});

describe('nextLabs with a stored path', () => {
  const steps = [
    { slug: 'gw-1', status: 'done' },
    { slug: 'pa-1', status: 'next' },
    { slug: 'gw-3', status: 'upcoming' },
    { slug: 'rag-1', status: 'locked' },
  ];

  it("is the path's first next or upcoming step, before any catalogue order", () => {
    const r = nextLabs(steps, done('gw-1'), 'pro');
    expect(r.overall?.slug).toBe('pa-1');
    // Per skill: the path's step for that skill when it has one (the path may skip ahead of the catalogue)...
    expect(r.bySkill.gateway?.slug).toBe('gw-3');
    // ...and the catalogue rule for a skill the path does not reach (a locked step is not a next lab).
    expect(r.bySkill.rag?.slug).toBe('rag-1');
  });

  it('passes over a step that is done since, gone from the catalogue, archived or not startable on the plan', () => {
    expect(nextLabs(steps, done('gw-1', 'pa-1'), 'pro').overall?.slug).toBe('gw-3');
    const gone = [{ slug: 'ghost', status: 'next' }, ...steps];
    expect(nextLabs(gone, done('gw-1'), 'pro').overall?.slug).toBe('pa-1');
    expect(nextLabs([{ slug: 'old', status: 'next' }], CATALOGUE, 'pro').overall?.slug).toBe('gw-1');
    expect(nextLabs([{ slug: 'gw-3', status: 'next' }], CATALOGUE, 'free').overall?.slug).toBe('gw-1');
  });

  it('falls back to the catalogue rule once every step is done', () => {
    expect(nextLabs(steps, done('gw-1', 'pa-1', 'gw-3'), 'pro').overall?.slug).toBe('gw-2');
    expect(nextLabs([], CATALOGUE, 'pro').overall?.slug).toBe('gw-1');
  });
});
