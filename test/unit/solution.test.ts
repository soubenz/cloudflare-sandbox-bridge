import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRuntime } from '../../src/session/state';
import type { SessionMeta } from '../../src/session/state';
import type { Env } from '../../src/env';
import { createFakeStorage } from '../fakes/fake-storage';
import { parseManifest } from '../../src/labs/manifest';
import { scheduleTimer } from '../../src/session/timers';
import { FakeBackend, FakeProcess } from '../fakes/fake-backend';
import {
  isSolutionUnlocked,
  buildSolutionStatus,
  maybeEmitSolutionUnlocked,
  SOLUTION_RULE,
  type SolutionProgress,
} from '../../src/session/solution';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../../src/do/pool', () => ({ poolStub: () => ({ claim: async () => ({ sandbox_id: 'c-1' }), release: async () => {} }) }));
vi.mock('../../src/session/hydrate', () => ({
  hydrateWorkspaceFiles: async () => {},
  hydratePressureScripts: async () => {},
  applySessionEnv: async () => {},
  ensureStageDir: async () => {},
  stagePath: (n: string) => `/x/${n}`,
  archiveGuard: () => 'true',
  removeStaged: async () => {},
}));
vi.mock('../../src/session/services', () => ({
  startAllServices: async () => {},
  relaunchAllServices: async () => {},
  healthCheckAll: async () => {},
  allServicesGone: async () => false,
}));
vi.mock('../../src/session/d1', () => ({
  updateSession: async () => {},
  insertSnapshot: async () => {},
  insertCheckRun: async () => {},
  bestEffort: (p: Promise<unknown>) => void p.catch(() => {}),
}));

const progress = (p: Partial<SolutionProgress> = {}): SolutionProgress => ({
  check_runs: 0,
  hints_delivered: 0,
  hints_total: 0,
  completed: false,
  ...p,
});

describe('isSolutionUnlocked: the truth table', () => {
  it.each<[string, Partial<SolutionProgress>, boolean]>([
    // completed wins over everything
    ['completed, nothing else', { completed: true }, true],
    ['completed with no runs recorded and hints outstanding', { completed: true, hints_total: 3, hints_delivered: 0, check_runs: 0 }, true],
    ['completed after one run', { completed: true, check_runs: 1 }, true],
    // hints + two runs
    ['all hints and two runs', { hints_total: 3, hints_delivered: 3, check_runs: 2 }, true],
    ['all hints and many runs', { hints_total: 3, hints_delivered: 3, check_runs: 40 }, true],
    ['all hints but one run', { hints_total: 3, hints_delivered: 3, check_runs: 1 }, false],
    ['all hints but no runs', { hints_total: 3, hints_delivered: 3, check_runs: 0 }, false],
    ['two runs but one hint short', { hints_total: 3, hints_delivered: 2, check_runs: 2 }, false],
    ['many runs but no hint delivered', { hints_total: 3, hints_delivered: 0, check_runs: 10 }, false],
    // a lab with zero hints needs only the two runs
    ['zero hints, two runs', { hints_total: 0, hints_delivered: 0, check_runs: 2 }, true],
    ['zero hints, one run', { hints_total: 0, hints_delivered: 0, check_runs: 1 }, false],
    ['zero hints, no runs', { hints_total: 0, hints_delivered: 0, check_runs: 0 }, false],
    ['a fresh session', {}, false],
  ])('%s -> %s', (_label, p, expected) => {
    expect(isSolutionUnlocked(progress(p))).toBe(expected);
  });

  it('is monotonic: growing any input never locks it again', () => {
    const base = progress({ hints_total: 2, hints_delivered: 2, check_runs: 2 });
    expect(isSolutionUnlocked(base)).toBe(true);
    expect(isSolutionUnlocked({ ...base, check_runs: 3 })).toBe(true);
    expect(isSolutionUnlocked({ ...base, completed: true })).toBe(true);
  });
});

describe('buildSolutionStatus', () => {
  it('carries the fixed rule text and the progress it was given', () => {
    const p = progress({ check_runs: 2, hints_total: 1, hints_delivered: 1 });
    expect(buildSolutionStatus(p, true)).toEqual({ available: true, unlocked: true, rule: SOLUTION_RULE, progress: p });
    expect(SOLUTION_RULE).toBe('Pass every check, or use every hint and run the checks twice.');
  });

  it('unlocked and available are independent', () => {
    expect(buildSolutionStatus(progress(), true)).toMatchObject({ available: true, unlocked: false });
    expect(buildSolutionStatus(progress({ completed: true }), false)).toMatchObject({ available: false, unlocked: true });
  });
});

// --- Against a real SessionRuntime over fake storage ---

const meta = (): SessionMeta => ({
  id: 'sess-1', user_id: 'u1', lab_slug: 'lab-a', lab_version: '1.0.0', family: 'agent', state: 'running',
  created_at: Date.now() - 60_000, started_at: Date.now() - 60_000, resumed_count: 0,
});

const manifestWith = (hints: Array<{ after_minutes: number; text: string }>) =>
  parseManifest({
    slug: 'lab-a', version: '1.0.0', title: 'Lab A', type: 'build', family: 'agent', timeout_minutes: 90, idle_minutes: 15,
    objectives: ['do the thing'],
    services: [{ name: 'api', argv: ['python3', 'app.py'], port: 8000 }],
    checks: [{ name: 'c1', script: 'c1.sh' }, { name: 'c2', script: 'c2.sh' }],
    hints,
  });

interface World {
  storage: ReturnType<typeof createFakeStorage>;
  events: string[];
  /** Flip to false to model a lab version with no solution.tgz. */
  solutionExists: { value: boolean };
  headCalls: string[];
  /** A fresh runtime over the same storage: what a container recovery or a DO restart looks like. */
  runtime(): SessionRuntime;
}

function world(): World {
  const storage = createFakeStorage();
  const events: string[] = [];
  const headCalls: string[] = [];
  const solutionExists = { value: true };
  const sql = {
    exec: (query: string, ...params: unknown[]) => {
      if (/^INSERT INTO events/.test(query)) events.push(String(params[1]));
      return [];
    },
  };
  const env = {
    SESSION_TOKEN_SECRET: 's',
    LABS_BUCKET: {
      head: async (key: string) => {
        headCalls.push(key);
        return solutionExists.value ? { key } : null;
      },
      get: async () => ({ body: new Uint8Array() }),
    },
  } as unknown as Env;
  const ctx = { id: { name: 'sess-1' }, storage: { ...storage, sql }, getWebSockets: () => [] };
  const runtime = () => new SessionRuntime(ctx as unknown as DurableObjectState, env, 'sess-1');
  return { storage, events, solutionExists, headCalls, runtime };
}

const unlockedEvents = (w: World) => w.events.filter((e) => e === 'solution.unlocked');

/** Runs the checks once with `passes` as the per-check verdicts. */
async function runOnce(rt: SessionRuntime, manifest: ReturnType<typeof manifestWith>, passes: boolean[]) {
  const { runChecks } = await import('../../src/session/checks');
  const fake = new FakeBackend();
  const proc = (out: object) => new FakeProcess().resolveNext('output', out);
  fake.resolveNext('exec', proc({ exitCode: 0, stdout: '', stderr: '', timedOut: false })); // staging
  for (const pass of passes) {
    fake.resolveNext('exec', proc({ exitCode: pass ? 0 : 1, stdout: JSON.stringify({ pass, message: pass ? 'ok' : 'no' }), stderr: '', timedOut: false }));
  }
  (rt as unknown as { _backend: unknown })._backend = fake.asBackend();
  return runChecks(rt, manifest);
}

describe('the check-run counter', () => {
  it('counts every run, past the ten the history keeps', async () => {
    const w = world();
    const rt = w.runtime();
    await rt.putMeta(meta());
    const m = manifestWith([]);
    for (let i = 0; i < 12; i++) await runOnce(rt, m, [false, false]);
    expect(await rt.checkRunCount()).toBe(12);
    expect(await rt.checksHistory()).toHaveLength(10);
  });

  it('completed is set by a run that passes every check, and stays set after a failing one', async () => {
    const w = world();
    const rt = w.runtime();
    await rt.putMeta(meta());
    const m = manifestWith([]);
    await runOnce(rt, m, [true, false]);
    expect(await rt.checksCompleted()).toBe(false);
    await runOnce(rt, m, [true, true]);
    expect(await rt.checksCompleted()).toBe(true);
    await runOnce(rt, m, [false, false]);
    expect(await rt.checksCompleted()).toBe(true);
    expect(await rt.checkRunCount()).toBe(3);
  });

  it('a run of a subset of the checks (`only`) is a run but never completes the lab', async () => {
    const { runChecks } = await import('../../src/session/checks');
    const w = world();
    const rt = w.runtime();
    await rt.putMeta(meta());
    const fake = new FakeBackend();
    const proc = (out: object) => new FakeProcess().resolveNext('output', out);
    fake.resolveNext('exec', proc({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    fake.resolveNext('exec', proc({ exitCode: 0, stdout: '{"pass":true,"message":"ok"}', stderr: '', timedOut: false }));
    (rt as unknown as { _backend: unknown })._backend = fake.asBackend();
    await runChecks(rt, manifestWith([]), ['c1']);
    expect(await rt.checkRunCount()).toBe(1);
    expect(await rt.checksCompleted()).toBe(false);
  });
});

describe('the solution.unlocked event', () => {
  beforeEach(() => vi.useRealTimers());

  it('a lab with no hints: not after one failing run, once at the second', async () => {
    const w = world();
    const rt = w.runtime();
    await rt.putMeta(meta());
    const m = manifestWith([]);

    await runOnce(rt, m, [false, false]);
    expect(unlockedEvents(w)).toHaveLength(0);
    expect(w.headCalls).toEqual([]); // the rule is checked before R2 is touched

    await runOnce(rt, m, [false, false]);
    expect(unlockedEvents(w)).toHaveLength(1);

    await runOnce(rt, m, [false, false]);
    await runOnce(rt, m, [true, true]);
    expect(unlockedEvents(w)).toHaveLength(1);
  });

  it('passing every check on the first run unlocks it at once', async () => {
    const w = world();
    const rt = w.runtime();
    await rt.putMeta(meta());
    await runOnce(rt, manifestWith([{ after_minutes: 5, text: 'h' }]), [true, true]);
    expect(unlockedEvents(w)).toHaveLength(1);
  });

  it('with hints: two runs are not enough until the last hint is delivered, and that delivery emits it', async () => {
    const { handleAlarm } = await import('../../src/session/lifecycle');
    const w = world();
    const rt = w.runtime();
    await rt.putMeta(meta());
    const m = manifestWith([{ after_minutes: 5, text: 'first' }, { after_minutes: 15, text: 'second' }]);
    await rt.putManifest(m);

    await runOnce(rt, m, [false, false]);
    await runOnce(rt, m, [false, false]);
    expect(unlockedEvents(w)).toHaveLength(0);

    await scheduleTimer(rt, 'hint', Date.now() - 1, '0');
    await handleAlarm(rt);
    expect(unlockedEvents(w)).toHaveLength(0); // one hint of two

    await scheduleTimer(rt, 'hint', Date.now() - 1, '1');
    await handleAlarm(rt);
    expect(unlockedEvents(w)).toHaveLength(1);
    expect(w.events.filter((e) => e === 'hint')).toHaveLength(2);
    // The hint event is emitted before the unlock event.
    expect(w.events.indexOf('hint', w.events.indexOf('hint') + 1)).toBeLessThan(w.events.indexOf('solution.unlocked'));

    // A repeated delivery of the same hint (a resume re-arms the timers) does not repeat the event.
    await scheduleTimer(rt, 'hint', Date.now() - 1, '1');
    await handleAlarm(rt);
    expect(unlockedEvents(w)).toHaveLength(1);
  });

  it('hints first, then the second run, emits at the run', async () => {
    const { handleAlarm } = await import('../../src/session/lifecycle');
    const w = world();
    const rt = w.runtime();
    await rt.putMeta(meta());
    const m = manifestWith([{ after_minutes: 5, text: 'only' }]);
    await rt.putManifest(m);
    await scheduleTimer(rt, 'hint', Date.now() - 1, '0');
    await handleAlarm(rt);
    await runOnce(rt, m, [false, false]);
    expect(unlockedEvents(w)).toHaveLength(0);
    await runOnce(rt, m, [false, false]);
    expect(unlockedEvents(w)).toHaveLength(1);
  });

  it('never emits twice across a container recovery or a resume (a new runtime over the same storage)', async () => {
    const w = world();
    let rt = w.runtime();
    await rt.putMeta(meta());
    const m = manifestWith([]);
    await runOnce(rt, m, [true, true]);
    expect(unlockedEvents(w)).toHaveLength(1);

    rt = w.runtime(); // the DO restarted; in-memory state is gone
    expect(await rt.solutionUnlockedEmitted()).toBe(true);
    expect(await maybeEmitSolutionUnlocked(rt, m)).toBe(false);
    await runOnce(rt, m, [true, true]);
    expect(unlockedEvents(w)).toHaveLength(1);
  });

  it('two racing callers emit once', async () => {
    const w = world();
    const rt = w.runtime();
    await rt.putMeta(meta());
    await rt.recordCheckRun(true);
    const results = await Promise.all([maybeEmitSolutionUnlocked(rt), maybeEmitSolutionUnlocked(rt), maybeEmitSolutionUnlocked(rt)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(unlockedEvents(w)).toHaveLength(1);
  });

  it('emits nothing for a lab version with no solution, and does emit if one turns up later', async () => {
    const w = world();
    w.solutionExists.value = false;
    const rt = w.runtime();
    await rt.putMeta(meta());
    const m = manifestWith([]);
    await runOnce(rt, m, [true, true]);
    expect(unlockedEvents(w)).toHaveLength(0);
    expect(await rt.solutionUnlockedEmitted()).toBe(false);
    expect(w.headCalls).toEqual(['labs/lab-a/1.0.0/solution.tgz']);

    w.solutionExists.value = true; // a forced re-publish of the same version added one
    await runOnce(rt, m, [false, false]);
    expect(unlockedEvents(w)).toHaveLength(1);
  });

  it('a failing R2 read never fails the check run', async () => {
    const w = world();
    const rt = w.runtime();
    await rt.putMeta(meta());
    (rt.env.LABS_BUCKET as unknown as { head: unknown }).head = async () => {
      throw new Error('r2 down');
    };
    const run = await runOnce(rt, manifestWith([]), [true, true]);
    expect(run.results).toHaveLength(2);
    expect(unlockedEvents(w)).toHaveLength(0);
  });
});
