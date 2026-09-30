import { describe, it, expect } from 'vitest';
import {
  scoreRun,
  clampLimit,
  userProgressQuery,
  progressSummaryQuery,
  sessionChecksQuery,
  userChecksQuery,
  parseProgressRow,
  parseCheckRunRow,
  parseFeedback,
  userProgress,
  sessionProgressSummary,
  sessionChecks,
  userChecks,
} from '../../src/session/progress';
import { checkRunParams, insertCheckRun } from '../../src/session/d1';
import type { ChecksRun, CheckResultEntry } from '../../src/session/state';
import type { Env } from '../../src/env';
import { createFakeD1 } from '../fakes/fake-d1';

const entry = (name: string, pass: boolean, weight = 1): CheckResultEntry => ({ name, pass, message: '', duration_ms: 1, exit_code: pass ? 0 : 1, timed_out: false, weight });
const run = (results: CheckResultEntry[], extra: Partial<ChecksRun> = {}): ChecksRun => ({ run_id: 'r1', started_at: 1000, finished_at: 2000, results, ...extra });
const owner = { user_id: 'u1', lab_slug: 'lab-a', lab_version: '1.2.0' };

describe('scoreRun', () => {
  it('is the weighted share of checks passed', () => {
    const s = scoreRun([entry('a', true, 3), entry('b', false, 1)]);
    expect(s).toEqual({ passed: 1, total: 2, score: 0.75, passed_all: false });
  });
  it('passed_all only when every check passed', () => {
    expect(scoreRun([entry('a', true), entry('b', true)]).passed_all).toBe(true);
    expect(scoreRun([]).passed_all).toBe(false);
    expect(scoreRun([]).score).toBe(0);
  });
  it('a subset run does not complete the lab', () => {
    expect(scoreRun([entry('a', true)], 3).passed_all).toBe(false);
    expect(scoreRun([entry('a', true), entry('b', true), entry('c', true)], 3).passed_all).toBe(true);
  });
});

describe('insertCheckRun (B-12)', () => {
  it('binds user, lab, version, score and passed_all after the original columns', () => {
    const params = checkRunParams('sess-1', run([entry('a', true, 2), entry('b', false, 2)]), owner);
    expect(params).toEqual(['r1', 'sess-1', 1000, 2000, 1, 2, expect.any(String), 'u1', 'lab-a', '1.2.0', 0.5, 0]);
    expect(JSON.parse(params[6] as string)).toHaveLength(2);
  });

  it('writes the new columns in the INSERT and does not mark the session complete on a failed run', async () => {
    const { db, calls } = createFakeD1();
    await insertCheckRun({ DB: db } as Env, 'sess-1', run([entry('a', true), entry('b', false)]), owner);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('INSERT INTO check_runs');
    expect(calls[0]!.sql).toContain('user_id, lab_slug, lab_version, score, passed_all');
    expect(calls[0]!.params.slice(-2)).toEqual([0.5, 0]);
  });

  it('a run that passes every check records passed_all=1 and completes the session once', async () => {
    const { db, calls } = createFakeD1();
    await insertCheckRun({ DB: db } as Env, 'sess-1', run([entry('a', true), entry('b', true)]), { ...owner, total_checks: 2 });
    expect(calls[0]!.params.slice(-2)).toEqual([1, 1]);
    expect(calls[1]!.sql).toContain('UPDATE sessions SET completed_at = COALESCE(completed_at, ?)');
    expect(calls[1]!.params).toEqual([2000, 'sess-1']);
  });
});

describe('limits', () => {
  it.each([
    [undefined, 20],
    ['', 20],
    ['abc', 20],
    ['0', 20],
    ['-3', 20],
    ['5', 5],
    ['5.9', 5],
    ['1000', 100],
  ] as const)('clampLimit(%s) = %s', (raw, expected) => {
    expect(clampLimit(raw)).toBe(expected);
  });
});

describe('progress SQL (B-14)', () => {
  it('groups a user\'s runs by lab', () => {
    const q = userProgressQuery('u1');
    expect(q.params).toEqual(['u1']);
    expect(q.sql).toContain('FROM check_runs');
    expect(q.sql).toContain('GROUP BY lab_slug');
    expect(q.sql).toContain('COUNT(DISTINCT session_id) AS sessions');
    expect(q.sql).toContain('MAX(score) AS best_score');
  });

  it('the summary counts this session\'s attempts in the same statement', () => {
    const q = progressSummaryQuery('s1', 'u1', 'lab-a');
    expect(q.params).toEqual(['s1', 'u1', 'lab-a']);
    expect(q.sql).toContain('attempts_this_session');
    expect(q.sql).not.toContain('GROUP BY');
  });

  it('session history is newest first and clamped', () => {
    expect(sessionChecksQuery('s1', 500)).toEqual({
      sql: expect.stringContaining('WHERE session_id = ? ORDER BY started_at DESC LIMIT ?'),
      params: ['s1', 100],
    });
  });

  it('user history adds the lab and cursor filters only when given', () => {
    expect(userChecksQuery('u1').params).toEqual(['u1', 20]);
    const q = userChecksQuery('u1', { lab: 'lab-a', before: 5000, limit: 7 });
    expect(q.sql).toContain('user_id = ? AND lab_slug = ? AND started_at < ?');
    expect(q.params).toEqual(['u1', 'lab-a', 5000, 7]);
  });
});

describe('progress parsing', () => {
  it('turns aggregate rows into the API shape', () => {
    expect(parseProgressRow({ slug: 'lab-a', attempts: 3, best_score: 0.75, passed_all: 1, last_run_at: 99, sessions: 2 })).toEqual({
      slug: 'lab-a',
      attempts: 3,
      best_score: 0.75,
      passed_all: true,
      last_run_at: 99,
      sessions: 2,
    });
  });
  it('an empty aggregate is zeros, not nulls', () => {
    expect(parseProgressRow({ attempts: 0, best_score: null, passed_all: null, last_run_at: null, sessions: 0 }, 'lab-a')).toEqual({
      slug: 'lab-a',
      attempts: 0,
      best_score: 0,
      passed_all: false,
      last_run_at: null,
      sessions: 0,
    });
  });
  it('parses results_json and survives a corrupt one', () => {
    const base = { id: 'r1', started_at: 1, finished_at: 2, passed: 1, total: 2, score: 0.5 };
    expect(parseCheckRunRow({ ...base, results_json: '[{"name":"a","pass":true}]' })).toEqual({
      run_id: 'r1',
      started_at: 1,
      finished_at: 2,
      passed: 1,
      total: 2,
      score: 0.5,
      results: [{ name: 'a', pass: true }],
    });
    expect(parseCheckRunRow({ ...base, results_json: '{oops' }).results).toEqual([]);
    expect(parseCheckRunRow({ ...base, session_id: 's', lab_slug: 'l', results_json: '[]' }, true)).toMatchObject({ session_id: 's', lab_slug: 'l' });
  });
});

describe('progress readers run the built statements', () => {
  it('userProgress aggregates rows', async () => {
    const { db, calls } = createFakeD1(() => [{ slug: 'lab-a', attempts: 2, best_score: 1, passed_all: 1, last_run_at: 10, sessions: 1 }]);
    expect(await userProgress({ DB: db } as Env, 'u1')).toEqual({
      labs: [{ slug: 'lab-a', attempts: 2, best_score: 1, passed_all: true, last_run_at: 10, sessions: 1 }],
    });
    expect(calls[0]!.params).toEqual(['u1']);
  });
  it('sessionProgressSummary with no runs is zeros for this lab', async () => {
    const { db } = createFakeD1(() => ({ attempts: 0, sessions: 0, attempts_this_session: null }));
    expect(await sessionProgressSummary({ DB: db } as Env, 's1', 'u1', 'lab-a')).toEqual({
      slug: 'lab-a', attempts: 0, best_score: 0, passed_all: false, last_run_at: null, sessions: 0, attempts_this_session: 0,
    });
  });
  it('session and user history parse results', async () => {
    const row = { id: 'r1', session_id: 's1', lab_slug: 'lab-a', started_at: 1, finished_at: 2, passed: 1, total: 1, score: 1, results_json: '[]' };
    const { db } = createFakeD1(() => [row]);
    expect((await sessionChecks({ DB: db } as Env, 's1', 3)).runs[0]).toMatchObject({ run_id: 'r1', results: [] });
    expect((await userChecks({ DB: db } as Env, 'u1', { lab: 'lab-a' })).runs[0]).toMatchObject({ run_id: 'r1', session_id: 's1', lab_slug: 'lab-a' });
  });
});

describe('feedback validation (B-16)', () => {
  const bad = (body: unknown) => expect(() => parseFeedback(body)).toThrowError(expect.objectContaining({ status: 400, code: 'bad_feedback' }));

  it.each([0, 6, 3.5, '4', null, undefined])('rejects rating %s', (rating) => bad({ rating }));
  it('rejects a text over 2000 characters, accepts exactly 2000', () => {
    bad({ rating: 5, text: 'x'.repeat(2001) });
    expect(parseFeedback({ rating: 5, text: 'x'.repeat(2000) }).text).toHaveLength(2000);
  });
  it('rejects a non-string text and a non-object body', () => {
    bad({ rating: 5, text: 42 });
    bad(undefined);
    bad([]);
  });
  it('accepts a bare rating; empty text is stored as null', () => {
    expect(parseFeedback({ rating: 1 })).toEqual({ rating: 1, text: null });
    expect(parseFeedback({ rating: 4, text: '' })).toEqual({ rating: 4, text: null });
  });
});
