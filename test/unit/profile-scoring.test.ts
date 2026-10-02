import { describe, it, expect } from 'vitest';
import { labScore, areaScore, overallScore, skillLevel, DIFFICULTY_WEIGHT } from '../../src/profile/scoring';
import { completionXp, totalXp, xpLevel, XP_LEVELS } from '../../src/profile/xp';
import { deriveLabStates } from '../../src/profile/derive';
import { computeProfile } from '../../src/profile/compute';
import { evaluateArea, evaluateOverall } from '../../src/profile/evaluation';
import { facts, lab, labs, run, session, NOW, MIN, DAY } from './profile-helpers';

describe('labScore', () => {
  it('is 0 for a lab never attempted', () => {
    expect(labScore(null)).toBe(0);
  });

  it('is the best run as a percentage when passed first try with no hints', () => {
    expect(labScore({ score: 100, attempts: 1, hints: 0 })).toBe(100);
    expect(labScore({ score: 50, attempts: 1, hints: 0 })).toBe(50);
  });

  it('takes 5 points off for each hint delivered', () => {
    expect(labScore({ score: 100, attempts: 1, hints: 1 })).toBe(95);
    expect(labScore({ score: 100, attempts: 1, hints: 3 })).toBe(85);
  });

  it('never loses more than 40% of the lab score to hints', () => {
    expect(labScore({ score: 100, attempts: 1, hints: 8 })).toBe(60);
    expect(labScore({ score: 100, attempts: 1, hints: 50 })).toBe(60);
    // The floor is 60% of THIS lab's score, not 60 points.
    expect(labScore({ score: 50, attempts: 1, hints: 50 })).toBe(30);
    expect(labScore({ score: 20, attempts: 1, hints: 1 })).toBe(15); // 20 - 5 = 15, above the 12 floor
  });

  it('takes 3% off per extra attempt, with a floor of 80%', () => {
    expect(labScore({ score: 100, attempts: 2, hints: 0 })).toBeCloseTo(97, 10);
    expect(labScore({ score: 100, attempts: 4, hints: 0 })).toBeCloseTo(91, 10);
    expect(labScore({ score: 100, attempts: 7, hints: 0 })).toBeCloseTo(82, 10);
    expect(labScore({ score: 100, attempts: 8, hints: 0 })).toBeCloseTo(80, 10);
    expect(labScore({ score: 100, attempts: 40, hints: 0 })).toBeCloseTo(80, 10);
  });

  it('applies the hint penalty first and the attempts factor to that', () => {
    expect(labScore({ score: 100, attempts: 3, hints: 2 })).toBeCloseTo(90 * 0.94, 10);
  });
});

describe('areaScore', () => {
  const state = (difficulty: 'intro' | 'core' | 'advanced', best: { score: number; attempts: number; hints: number } | null) => ({
    lab: lab(`l-${Math.random()}`, { difficulty }),
    best,
  });
  const perfect = { score: 100, attempts: 1, hints: 0 };

  it('weights intro 1, core 2, advanced 3', () => {
    expect(DIFFICULTY_WEIGHT).toEqual({ intro: 1, core: 2, advanced: 3 });
    // Only the advanced lab is done: 3 / (1 + 2 + 3) = 50.
    expect(areaScore([state('intro', null), state('core', null), state('advanced', perfect)])).toBe(50);
    // Only the intro lab is done: 1 / 6 = 16.67 -> 17.
    expect(areaScore([state('intro', perfect), state('core', null), state('advanced', null)])).toBe(17);
  });

  it('counts an unattempted lab as zero, so a part-finished area cannot score high', () => {
    expect(areaScore([state('core', perfect), state('core', null)])).toBe(50);
    expect(areaScore([state('core', perfect), state('core', perfect)])).toBe(100);
  });

  it('treats a lab with no difficulty as core', () => {
    const noDifficulty = { lab: lab('x', { difficulty: undefined }), best: perfect };
    expect(areaScore([noDifficulty, state('advanced', null)])).toBe(40); // 2 / 5
  });

  it('is 0 for an area with no labs', () => {
    expect(areaScore([])).toBe(0);
  });

  it('shows at least 1 once something scored, so a started area never reads "Not started"', () => {
    const tiny = { score: 1, attempts: 1, hints: 0 };
    expect(areaScore([state('advanced', tiny), ...Array.from({ length: 20 }, () => state('advanced', null))])).toBe(1);
  });

  it('overall is the rounded mean of the area scores', () => {
    expect(overallScore([100, 50, 0, 0, 0, 0])).toBe(25);
    expect(overallScore([10, 10, 10, 10, 10, 11])).toBe(10);
    expect(overallScore([])).toBe(0);
    expect(overallScore([0, 0, 0, 0, 0, 0])).toBe(0);
  });
});

describe('skill levels', () => {
  it.each([
    [0, 'Not started'],
    [1, 'Foundations'],
    [29, 'Foundations'],
    [30, 'Practitioner'],
    [59, 'Practitioner'],
    [60, 'Proficient'],
    [84, 'Proficient'],
    [85, 'Expert'],
    [100, 'Expert'],
  ] as const)('score %i is %s', (score, name) => {
    expect(skillLevel(score)).toBe(name);
  });
});

describe('per-lab facts from runs', () => {
  const catalogue = [lab('a')];

  it('picks the best run, and ties keep the earliest so a later run cannot move it', () => {
    const states = deriveLabStates(
      facts({
        runs: [
          run('a', { started_at: NOW - 3 * DAY, score: 0.4 }),
          run('a', { started_at: NOW - 2 * DAY, score: 0.8 }),
          run('a', { started_at: NOW - 1 * DAY, score: 0.8 }),
        ],
      }),
      catalogue
    );
    expect(states[0]!.best).toEqual({ score: 80, attempts: 2, hints: 0 });
    expect(states[0]!.completion).toBeNull();
  });

  it('counts the hints of the best run\'s session, not of every session', () => {
    const states = deriveLabStates(
      facts({
        runs: [run('a', { session_id: 's1', started_at: NOW - 3 * DAY, score: 0.5 }), run('a', { session_id: 's2', started_at: NOW - 2 * DAY })],
        sessions: [session('s1', 'a', { hints_delivered: 4 }), session('s2', 'a', { hints_delivered: 2 })],
      }),
      catalogue
    );
    expect(states[0]!.best).toEqual({ score: 100, attempts: 2, hints: 2 });
    expect(states[0]!.completion).toMatchObject({ attempts: 2, hints: 2, first_try: false, no_hints: false });
  });

  it('a partial run that passed all it covered does not beat a run that passed everything', () => {
    const states = deriveLabStates(
      facts({ runs: [run('a', { started_at: NOW - 3 * DAY, score: 1, passed_all: false }), run('a', { started_at: NOW - 2 * DAY, score: 1 })] }),
      catalogue
    );
    expect(states[0]!.best!.attempts).toBe(2);
    expect(states[0]!.completion!.attempts).toBe(2);
  });

  it('ignores runs of an archived lab or one the catalogue does not list', () => {
    const states = deriveLabStates(facts({ runs: [run('a'), run('gone')] }), [lab('a', { archived: true }), lab('b')]);
    expect(states.map((s) => s.lab.slug)).toEqual(['b']);
    expect(states[0]!.runs).toBe(0);
  });

  it('measures how long a completion took from the session start, and flags under half the estimate', () => {
    const start = NOW - DAY;
    const fastRun = run('a', { started_at: start + 9 * MIN, finished_at: start + 9.5 * MIN, session_id: 's1' });
    const [fast] = deriveLabStates(facts({ runs: [fastRun], sessions: [session('s1', 'a', { started_at: start })] }), [lab('a', { estimated_minutes: 20 })]);
    expect(fast!.completion!.minutes).toBeCloseTo(9.5, 5);
    expect(fast!.completion!.fast).toBe(true);

    const slowRun = run('a', { started_at: start + 10 * MIN, finished_at: start + 10 * MIN, session_id: 's1' });
    const [slow] = deriveLabStates(facts({ runs: [slowRun], sessions: [session('s1', 'a', { started_at: start })] }), [lab('a', { estimated_minutes: 20 })]);
    expect(slow!.completion!.fast).toBe(false); // exactly half is not "under" half

    const [noEstimate] = deriveLabStates(facts({ runs: [fastRun], sessions: [session('s1', 'a', { started_at: start })] }), [lab('a')]);
    expect(noEstimate!.completion!.fast).toBe(false);
    const [noSession] = deriveLabStates(facts({ runs: [fastRun] }), [lab('a', { estimated_minutes: 20 })]);
    expect(noSession!.completion!.minutes).toBeNull();
    expect(noSession!.completion!.fast).toBe(false);
  });
});

describe('XP', () => {
  it('pays a base by difficulty plus 25 for no hints and 25 for a first-try pass', () => {
    expect(completionXp('intro', { no_hints: false, first_try: false })).toBe(50);
    expect(completionXp('core', { no_hints: false, first_try: false })).toBe(100);
    expect(completionXp('advanced', { no_hints: false, first_try: false })).toBe(150);
    expect(completionXp('core', { no_hints: true, first_try: false })).toBe(125);
    expect(completionXp('core', { no_hints: false, first_try: true })).toBe(125);
    expect(completionXp('advanced', { no_hints: true, first_try: true })).toBe(200);
  });

  it('is recomputed from the facts, so the same facts always give the same XP and a replay cannot double it', () => {
    const catalogue = [lab('a', { difficulty: 'intro' }), lab('b', { difficulty: 'advanced' }), lab('c')];
    const f = facts({
      runs: [
        run('a', { started_at: NOW - 3 * DAY }), // first try, no hints: 50 + 50
        run('b', { started_at: NOW - 3 * DAY, score: 0.5 }),
        run('b', { started_at: NOW - 2 * DAY }), // second try, no hints: 150 + 25
        run('b', { started_at: NOW - 1 * DAY }), // a repeat pass adds nothing
      ],
    });
    const once = computeProfile(f, catalogue).xp;
    expect(once).toBe(100 + 175);
    expect(computeProfile(f, catalogue).xp).toBe(once);
    expect(computeProfile({ ...f, runs: [...f.runs, ...f.runs.map((r) => ({ ...r }))] }, catalogue).xp).toBe(once);
  });

  it('labs in no area still give XP, and an archived lab gives none', () => {
    const catalogue = [lab('free', { path: 'production-agents', module: 1 }), lab('old', { archived: true })];
    expect(computeProfile(facts({ runs: [run('free'), run('old')] }), catalogue).xp).toBe(150);
  });

  it('totalXp sums completions only', () => {
    expect(totalXp([{ lab: lab('x'), completion: null }])).toBe(0);
  });

  it('levels: ten titled levels, rising thresholds, the band reported as xp_into / xp_needed', () => {
    expect(XP_LEVELS).toHaveLength(10);
    expect(XP_LEVELS.map((l) => l.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let i = 1; i < XP_LEVELS.length; i++) expect(XP_LEVELS[i]!.at).toBeGreaterThan(XP_LEVELS[i - 1]!.at);
    for (const l of XP_LEVELS) expect(l.title.length).toBeGreaterThan(0);
    expect(xpLevel(0)).toEqual({ n: 1, title: 'Newcomer', xp_into: 0, xp_needed: 100 });
    expect(xpLevel(99)).toEqual({ n: 1, title: 'Newcomer', xp_into: 99, xp_needed: 100 });
    expect(xpLevel(100)).toEqual({ n: 2, title: 'Explorer', xp_into: 0, xp_needed: 150 });
    expect(xpLevel(260)).toEqual({ n: 3, title: 'Apprentice', xp_into: 10, xp_needed: 250 });
    expect(xpLevel(4600)).toEqual({ n: 10, title: 'Legend', xp_into: 0, xp_needed: 0 });
    expect(xpLevel(9000)).toEqual({ n: 10, title: 'Legend', xp_into: 4400, xp_needed: 0 });
    expect(xpLevel(-5).n).toBe(1);
  });
});

describe('computeProfile skills', () => {
  const catalogue = [...labs(3, 1, { path: 'ai-platform' }), ...labs(2, 2)];

  it('gives all six areas, in quiz order, with zero scores and no next lab for areas with no labs', () => {
    const p = computeProfile(facts(), []);
    expect(p.skills.map((s) => s.area)).toEqual(['gateway', 'mcp', 'rag', 'otel', 'platform', 'sovereignty']);
    expect(p.skills.every((s) => s.score === 0 && s.level === 'Not started' && s.labs_total === 0 && s.next_lab === null)).toBe(true);
    expect(p.overall).toMatchObject({ score: 0, level: 'Not started' });
    expect(p.xp).toBe(0);
    expect(p.level).toMatchObject({ n: 1, xp_into: 0 });
  });

  it('scores the area over all its labs and reports labs done, total and the next lab by catalogue order', () => {
    const p = computeProfile(facts({ runs: [run('m1-lab-1'), run('m1-lab-2', { score: 0.5 })] }), catalogue);
    const gateway = p.skills.find((s) => s.area === 'gateway')!;
    // lab 1 = 100, lab 2 = 50, lab 3 = 0, all core: 150 / 3 = 50.
    expect(gateway.score).toBe(50);
    expect(gateway.level).toBe('Practitioner');
    expect(gateway.labs_done).toBe(1);
    expect(gateway.labs_total).toBe(3);
    expect(gateway.next_lab).toEqual({ slug: 'm1-lab-2', title: 'Lab m1-lab-2' });
    expect(p.skills.find((s) => s.area === 'mcp')!.score).toBe(0);
    // Overall is the mean of the six areas: 50 / 6 = 8.33.
    expect(p.overall.score).toBe(8);
    expect(p.overall.level).toBe('Foundations');
  });

  it('next lab prefers one whose prerequisites are done', () => {
    const cat = [lab('a', { order: 1 }), lab('b', { order: 2, prerequisites: ['c'] }), lab('c', { order: 3 })];
    const p = computeProfile(facts({ runs: [run('a')] }), cat);
    expect(p.skills[0]!.next_lab!.slug).toBe('c');
  });

  it('next lab is null once the area is finished', () => {
    const p = computeProfile(facts({ runs: labs(3).map((l) => run(l.slug)) }), labs(3));
    expect(p.skills[0]).toMatchObject({ labs_done: 3, labs_total: 3, next_lab: null, score: 100, level: 'Expert' });
  });

  it('a lab in no area scores nothing but is still counted for XP', () => {
    const p = computeProfile(facts({ runs: [run('x')] }), [lab('x', { path: 'production-agents', module: 1 })]);
    expect(p.skills.every((s) => s.score === 0)).toBe(true);
    expect(p.xp).toBe(150);
  });

  it('carries the quiz result as a starting level and never scores it', () => {
    const a = computeProfile(facts({ starting_levels: { gateway: 'strong', mcp: 'new' } }), catalogue);
    const b = computeProfile(facts(), catalogue);
    expect(a.skills.find((s) => s.area === 'gateway')!.starting_level).toBe('strong');
    expect(a.skills.find((s) => s.area === 'rag')!.starting_level).toBeNull();
    expect(a.skills.map((s) => s.score)).toEqual(b.skills.map((s) => s.score));
    expect(a.overall.score).toBe(b.overall.score);
  });

  it('is deterministic: the same facts give the same profile', () => {
    const f = facts({ runs: [run('m1-lab-1'), run('m2-lab-1', { score: 0.7 })] });
    expect(computeProfile(f, catalogue)).toEqual(computeProfile({ ...f }, [...catalogue].reverse()));
  });
});

describe('evaluation text', () => {
  const base = { title: 'Retrieval', level: 'Practitioner' as const, labsDone: 2, labsTotal: 5, attempted: true, nextLab: 'Build the index', usedHints: false, retried: false };

  it('invites a learner who has not started to begin with the first lab', () => {
    expect(evaluateArea({ ...base, attempted: false, level: 'Not started', labsDone: 0 })).toBe('You have not started Retrieval yet. A good place to begin is "Build the index".');
  });

  it('says so when the area has no labs', () => {
    expect(evaluateArea({ ...base, labsTotal: 0, nextLab: null })).toBe('There are no labs in Retrieval yet. Check back soon.');
  });

  it('names a strength for the level and the next lab', () => {
    expect(evaluateArea(base)).toBe('You can work through Retrieval on your own: 2 of 5 labs finished. Next up: "Build the index".');
    expect(evaluateArea({ ...base, level: 'Foundations', labsDone: 1 })).toContain('You have made a start in Retrieval: 1 of 5 labs finished.');
    expect(evaluateArea({ ...base, level: 'Proficient' })).toContain('You are confident in Retrieval');
    expect(evaluateArea({ ...base, level: 'Expert' })).toContain('You have a strong command of Retrieval');
  });

  it('gives one tip: no hints beats first attempt, and an expert gets none', () => {
    expect(evaluateArea({ ...base, usedHints: true, retried: true })).toMatch(/without hints/);
    expect(evaluateArea({ ...base, retried: true })).toMatch(/first attempt/);
    expect(evaluateArea({ ...base, level: 'Expert', usedHints: true })).not.toMatch(/hints/);
  });

  it('says the area is finished when no lab is left', () => {
    expect(evaluateArea({ ...base, labsDone: 5, nextLab: null })).toMatch(/You have finished every lab here\.$/);
  });

  it('covers an area tried but not yet passing', () => {
    expect(evaluateArea({ ...base, level: 'Not started', labsDone: 0 })).toContain('no lab is passing yet');
  });

  it('uses no implementation words', () => {
    const texts = [
      evaluateArea(base),
      evaluateArea({ ...base, usedHints: true }),
      evaluateArea({ ...base, labsDone: 5, nextLab: null }),
      evaluateOverall({ level: 'Proficient', attempted: true, areas: [{ title: 'A', score: 80 }, { title: 'B', score: 10 }] }),
    ];
    for (const t of texts) expect(t).not.toMatch(/session|check run|database|D1|API|json|sql|worker|score formula|recompute/i);
  });

  it('summarises overall: not started, then strongest and weakest, nothing about a tie', () => {
    expect(evaluateOverall({ level: 'Not started', attempted: false, areas: [] })).toMatch(/not started any labs/);
    expect(evaluateOverall({ level: 'Practitioner', attempted: true, areas: [{ title: 'Gateway', score: 70 }, { title: 'Retrieval', score: 20 }, { title: 'Tracing', score: 40 }] })).toBe(
      'Overall you are at Practitioner level. Your strongest area is Gateway, and Retrieval has the most room to grow.'
    );
    expect(evaluateOverall({ level: 'Foundations', attempted: true, areas: [{ title: 'Gateway', score: 5 }, { title: 'Retrieval', score: 5 }] })).toBe('Overall you are at Foundations level.');
  });
});
