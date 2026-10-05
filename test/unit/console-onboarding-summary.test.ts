import { describe, it, expect } from 'vitest';
import registry from '../../packages/catalogue/concepts.json';
import paths from '../../packages/catalogue/paths.json';

/**
 * The last screen of the platform quiz ("Where to start"), as data: which one area it recommends, why, in the
 * learner's own terms, and the goal recap line. The page itself is pinned end to end in
 * test/e2e/16-learning.spec.ts; the words are the learner's, never a module number or a platform word.
 */
type Row = { area: string; title: string; path: string; module: number; level: 'strong' | 'ok' | 'new'; phrase: string };
type Start = Omit<Row, 'module' | 'level'> & { module: number | null; level: Row['level'] | null; why: string; lab?: { slug: string; title: string } };
type Summary = { rows: Row[]; start: Start | null };
type Next = { slug: string; title?: string; skill?: string | null; path?: string | null; module?: number | null };
const o = (await import('../../dashboard/src/onboarding.js' as string)) as {
  LEVEL_LABELS: Record<string, string>;
  START_REASONS: Record<string, string>;
  summarise: (mastery: unknown, areas?: unknown, next?: Next | null) => Summary;
  nextFromPath: (path: unknown) => Next | null;
  goalLine: (goal: unknown) => string;
};

// The quiz areas: the quiz skills (concepts.json `quiz`), each an AI-platform module, titled like it.
const AREAS = paths.paths
  .find((p) => p.slug === 'ai-platform')!
  .modules.filter((m) => registry.quiz.includes(m.skill))
  .map((m) => ({ area: m.skill, title: m.title, path: 'ai-platform', module: m.number }))
  .sort((a, b) => a.module - b.module);
const names = AREAS.map((a) => a.area);

const mastery = (levels: Record<string, string>) => ({ onboarding: { status: 'done', at: 1, levels } });
const all = (level: string) => Object.fromEntries(names.map((n) => [n, level]));
const mix = (level: Record<string, string>, rest = 'new') => mastery({ ...all(rest), ...level });

describe('the starting point: which area, and why', () => {
  it('everything new: the first area, "new to you, so we begin here"', () => {
    const { start, rows } = o.summarise(mastery(all('new')));
    expect(rows.map((r) => r.area)).toEqual(names);
    expect(start?.area).toBe(AREAS[0]!.area);
    expect(start?.level).toBe('new');
    expect(start?.why).toBe('You said this is new to you, so we begin here.');
  });

  it('a mix of strong, familiar and new: the first NEW area, not the first area and not a familiar one', () => {
    const { start } = o.summarise(mix({ gateway: 'strong', mcp: 'ok', rag: 'new', otel: 'ok' }));
    expect(start?.area).toBe('rag');
    expect(start?.why).toBe('You said this is new to you, so we begin here.');
    // the new one is further down than a familiar one: new still wins
    expect(o.summarise(mix({ gateway: 'ok', platform: 'new' }, 'strong')).start?.area).toBe('platform');
  });

  it('familiar and strong only: the first familiar area, "you know part of this already"', () => {
    const { start } = o.summarise(mix({ gateway: 'strong', mcp: 'strong', rag: 'ok', otel: 'ok' }, 'strong'));
    expect(start?.area).toBe('rag');
    expect(start?.level).toBe('ok');
    expect(start?.why).toBe('You know part of this already — a good place to build on.');
  });

  it('everything strong: the first area still, and the sentence asks them to pick what to sharpen', () => {
    const { start } = o.summarise(mastery(all('strong')));
    expect(start?.area).toBe(AREAS[0]!.area);
    expect(start?.why).toBe('You know all of this well. Pick the area you want to sharpen.');
  });

  it('no answers at all (an area with no level) counts as new', () => {
    const { rows, start } = o.summarise({});
    expect(rows.every((r) => r.level === 'new')).toBe(true);
    expect(start?.area).toBe(AREAS[0]!.area);
  });

  it('no areas: nothing to recommend, and no throw', () => {
    expect(o.summarise(mastery({}), [])).toEqual({ rows: [], start: null });
  });

  it('rows carry the path and module the area opens (for the button), in module order', () => {
    const { rows } = o.summarise(mastery(all('new')));
    expect(rows.map((r) => [r.path, r.module])).toEqual(AREAS.map((a) => [a.path, a.module]));
  });

  it('says each level in plain words', () => {
    expect(o.LEVEL_LABELS).toEqual({ strong: 'Know it well', ok: 'Some experience', new: 'New to you' });
    const { rows } = o.summarise(mix({ gateway: 'strong', mcp: 'ok' }));
    expect(rows.find((r) => r.area === 'gateway')?.phrase).toBe('Know it well');
    expect(rows.find((r) => r.area === 'mcp')?.phrase).toBe('Some experience');
    expect(rows.find((r) => r.area === 'rag')?.phrase).toBe('New to you');
  });

  it('never names a module number (platform words are scanned by learner-copy.test.ts)', () => {
    const copy = [...Object.values(o.LEVEL_LABELS), ...Object.values(o.START_REASONS)].join('\n');
    expect(copy).not.toMatch(/\bmodule\b|\b\d+\b/i);
  });
});

describe('the starting point follows the next lab', () => {
  it('is the skill that holds the next lab, whatever the quiz levels say', () => {
    const { start, rows } = o.summarise(mix({ gateway: 'new' }), undefined, { slug: 'see-why-a-document-matched', title: 'See why a document matched', skill: 'rag', path: 'ai-platform', module: 3 });
    expect(rows.map((r) => r.area)).toEqual(names);
    expect(start).toMatchObject({ area: 'rag', title: 'Retrieval as a service', path: 'ai-platform', module: 3, level: 'new', lab: { slug: 'see-why-a-document-matched', title: 'See why a document matched' } });
    expect(start?.why).toBe('Your next lab is "See why a document matched".');
  });

  it('can be a skill the quiz does not ask about: a path without modules has no module and no quiz level', () => {
    const { start } = o.summarise(mastery(all('strong')), undefined, { slug: 'duplicate-emails', title: 'Duplicate emails', path: 'production-agents', module: 1 });
    expect(start).toMatchObject({ area: 'agents', title: 'Agent builder', path: 'production-agents', module: null, level: null });
  });

  it('without a next lab (or one in no skill) the quiz levels pick, as before', () => {
    expect(o.summarise(mix({ gateway: 'strong' }), undefined, null).start?.area).toBe('mcp');
    expect(o.summarise(mix({ gateway: 'strong' }), undefined, { slug: 'x', path: 'nowhere', module: 1 }).start?.area).toBe('mcp');
  });

  it('reads the next step of a saved path', () => {
    const path = { steps: [{ slug: 'a', title: 'A', area: 'gateway', status: 'done' }, { slug: 'b', title: 'B', area: 'evals', status: 'next' }, { slug: 'c', title: 'C', area: 'rag', status: 'upcoming' }] };
    expect(o.nextFromPath(path)).toEqual({ slug: 'b', title: 'B', skill: 'evals', path: 'evals-releases', module: null });
    expect(o.nextFromPath({ steps: [{ slug: 'a', area: 'gateway', status: 'done' }] })).toBeNull();
    expect(o.nextFromPath(null)).toBeNull();
  });
});

describe('the goal recap line', () => {
  it('uses the learner\'s own words and the hours', () => {
    expect(o.goalLine({ goal_kind: 'role-ready', goal_text: 'Run our gateway', hours_per_week: 6 })).toBe('Your goal: Run our gateway · about 6 hours a week');
  });

  it('says the kind in words when there is no goal line', () => {
    expect(o.goalLine({ goal_kind: 'explore', goal_text: '', hours_per_week: 4 })).toBe('Your goal: explore · about 4 hours a week');
    expect(o.goalLine({ goal_kind: 'role-ready', goal_text: '', hours_per_week: 2 })).toBe('Your goal: be ready for a role · about 2 hours a week');
    expect(o.goalLine({ goal_kind: 'specific-skill', goal_text: '   ', hours_per_week: 10 })).toBe('Your goal: learn one skill · about 10 hours a week');
  });

  it('one hour is singular; no usable hours leaves them out; an unknown kind is explore', () => {
    expect(o.goalLine({ goal_kind: 'explore', goal_text: '', hours_per_week: 1 })).toBe('Your goal: explore · about 1 hour a week');
    expect(o.goalLine({ goal_kind: 'explore', goal_text: 'x' })).toBe('Your goal: x');
    expect(o.goalLine({ goal_kind: 'nonsense', hours_per_week: 4 })).toBe('Your goal: explore · about 4 hours a week');
  });

  it('is empty without a goal', () => {
    expect(o.goalLine(null)).toBe('');
    expect(o.goalLine(undefined)).toBe('');
  });
});
