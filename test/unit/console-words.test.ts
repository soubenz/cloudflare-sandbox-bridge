import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The console's one vocabulary (dashboard/src/words.js): every sentence for time, progress, status, quiz levels,
 * skill and rank, and plan locks, in one place. A renderer never words these itself, so these tests pin the
 * words, and the last block pins that the pages and the service say the same ones.
 */
type Words = {
  minutesLabel: (n: unknown) => string;
  approxMinutes: (n: unknown) => string;
  labTime: (n: unknown) => string;
  approxTime: (n: unknown) => string;
  labCount: (n: number) => string;
  moduleCount: (n: number) => string;
  labsDone: (done: number, total: number) => string;
  STATUS_WORDS: Record<string, string>;
  statusWord: (key: string) => string;
  STATUS_FILTERS: Array<[string, string]>;
  difficultyWord: (v: string) => string;
  familyWord: (v: string) => string;
  labTypeLabel: (type: unknown) => string;
  WARM_UP_CHIP: string;
  labButtonWord: (lab?: { type?: string; locked?: boolean; running?: boolean; done?: boolean }) => string;
  QUIZ_LEVELS: Record<string, string>;
  quizLevelWord: (v: unknown) => string;
  skillLevelLabel: (name: string) => string;
  rankLabel: (title: string) => string;
  xpGainText: (n: number) => string;
  skillChangeText: (title: string, from: number, to: number) => string;
  nextLabText: (title: string) => string;
  PLAN_LOCK_SHORT: string;
  PLAN_LOCK_LONG: string;
  isPlanLockWhy: (why: unknown) => boolean;
};
const words = (await import('../../dashboard/src/words.js' as string)) as Words;

describe('time', () => {
  it('writes a lab\'s length as hours and minutes: 1 h 45 min', () => {
    expect(words.labTime(105)).toBe('1 h 45 min');
    expect(words.labTime(45)).toBe('45 min');
    expect(words.labTime(120)).toBe('2 h');
    expect(words.labTime(30.4)).toBe('30 min');
  });
  it('has no length for a lab without one', () => {
    for (const bad of [0, -5, NaN, undefined, null, 'abc']) expect(words.labTime(bad)).toBe('');
  });
  it('writes a path\'s or module\'s length as About 21 h, rounded the way people say it', () => {
    expect(words.approxTime(1230)).toBe('About 21 h');
    expect(words.approxTime(125)).toBe('About 2 h');
    expect(words.approxTime(325)).toBe('About 5.5 h');
    expect(words.approxTime(43)).toBe('About 45 min');
    expect(words.approxTime(0)).toBe('');
    expect(words.approxTime(NaN)).toBe('');
  });
  it('keeps the two helpers the launcher has always had', () => {
    expect(words.minutesLabel(130)).toBe('2 h 10 min');
    expect(words.approxMinutes(1230)).toBe('21 h');
  });
});

describe('progress', () => {
  it('says 3 of 31 labs done, and counts a single lab in the singular', () => {
    expect(words.labsDone(3, 31)).toBe('3 of 31 labs done');
    expect(words.labsDone(0, 1)).toBe('0 of 1 lab done');
    expect(words.labsDone(0, 0)).toBe('0 of 0 labs done');
  });
  it('counts labs and modules', () => {
    expect([words.labCount(1), words.labCount(2), words.moduleCount(1), words.moduleCount(7)]).toEqual(['1 lab', '2 labs', '1 module', '7 modules']);
  });
});

describe('status', () => {
  it('has five words: Not started, In progress, Done, Next up, Locked', () => {
    expect(words.STATUS_WORDS).toEqual({ todo: 'Not started', started: 'In progress', done: 'Done', next: 'Next up', locked: 'Locked' });
  });
  it('calls a step that comes later Not started, never "Coming up"', () => {
    expect(words.statusWord('upcoming')).toBe('Not started');
    expect(Object.values(words.STATUS_WORDS)).not.toContain('Coming up');
    expect(words.statusWord('nonsense')).toBe('Not started');
  });
  it('lets the catalogue filter by Not started, In progress and Done', () => {
    expect(words.STATUS_FILTERS).toEqual([
      ['todo', 'Not started'],
      ['started', 'In progress'],
      ['done', 'Done'],
    ]);
  });
});

describe('filters', () => {
  it('capitalises the difficulties and the families', () => {
    expect(['intro', 'core', 'advanced'].map(words.difficultyWord)).toEqual(['Intro', 'Core', 'Advanced']);
    expect(words.familyWord('build')).toBe('Build');
    expect(words.familyWord('agent-foundations')).toBe('Agent foundations');
    expect(words.familyWord(undefined as unknown as string)).toBe('');
  });
});

describe('lab types and the button', () => {
  it('words the five types and writes an unknown one as it is', () => {
    expect(['build', 'break-fix', 'scale', 'explore', 'warm-up'].map(words.labTypeLabel)).toEqual(['Build', 'Fix it', 'Scale', 'Explore', 'Warm-up']);
    expect(words.labTypeLabel('mystery')).toBe('mystery');
    expect(words.labTypeLabel(undefined)).toBe('');
    expect(words.WARM_UP_CHIP).toBe('Start here');
  });
  it('says Start, but Open for a warm-up, with the same Locked, Resume and Open again for both', () => {
    expect(words.labButtonWord({ type: 'build' })).toBe('Start');
    expect(words.labButtonWord({})).toBe('Start');
    expect(words.labButtonWord({ type: 'warm-up' })).toBe('Open');
    expect(words.labButtonWord({ type: 'warm-up', done: true })).toBe('Open again');
    expect(words.labButtonWord({ type: 'warm-up', running: true })).toBe('Resume');
    expect(words.labButtonWord({ type: 'build', locked: true, running: true, done: true })).toBe('Locked');
    expect(words.labButtonWord({ type: 'build', running: true, done: true })).toBe('Resume');
    expect(words.labButtonWord({ type: 'build', done: true })).toBe('Open again');
  });
});

describe('the quiz and the levels', () => {
  it('says the three answers one way: New to you, Some experience, Know it well', () => {
    expect(words.QUIZ_LEVELS).toEqual({ new: 'New to you', ok: 'Some experience', strong: 'Know it well' });
    expect(['new', 'ok', 'strong'].map(words.quizLevelWord)).toEqual(['New to you', 'Some experience', 'Know it well']);
    expect(words.quizLevelWord('familiar')).toBe('');
    expect(words.quizLevelWord('toString')).toBe('');
  });
  it('keeps a skill\'s level apart from the XP rank', () => {
    expect(words.skillLevelLabel('Practitioner')).toBe('Skill: Practitioner');
    expect(words.skillLevelLabel('Not started')).toBe('Not started');
    expect(words.rankLabel('Newcomer')).toBe('Rank: Newcomer');
  });
});

describe('what a finished lab earned', () => {
  it('writes the XP, the skill change and the next lab', () => {
    expect(words.xpGainText(120)).toBe('+120 XP');
    expect(words.skillChangeText('Retrieval', 12, 31)).toBe('Skill: Retrieval 12 → 31');
    expect(words.nextLabText('Trace one request')).toBe('Next lab: Trace one request');
  });
});

describe('plan locks', () => {
  it('has a short form and a sentence', () => {
    expect(words.PLAN_LOCK_SHORT).toBe('Pro plan');
    expect(words.PLAN_LOCK_LONG).toBe('This lab is included with the Pro plan.');
  });
  it('still recognises the wordings the service and the console used before', () => {
    for (const why of ['This lab is included with the Pro plan.', 'Included with the Pro plan.', 'Part of the paid plan', 'This lab is part of the Pro plan.']) {
      expect(words.isPlanLockWhy(why), why).toBe(true);
    }
    expect(words.isPlanLockWhy('Unlocks after Add a model.')).toBe(false);
    expect(words.isPlanLockWhy(undefined)).toBe(false);
  });
  it('is what a refused start says: plan_required reads as the same sentence', async () => {
    const { plainError } = (await import('../../dashboard/src/api.js' as string)) as { plainError: (err: unknown) => string };
    expect(plainError({ status: 403, code: 'plan_required' })).toBe(words.PLAN_LOCK_LONG);
    expect(plainError({ status: 403 })).toBe("That isn't available to you right now.");
  });
  it('is the sentence the service says: the plan_required message and a locked step\'s why', () => {
    const service = readFileSync(join(__dirname, '..', '..', 'src', 'path', 'service.ts'), 'utf8');
    const router = readFileSync(join(__dirname, '..', '..', 'src', 'router.ts'), 'utf8');
    expect(service).toContain(`export const PLAN_LOCK_WHY = '${words.PLAN_LOCK_LONG}';`);
    expect(router).toContain("'plan_required', PLAN_LOCK_WHY");
  });
});
