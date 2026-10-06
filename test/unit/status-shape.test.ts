import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRuntime, CHECKS_HISTORY_CAP } from '../../src/session/state';
import type { SessionMeta } from '../../src/session/state';
import type { Env } from '../../src/env';
import { createFakeStorage } from '../fakes/fake-storage';
import { parseManifest, requireRunnable } from '../../src/labs/manifest';
import { scheduleTimer } from '../../src/session/timers';
import { FakeBackend, FakeProcess } from '../fakes/fake-backend';

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
const d1 = vi.hoisted(() => ({
  updateSession: vi.fn(async (..._args: unknown[]) => {}),
  insertSnapshot: async () => {},
  insertCheckRun: vi.fn(async (..._args: unknown[]) => {}),
  bestEffort: (p: Promise<unknown>) => void p.catch(() => {}),
}));
vi.mock('../../src/session/d1', () => d1);

function makeRuntime() {
  const storage = createFakeStorage();
  const ctx = { id: { name: 'sess-1' }, storage: { ...storage, sql: { exec: () => [] } }, getWebSockets: () => [] };
  const rt = new SessionRuntime(ctx as unknown as DurableObjectState, { SESSION_TOKEN_SECRET: 's' } as Env, 'sess-1');
  return { rt };
}

const meta = (extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 'sess-1', user_id: 'u1', lab_slug: 'lab-a', lab_version: '1.0.0', family: 'agent', state: 'running',
  created_at: Date.now() - 60_000, started_at: Date.now() - 60_000, resumed_count: 0, ...extra,
});

const manifest = () =>
  requireRunnable(parseManifest({
    slug: 'lab-a', version: '1.0.0', title: 'Lab A', type: 'build', family: 'agent', timeout_minutes: 90, idle_minutes: 15,
    objectives: ['do the thing'],
    services: [
      { name: 'api', argv: ['python3', 'app.py'], port: 8000, ui: true },
      { name: 'worker', argv: ['python3', 'w.py'] },
    ],
    checks: [{ name: 'c1', script: 'c1.sh', weight: 3 }, { name: 'c2', script: 'c2.sh' }],
    pressure: [{ id: 'p1', at_minutes: 10, argv: ['true'], title: 'T', message: 'M' }, { id: 'p2', at_minutes: 20, argv: ['true'], title: 'T', message: 'M' }],
    hints: [{ after_minutes: 5, text: 'first' }, { after_minutes: 15, text: 'second' }],
  }));

async function statusOf(rt: SessionRuntime) {
  const { Session } = await import('../../src/do/session');
  const instance = Object.create(Session.prototype) as { rt: SessionRuntime; status(): Promise<Record<string, any>> };
  instance.rt = rt;
  return instance.status();
}

beforeEach(() => {
  d1.updateSession.mockReset();
  d1.updateSession.mockResolvedValue(undefined);
  d1.insertCheckRun.mockReset();
  d1.insertCheckRun.mockResolvedValue(undefined);
});

describe('status() completeness (B-15)', () => {
  it('returns hints, pressure, manifest_summary, checks_history and server_time beside the old fields', async () => {
    const { rt } = makeRuntime();
    await rt.putMeta(meta());
    await rt.putManifest(manifest());
    await rt.recordHintDelivered({ index: 0, after_minutes: 5, text: 'first' });
    await rt.putPressureStatus({ p1: { status: 'fired', fired_at: 123 } });
    await rt.appendChecksHistory({ run_id: 'r1', started_at: 1, finished_at: 2, passed: 1, total: 2, score: 0.75, results: [{ name: 'c1', pass: true, weight: 3 }] });

    const before = Date.now();
    const status = await statusOf(rt);

    expect(Object.keys(status)).toEqual(
      expect.arrayContaining(['meta', 'services', 'snapshots', 'checks', 'cost', 'hints', 'pressure', 'manifest_summary', 'checks_history', 'solution', 'server_time'])
    );
    expect(status.hints).toEqual({ delivered: [{ index: 0, after_minutes: 5, text: 'first' }], total: 2, schedule: [5, 15] });
    expect(status.pressure).toEqual({ p1: { status: 'fired', fired_at: 123 }, p2: { status: 'pending' } });
    expect(status.manifest_summary).toEqual({
      title: 'Lab A',
      objectives: ['do the thing'],
      timeout_minutes: 90,
      idle_minutes: 15,
      checks: [{ name: 'c1', weight: 3 }, { name: 'c2', weight: 1 }],
      services: [{ name: 'api', ui: true, port: 8000 }, { name: 'worker', ui: false }],
      hints_schedule: [5, 15],
      learner_restart: false,
    });
    expect(status.checks_history).toHaveLength(1);
    expect(status.server_time).toBeGreaterThanOrEqual(before);
  });

  it('degrades without a manifest: empty hints, no summary, and no pending pressure once ended', async () => {
    const { rt } = makeRuntime();
    await rt.putMeta(meta({ state: 'ended', ended_at: Date.now() }));
    const status = await statusOf(rt);
    expect(status.hints).toEqual({ delivered: [], total: 0, schedule: [] });
    expect(status.manifest_summary).toBeUndefined();
    expect(status.pressure).toEqual({});
    expect(status.checks_history).toEqual([]);

    await rt.putManifest(manifest());
    expect((await statusOf(rt)).pressure).toEqual({});
  });

  it('the hint timer records the delivery, once per index', async () => {
    const { handleAlarm } = await import('../../src/session/lifecycle');
    const { rt } = makeRuntime();
    await rt.putMeta(meta());
    await rt.putManifest(manifest());
    await scheduleTimer(rt, 'hint', Date.now() - 1, '1');
    await handleAlarm(rt);
    await scheduleTimer(rt, 'hint', Date.now() - 1, '1');
    await handleAlarm(rt);
    expect(await rt.hintsDelivered()).toEqual([{ index: 1, after_minutes: 15, text: 'second' }]);
  });

  it('hints_delivered goes to D1 with the final cost', async () => {
    const { endSession } = await import('../../src/session/lifecycle');
    const { rt } = makeRuntime();
    await rt.putMeta(meta());
    await rt.putManifest(manifest());
    await rt.recordHintDelivered({ index: 0, after_minutes: 5, text: 'first' });
    await rt.recordHintDelivered({ index: 1, after_minutes: 15, text: 'second' });
    await endSession(rt, 'user', false);
    const [, , cost] = d1.updateSession.mock.calls.at(-1) as unknown as [unknown, unknown, { hints_delivered: number }];
    expect(cost.hints_delivered).toBe(2);
  });
});

describe('status().solution', () => {
  const RULE = 'Pass every check, or use every hint and run the checks twice.';
  const bucket = (rt: SessionRuntime, exists: boolean) => {
    const heads: string[] = [];
    (rt.env as unknown as { LABS_BUCKET: unknown }).LABS_BUCKET = {
      head: async (key: string) => {
        heads.push(key);
        return exists ? { key } : null;
      },
    };
    return heads;
  };

  it('is { available, unlocked, rule, progress } and reflects the counters, the hints and the R2 head', async () => {
    const { rt } = makeRuntime();
    const heads = bucket(rt, true);
    await rt.putMeta(meta());
    await rt.putManifest(manifest()); // two hints

    expect((await statusOf(rt)).solution).toEqual({
      available: true,
      unlocked: false,
      rule: RULE,
      progress: { check_runs: 0, hints_delivered: 0, hints_total: 2, completed: false },
    });
    expect(heads).toEqual(['labs/lab-a/1.0.0/solution.tgz']);

    await rt.recordCheckRun(false);
    await rt.recordCheckRun(false);
    await rt.recordHintDelivered({ index: 0, after_minutes: 5, text: 'first' });
    expect((await statusOf(rt)).solution).toMatchObject({ unlocked: false, progress: { check_runs: 2, hints_delivered: 1, hints_total: 2 } });

    await rt.recordHintDelivered({ index: 1, after_minutes: 15, text: 'second' });
    expect((await statusOf(rt)).solution).toMatchObject({ unlocked: true, progress: { check_runs: 2, hints_delivered: 2, completed: false } });
  });

  it('completing the lab unlocks it', async () => {
    const { rt } = makeRuntime();
    bucket(rt, true);
    await rt.putMeta(meta());
    await rt.putManifest(manifest());
    await rt.recordCheckRun(true);
    expect((await statusOf(rt)).solution).toMatchObject({ unlocked: true, progress: { check_runs: 1, completed: true } });
  });

  it('available is false when the lab version has no solution.tgz, or R2 cannot be read', async () => {
    const { rt } = makeRuntime();
    bucket(rt, false);
    await rt.putMeta(meta());
    await rt.putManifest(manifest());
    expect((await statusOf(rt)).solution.available).toBe(false);

    (rt.env as unknown as { LABS_BUCKET: unknown }).LABS_BUCKET = { head: async () => { throw new Error('r2 down'); } };
    expect((await statusOf(rt)).solution.available).toBe(false);
  });

  it('without a manifest there are no hints to wait for', async () => {
    const { rt } = makeRuntime();
    bucket(rt, true);
    await rt.putMeta(meta({ state: 'ended', ended_at: Date.now() }));
    expect((await statusOf(rt)).solution.progress).toEqual({ check_runs: 0, hints_delivered: 0, hints_total: 0, completed: false });
  });
});

describe('checks history', () => {
  it('keeps the newest ten runs', async () => {
    const { rt } = makeRuntime();
    for (let i = 0; i < CHECKS_HISTORY_CAP + 3; i++) {
      await rt.appendChecksHistory({ run_id: `r${i}`, started_at: i, passed: 0, total: 0, score: 0, results: [] });
    }
    const history = await rt.checksHistory();
    expect(history).toHaveLength(10);
    expect(history[0]!.run_id).toBe('r3');
    expect(history.at(-1)!.run_id).toBe('r12');
  });

  it('runChecks appends a compact entry and hands the owner and total to D1', async () => {
    const { runChecks } = await import('../../src/session/checks');
    const { rt } = makeRuntime();
    const fake = new FakeBackend();
    const proc = (out: object) => new FakeProcess().resolveNext('output', out);
    fake.resolveNext('exec', proc({ exitCode: 0, stdout: '', stderr: '', timedOut: false })); // staging the scripts
    fake.resolveNext('exec', proc({ exitCode: 0, stdout: '{"pass":true,"message":"ok"}', stderr: '', timedOut: false }));
    fake.resolveNext('exec', proc({ exitCode: 1, stdout: '{"pass":false,"message":"nope"}', stderr: '', timedOut: false }));
    (rt as unknown as { _backend: unknown })._backend = fake.asBackend();
    (rt.env as unknown as { LABS_BUCKET: unknown }).LABS_BUCKET = { get: async () => ({ body: new Uint8Array() }) };
    await rt.putMeta(meta());

    const run = await runChecks(rt, manifest());

    expect(run.results.map((r) => r.pass)).toEqual([true, false]);
    expect(d1.insertCheckRun).toHaveBeenCalledTimes(1);
    const [, sessionId, , ownerArg] = d1.insertCheckRun.mock.calls[0] as unknown as [unknown, string, unknown, Record<string, unknown>];
    expect(sessionId).toBe('sess-1');
    expect(ownerArg).toEqual({ user_id: 'u1', lab_slug: 'lab-a', lab_version: '1.0.0', total_checks: 2 });
    const [entry] = await rt.checksHistory();
    expect(entry).toMatchObject({ run_id: run.run_id, passed: 1, total: 2, score: 0.75 });
    expect(entry!.results).toEqual([{ name: 'c1', pass: true, weight: 3 }, { name: 'c2', pass: false, weight: 1 }]);
  });
});

describe('endSession awaits its D1 write with retries (B-18)', () => {
  it('retries a failing write and stops once it succeeds', async () => {
    const { persistEnded } = await import('../../src/session/lifecycle');
    d1.updateSession.mockRejectedValueOnce(new Error('d1 down')).mockRejectedValueOnce(new Error('d1 down')).mockResolvedValue(undefined);
    await persistEnded({} as Env, meta({ state: 'ended' }), undefined, [0, 0, 0]);
    expect(d1.updateSession).toHaveBeenCalledTimes(3);
  });

  it('after 3 retries falls back to one best-effort attempt and never throws', async () => {
    const { persistEnded } = await import('../../src/session/lifecycle');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    d1.updateSession.mockRejectedValue(new Error('d1 down'));
    await expect(persistEnded({} as Env, meta({ state: 'ended' }), undefined, [0, 0, 0])).resolves.toBeUndefined();
    expect(d1.updateSession).toHaveBeenCalledTimes(5); // 1 + 3 retries + the best-effort attempt
  });
});
