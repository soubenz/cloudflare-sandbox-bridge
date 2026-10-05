import { describe, it, expect } from 'vitest';
import { awardDefinitions, AWARD_ICONS, type AwardContext } from '../../src/profile/awards';
import { comebackAt, deriveStreak, utcDay, dayString } from '../../src/profile/derive';
import { computeProfile, compactProfile, pendingAwards } from '../../src/profile/compute';
import { AREAS } from '../../src/profile/areas';
import type { CatalogueLab, EarnedAward, Profile, ProfileFacts } from '../../src/profile/types';
import { facts, lab, labs, run, session, NOW, MIN, DAY } from './profile-helpers';

const HOUR = 3_600_000;
const MIDNIGHT = Date.UTC(2026, 0, 6, 0, 0, 0); // a UTC midnight

/** A passing run at an exact time. */
const passAt = (slug: string, at: number, extra = {}) => run(slug, { started_at: at, finished_at: at, ...extra });

function awardOf(p: Profile, id: string): { earned: EarnedAward | undefined; locked: Profile['awards']['locked'][number] | undefined } {
  return { earned: p.awards.earned.find((a) => a.id === id), locked: p.awards.locked.find((a) => a.id === id) };
}
const isEarned = (p: Profile, id: string) => awardOf(p, id).earned !== undefined;

describe('streaks, at UTC midnight and around it', () => {
  const streakOf = (times: number[], now = NOW) => deriveStreak(times.map((t) => passAt('a', t)), now).streak;

  it('has no streak without a passing run, and ignores runs that did not pass', () => {
    expect(streakOf([])).toEqual({ days: 0, best: 0, last_active: null });
    expect(deriveStreak([run('a', { score: 0.5, started_at: NOW - HOUR })], NOW).streak.days).toBe(0);
  });

  it('counts consecutive UTC days, several runs on one day counting once', () => {
    const times = [MIDNIGHT - 2 * DAY + 5 * HOUR, MIDNIGHT - 2 * DAY + 9 * HOUR, MIDNIGHT - DAY + HOUR, MIDNIGHT + HOUR];
    expect(streakOf(times, MIDNIGHT + 2 * HOUR)).toEqual({ days: 3, best: 3, last_active: '2026-01-06' });
  });

  it('23:59:59.999 and 00:00:00.000 are different days', () => {
    expect(utcDay(MIDNIGHT - 1)).toBe(utcDay(MIDNIGHT) - 1);
    expect(dayString(utcDay(MIDNIGHT - 1))).toBe('2026-01-05');
    expect(dayString(utcDay(MIDNIGHT))).toBe('2026-01-06');
    // A pass one millisecond before midnight and one exactly at it are two days in a row.
    expect(streakOf([MIDNIGHT - 1, MIDNIGHT], MIDNIGHT + HOUR).days).toBe(2);
  });

  it('two passes 24 hours apart by the clock but on the same UTC day are one day, not two', () => {
    expect(streakOf([MIDNIGHT + 1, MIDNIGHT + DAY - 1], MIDNIGHT + HOUR).best).toBe(1);
  });

  it('a pass at 23:59 and the next at 00:01 is a streak of 2 although only two minutes apart', () => {
    expect(streakOf([MIDNIGHT - MIN, MIDNIGHT + MIN], MIDNIGHT + HOUR).days).toBe(2);
  });

  it('a skipped day breaks the streak but keeps `best`', () => {
    const times = [MIDNIGHT - 5 * DAY, MIDNIGHT - 4 * DAY, MIDNIGHT - 3 * DAY, MIDNIGHT - HOUR];
    expect(streakOf(times, MIDNIGHT + HOUR)).toEqual({ days: 1, best: 3, last_active: '2026-01-05' });
  });

  it('stays alive through the day after the last active day, and ends the moment that day is over', () => {
    const last = MIDNIGHT - 12 * HOUR; // Jan 5, 12:00
    const times = [last - DAY, last];
    expect(streakOf(times, MIDNIGHT + 23 * HOUR + 59 * MIN).days).toBe(2); // still Jan 6: alive
    expect(streakOf(times, MIDNIGHT + DAY).days).toBe(0); // Jan 7 00:00: broken
    expect(streakOf(times, MIDNIGHT + DAY).best).toBe(2);
  });

  it('uses the run\'s finish time, falling back to its start', () => {
    const r = run('a', { started_at: MIDNIGHT - 10 * MIN, finished_at: MIDNIGHT + 10 * MIN });
    expect(deriveStreak([r], MIDNIGHT + HOUR).streak.last_active).toBe('2026-01-06');
    const open = run('a', { started_at: MIDNIGHT - 10 * MIN, finished_at: null });
    expect(deriveStreak([open], MIDNIGHT + HOUR).streak.last_active).toBe('2026-01-05');
  });
});

describe('streak awards', () => {
  const days = (n: number, endingAt = NOW) => Array.from({ length: n }, (_, i) => passAt('a', endingAt - i * DAY));
  const cat = [lab('a')];

  it('streak-3-days is earned at three consecutive days, not at two', () => {
    expect(isEarned(computeProfile(facts({ runs: days(2) }), cat), 'streak-3-days')).toBe(false);
    expect(isEarned(computeProfile(facts({ runs: days(3) }), cat), 'streak-3-days')).toBe(true);
    expect(awardOf(computeProfile(facts({ runs: days(2) }), cat), 'streak-3-days').locked!.progress).toEqual({ have: 2, need: 3 });
  });

  it('streak-7-days needs seven, and a week with a gap does not count', () => {
    expect(isEarned(computeProfile(facts({ runs: days(7) }), cat), 'streak-7-days')).toBe(true);
    expect(isEarned(computeProfile(facts({ runs: days(6) }), cat), 'streak-7-days')).toBe(false);
    const gap = [...days(3), ...days(4, NOW - 4 * DAY)];
    expect(isEarned(computeProfile(facts({ runs: gap }), cat), 'streak-7-days')).toBe(false);
    expect(isEarned(computeProfile(facts({ runs: gap }), cat), 'streak-3-days')).toBe(true);
  });

  it('an earned streak award survives the streak breaking (best counts), and a stale streak shows 0 days', () => {
    const old = days(3, NOW - 30 * DAY);
    const p = computeProfile(facts({ runs: old }), cat);
    expect(p.streak).toMatchObject({ days: 0, best: 3 });
    expect(isEarned(p, 'streak-3-days')).toBe(true);
  });
});

describe('the fixed awards', () => {
  const cat = labs(12);

  it('first-lab: one completed lab', () => {
    const none = computeProfile(facts({ runs: [run('m1-lab-1', { score: 0.5 })] }), cat);
    expect(awardOf(none, 'first-lab').locked!.progress).toEqual({ have: 0, need: 1 });
    const one = computeProfile(facts({ runs: [passAt('m1-lab-1', NOW - DAY)] }), cat);
    expect(awardOf(one, 'first-lab').earned).toMatchObject({ tier: 'bronze', earned_at: NOW - DAY + 0 });
  });

  it('first-try-pass: the first run of a lab passed; a pass on the second try is not enough', () => {
    const second = computeProfile(facts({ runs: [run('m1-lab-1', { started_at: NOW - 2 * DAY, score: 0.5 }), run('m1-lab-1', { started_at: NOW - DAY })] }), cat);
    expect(isEarned(second, 'first-try-pass')).toBe(false);
    const first = computeProfile(facts({ runs: [run('m1-lab-1', { started_at: NOW - DAY })] }), cat);
    expect(isEarned(first, 'first-try-pass')).toBe(true);
  });

  it('no-hints-finish: a completion in a session where no hint unlocked', () => {
    const hinted = facts({ runs: [run('m1-lab-1', { session_id: 's1' })], sessions: [session('s1', 'm1-lab-1', { hints_delivered: 1 })] });
    expect(isEarned(computeProfile(hinted, cat), 'no-hints-finish')).toBe(false);
    const clean = facts({ runs: [run('m1-lab-1', { session_id: 's1' })], sessions: [session('s1', 'm1-lab-1', { hints_delivered: 0 })] });
    expect(isEarned(computeProfile(clean, cat), 'no-hints-finish')).toBe(true);
  });

  it('three-labs and ten-labs count distinct completed labs, with progress, and a lab passed twice counts once', () => {
    const passes = (n: number) => cat.slice(0, n).map((l, i) => passAt(l.slug, NOW - (n - i) * DAY));
    const two = computeProfile(facts({ runs: [...passes(2), passAt('m1-lab-1', NOW - HOUR)] }), cat);
    expect(awardOf(two, 'three-labs').locked!.progress).toEqual({ have: 2, need: 3 });
    const three = computeProfile(facts({ runs: passes(3) }), cat);
    expect(awardOf(three, 'three-labs').earned!.earned_at).toBe(NOW - DAY); // when the third lab was finished
    expect(awardOf(three, 'ten-labs').locked!.progress).toEqual({ have: 3, need: 10 });
    const ten = computeProfile(facts({ runs: passes(10) }), cat);
    expect(awardOf(ten, 'ten-labs').earned).toMatchObject({ tier: 'silver', earned_at: NOW - DAY });
  });

  it('speed-run: finished in under half the estimated time, not exactly half', () => {
    const c = [lab('a', { estimated_minutes: 40 })];
    const start = NOW - DAY;
    const at = (mins: number) =>
      computeProfile(facts({ runs: [run('a', { session_id: 's', started_at: start + mins * MIN, finished_at: start + mins * MIN })], sessions: [session('s', 'a', { started_at: start })] }), c);
    expect(isEarned(at(19), 'speed-run')).toBe(true);
    expect(isEarned(at(20), 'speed-run')).toBe(false);
    expect(awardOf(at(20), 'speed-run').locked!.progress).toEqual({ have: 0, need: 1 });
  });

  it('comeback: a pass after a failed run in the SAME session, not after a failure in another', () => {
    const c = [lab('a')];
    const same = facts({
      runs: [run('a', { session_id: 's1', started_at: NOW - 2 * DAY, score: 0.5 }), run('a', { session_id: 's1', started_at: NOW - 2 * DAY + MIN })],
    });
    expect(awardOf(computeProfile(same, c), 'comeback').earned!.earned_at).toBe(NOW - 2 * DAY + MIN + 1000);
    const other = facts({
      runs: [run('a', { session_id: 's1', started_at: NOW - 2 * DAY, score: 0.5 }), run('a', { session_id: 's2', started_at: NOW - DAY })],
    });
    expect(isEarned(computeProfile(other, c), 'comeback')).toBe(false);
    const onlyPass = facts({ runs: [run('a', { session_id: 's1' })] });
    expect(isEarned(computeProfile(onlyPass, c), 'comeback')).toBe(false);
  });

  it('comeback ignores a subset run that passed what it covered', () => {
    const subset = run('a', { session_id: 's1', started_at: NOW - 2 * DAY, score: 1, passed_all: false });
    expect(comebackAt([subset, run('a', { session_id: 's1', started_at: NOW - DAY })])).toBeNull();
  });

  it('all-six-areas: every area at Foundations or better, with progress counting areas', () => {
    const cat6 = AREAS.map((a) => lab(`lab-${a.id}`, { path: a.path, module: a.module }));
    const five = computeProfile(facts({ runs: cat6.slice(0, 5).map((l) => run(l.slug)) }), cat6);
    expect(awardOf(five, 'all-six-areas').locked!.progress).toEqual({ have: 5, need: 6 });
    const six = computeProfile(facts({ runs: cat6.map((l) => run(l.slug)) }), cat6);
    expect(awardOf(six, 'all-six-areas').earned).toMatchObject({ tier: 'gold' });
  });

  it('all-six-areas is not earned on a catalogue with labs in only some areas, even with an empty area scoring 0', () => {
    const p = computeProfile(facts({ runs: [run('m1-lab-1')] }), labs(2));
    expect(isEarned(p, 'all-six-areas')).toBe(false);
  });
});

describe('area awards', () => {
  // One gateway module of four core labs.
  const cat = labs(4);

  it('area-proficient at 60 and area-expert at 85, from the area score', () => {
    const runsWith = (scores: number[]) => cat.map((l, i) => run(l.slug, { score: scores[i]!, passed_all: scores[i] === 1 }));
    const fifty = computeProfile(facts({ runs: runsWith([1, 1, 0, 0]) }), cat); // 50
    expect(isEarned(fifty, 'area-proficient-gateway')).toBe(false);
    expect(awardOf(fifty, 'area-proficient-gateway').locked!.progress).toEqual({ have: 50, need: 60 });

    const sixty = computeProfile(facts({ runs: runsWith([1, 1, 1, 0.4]) }), cat); // (300 + 40) / 4 = 85
    expect(sixty.skills[0]!.score).toBe(85);
    expect(isEarned(sixty, 'area-proficient-gateway')).toBe(true);
    expect(isEarned(sixty, 'area-expert-gateway')).toBe(true);

    const sixtyFive = computeProfile(facts({ runs: runsWith([1, 1, 0.4, 0]) }), cat); // 60 exactly
    expect(sixtyFive.skills[0]!.score).toBe(60);
    expect(isEarned(sixtyFive, 'area-proficient-gateway')).toBe(true);
    expect(isEarned(sixtyFive, 'area-expert-gateway')).toBe(false);

    const eightyFour = computeProfile(facts({ runs: runsWith([1, 1, 1, 0.36]) }), cat); // 84
    expect(eightyFour.skills[0]!.score).toBe(84);
    expect(isEarned(eightyFour, 'area-expert-gateway')).toBe(false);
  });

  it('every area has its own pair, and an unmapped lab earns none', () => {
    const p = computeProfile(facts(), []);
    for (const a of AREAS) {
      expect(awardOf(p, `area-proficient-${a.id}`).locked).toBeDefined();
      expect(awardOf(p, `area-expert-${a.id}`).locked).toBeDefined();
    }
    const unmapped = computeProfile(facts({ runs: [run('x')] }), [lab('x', { path: 'production-agents', module: 1 })]);
    expect(unmapped.awards.earned.filter((a) => a.id.startsWith('area-')).length).toBe(0);
  });
});

describe('module and path awards', () => {
  // ai-platform has modules 1 and 2; production-agents has one module.
  const cat: CatalogueLab[] = [
    ...labs(2, 1),
    ...labs(2, 2),
    lab('pa-1', { path: 'production-agents', module: 1, order: 1 }),
    lab('pa-2', { path: 'production-agents', module: 1, order: 2 }),
    lab('hidden', { archived: true, order: 9 }),
  ];

  it('generates one module award per module of a multi-module path, and none for a one-module path', () => {
    const p = computeProfile(facts(), cat);
    const ids = [...p.awards.earned, ...p.awards.locked].map((a) => a.id).filter((id) => id.startsWith('module-complete-'));
    expect(ids).toEqual(['module-complete-ai-platform-1', 'module-complete-ai-platform-2']);
  });

  it('module-complete: all of the module\'s labs, with progress, ignoring archived labs', () => {
    const partial = computeProfile(facts({ runs: [run('m1-lab-1')] }), cat);
    expect(awardOf(partial, 'module-complete-ai-platform-1').locked!.progress).toEqual({ have: 1, need: 2 });
    const done = computeProfile(facts({ runs: [passAt('m1-lab-1', NOW - 2 * DAY), passAt('m1-lab-2', NOW - DAY)] }), cat);
    expect(awardOf(done, 'module-complete-ai-platform-1').earned).toMatchObject({ tier: 'silver', earned_at: NOW - DAY });
    expect(isEarned(done, 'module-complete-ai-platform-2')).toBe(false);
  });

  it('path-complete: every lab of the path, one award per path', () => {
    const half = computeProfile(facts({ runs: [run('pa-1')] }), cat);
    expect(awardOf(half, 'path-complete-production-agents').locked!.progress).toEqual({ have: 1, need: 2 });
    const all = computeProfile(facts({ runs: [run('pa-1'), run('pa-2')] }), cat);
    expect(awardOf(all, 'path-complete-production-agents').earned).toMatchObject({ tier: 'gold' });
    expect(awardOf(all, 'path-complete-ai-platform').locked).toBeDefined();
  });

  it('titles come from the catalogue metadata', () => {
    const p = computeProfile(facts(), cat);
    expect(awardOf(p, 'module-complete-ai-platform-1').locked!.title).toBe('Module complete: Gateway and access');
    expect(awardOf(p, 'path-complete-production-agents').locked!.title).toBe('Path complete: Agent builder');
  });
});

describe('award data', () => {
  const p = computeProfile(facts(), [...labs(2, 1), ...labs(2, 2)]);
  const all = [...p.awards.earned, ...p.awards.locked];

  it('has the fixed awards of the spec and unique ids', () => {
    const ids = all.map((a) => a.id);
    for (const id of ['first-lab', 'first-try-pass', 'no-hints-finish', 'three-labs', 'ten-labs', 'streak-3-days', 'streak-7-days', 'speed-run', 'comeback', 'all-six-areas']) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses only icons from the fixed list, valid tiers, and a title and description each', () => {
    for (const a of all) {
      expect(AWARD_ICONS as readonly string[], a.id).toContain(a.icon);
      expect(['bronze', 'silver', 'gold'], a.id).toContain(a.tier);
      expect(a.title.length, a.id).toBeGreaterThan(0);
      expect(a.description.length, a.id).toBeGreaterThan(0);
    }
  });

  it('gives every locked award a progress with have <= need and need >= 1', () => {
    for (const a of p.awards.locked) {
      expect(a.progress.need, a.id).toBeGreaterThanOrEqual(1);
      expect(a.progress.have, a.id).toBeLessThanOrEqual(a.progress.need);
      expect(a.progress.have, a.id).toBeGreaterThanOrEqual(0);
    }
  });

  it('is a pure function of the context: definitions evaluate without touching anything else', () => {
    const ctx: AwardContext = {
      now: NOW,
      completions: [],
      streak: { days: 0, best: 0 },
      areas: [{ id: 'gateway', title: 'LLM gateway', score: 0 }],
      modules: [],
      paths: [],
      comeback_at: null,
    };
    const defs = awardDefinitions(ctx);
    expect(defs.every((d) => d.evaluate(ctx).earned === false)).toBe(true);
    expect(defs.map((d) => d.id)).toContain('area-expert-gateway');
  });
});

describe('earned awards are stable', () => {
  const cat = labs(3);

  it('a stored award keeps its stored earned_at and session, whatever the facts now say', () => {
    const f = facts({ runs: [passAt('m1-lab-1', NOW - DAY)], earned: [{ award_id: 'first-lab', earned_at: 123, session_id: 'old-session' }] });
    expect(awardOf(computeProfile(f, cat), 'first-lab').earned).toMatchObject({ earned_at: 123, session_id: 'old-session' });
  });

  it('a stored award stays earned even after the facts would no longer earn it', () => {
    const f = facts({ earned: [{ award_id: 'area-proficient-gateway', earned_at: 5, session_id: null }] });
    expect(isEarned(computeProfile(f, cat), 'area-proficient-gateway')).toBe(true);
  });

  it('a stored award whose definition is gone is not shown', () => {
    const f = facts({ earned: [{ award_id: 'module-complete-retired-1', earned_at: 5, session_id: null }] });
    expect(isEarned(computeProfile(f, cat), 'module-complete-retired-1')).toBe(false);
  });

  it('pendingAwards is exactly the earned awards that are not stored', () => {
    const f = facts({ runs: [passAt('m1-lab-1', NOW - DAY)] });
    const first = computeProfile(f, cat);
    const pending = pendingAwards(first, f.earned).map((a) => a.id);
    expect(pending.sort()).toEqual(['first-lab', 'first-try-pass', 'no-hints-finish']);
    const stored = pending.map((id) => ({ award_id: id, earned_at: 1, session_id: null }));
    expect(pendingAwards(computeProfile({ ...f, earned: stored }, cat), stored)).toEqual([]);
  });

  it('lists earned awards newest first and locked ones in definition order', () => {
    const f = facts({ runs: [passAt('m1-lab-1', NOW - 3 * DAY), passAt('m1-lab-2', NOW - 2 * DAY), passAt('m1-lab-3', NOW - DAY)] });
    const p = computeProfile(f, cat);
    const times = p.awards.earned.map((a) => a.earned_at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(p.awards.earned[0]!.id).not.toBe('first-lab');
  });
});

describe('compact profile', () => {
  it('has overall, level, xp, streak, the top three skills and the last three awards', () => {
    const cat = [...labs(1, 1), ...labs(1, 2), ...labs(1, 3), ...labs(1, 4)];
    const f = facts({
      runs: [passAt('m1-lab-1', NOW - 5 * DAY), passAt('m2-lab-1', NOW - 4 * DAY), passAt('m3-lab-1', NOW - 3 * DAY, { score: 1 }), run('m4-lab-1', { score: 0.5, started_at: NOW - 2 * DAY })],
    });
    const full = computeProfile(f, cat);
    const compact = compactProfile(full);
    expect(Object.keys(compact).sort()).toEqual(['level', 'overall', 'recent_awards', 'streak', 'top_skills', 'updated_at', 'user_id', 'xp']);
    expect(compact.top_skills).toHaveLength(3);
    expect(compact.top_skills.map((s) => s.score)).toEqual([...compact.top_skills.map((s) => s.score)].sort((a, b) => b - a));
    expect(compact.top_skills.map((s) => s.area)).toEqual(['gateway', 'mcp', 'rag']); // ties keep area order
    expect(compact.recent_awards).toEqual(full.awards.earned.slice(0, 3));
    expect(compact.xp).toBe(full.xp);
    expect(compact.level).toEqual(full.level);
    expect(compact.streak).toEqual(full.streak);
    expect(compact.overall).toEqual(full.overall);
  });

  it('is well formed for a learner with nothing', () => {
    const c = compactProfile(computeProfile(facts({ user_id: 'nobody' }), []));
    expect(c).toMatchObject({ user_id: 'nobody', xp: 0, recent_awards: [], overall: { score: 0, level: 'Not started' }, streak: { days: 0, best: 0, last_active: null } });
    expect(c.top_skills).toHaveLength(3);
  });
});

describe('full profile shape', () => {
  it('matches the documented keys', () => {
    const p: ProfileFacts = facts();
    const profile = computeProfile(p, labs(2));
    expect(Object.keys(profile).sort()).toEqual(['awards', 'level', 'overall', 'skills', 'streak', 'updated_at', 'user_id', 'xp']);
    expect(Object.keys(profile.skills[0]!).sort()).toEqual(['area', 'evaluation', 'labs_done', 'labs_total', 'level', 'next_lab', 'score', 'starting_level', 'title']);
    expect(Object.keys(profile.level).sort()).toEqual(['n', 'title', 'xp_into', 'xp_needed']);
    expect(Object.keys(profile.streak).sort()).toEqual(['best', 'days', 'last_active']);
    expect(Object.keys(profile.overall).sort()).toEqual(['evaluation', 'level', 'score']);
    expect(profile.updated_at).toBe(NOW);
  });
});
