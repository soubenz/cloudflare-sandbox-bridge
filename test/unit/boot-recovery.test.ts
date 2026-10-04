import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/env';
import { SessionRuntime, summarizeManifest } from '../../src/session/state';
import * as state from '../../src/session/state';
import type { SessionStatus } from '../../src/session/state';
import { createFakeStorage } from '../fakes/fake-storage';
import { FakeBackend } from '../fakes/fake-backend';
import { sqliteD1 } from './sqlite-d1';
import { parseManifest } from '../../src/labs/manifest';
import { sweepStaleSessions } from '../../src/session/reconcile';
import { claimOf, claimsOf } from '../../src/lib/pool-claims';
import * as lifecycle from '../../src/session/lifecycle';

/**
 * Three failure modes of a session's boot, driven through the real router, the
 * real lifecycle and the real SQLite one-session-per-user fence, with only the
 * container-facing edges faked (as in prepare.test.ts):
 *
 * 1. a `start`/`resume` run killed mid-flight (deploy, eviction) must be
 *    retried, bounded, and never hold the user's slot for long;
 * 2. a resume is a start: it passes pool admission and the D1 fence;
 * 3. a cancel that lands while a container call is in flight must not leave
 *    a container running.
 *
 * An eviction is modelled as what it is: a new SessionRuntime over the same
 * storage (in-memory state such as `bootInFlight` is gone), while the killed
 * run's promise simply never settles.
 */

const pool = vi.hoisted(() => ({
  admit: vi.fn(async () => {}),
  claim: vi.fn(async (_sessionId: string) => ({ sandbox_id: 'sb-1' })),
  release: vi.fn(async (_id: string) => {}),
  releaseSession: vi.fn(async (_sessionId: string): Promise<string[]> => []),
}));
vi.mock('../../src/do/pool', () => ({ poolStub: () => pool }));
vi.mock('../../src/session/hydrate', () => ({
  hydrateWorkspaceFiles: async () => {},
  hydratePressureScripts: async () => {},
  applySessionEnv: async () => {},
}));
const services = vi.hoisted(() => ({
  startAllServices: vi.fn(async (..._args: unknown[]) => {}),
  relaunchAllServices: vi.fn(async () => {}),
  healthCheckAll: vi.fn(async () => {}),
  allServicesGone: vi.fn(async () => false),
}));
vi.mock('../../src/session/services', () => services);

const manifest = parseManifest({
  slug: 'lab-a',
  version: '1.0.0',
  title: 'Lab A',
  type: 'build',
  family: 'agent',
  tier: 'free',
  timeout_minutes: 90,
  idle_minutes: 10,
  services: [{ name: 'api', argv: ['python3', 'app.py'], port: 8000, ui: true }],
  checks: [{ name: 'c1', script: 'c1.sh' }],
});
vi.mock('../../src/labs/bundle', () => ({
  loadCurrentManifest: async () => ({ version: '1.0.0', manifest }),
  listCatalogue: async () => ({ labs: [] }),
  publishLab: async () => ({}),
  INDEX_KEY: 'labs/index.json',
}));

const { createRouter } = await import('../../src/router');
const app = createRouter();

/** The documented rules (docs/api.md), as literals so this file states them independently of the code. */
const STUCK_BOOT_MS = 10 * 60_000;
const BOOT_WATCHDOG_MS = 2 * 60_000;
const MAX_BOOT_ATTEMPTS = 3;

const never = () => new Promise<never>(() => {});
/** Waits until the boot has reached `startAllServices` for the `n`th time (where these tests park or kill it). */
const reachedServices = (n: number) => vi.waitFor(() => expect(services.startAllServices).toHaveBeenCalledTimes(n));

function makeWorld() {
  const { db, sqlite } = sqliteD1();
  const live = new Map<string, { rt: SessionRuntime; backend: FakeBackend; ctx: unknown }>();
  const env = {
    SANDBOX_API_KEY: 'svc-key',
    SESSION_TOKEN_SECRET: 'secret',
    PUBLIC_BASE_URL: 'https://api.test',
    LLM_HOST: 'llm.test',
    LLM_MODEL: 'm',
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    AI_GATEWAY_NAME: 'gw',
    DB: db,
    SESSION: { idFromName: (id: string) => id, get: (id: string) => stub(id) },
  } as unknown as Env;

  const newRuntime = (id: string, ctx: unknown, backend: FakeBackend) => {
    const rt = new SessionRuntime(ctx as DurableObjectState, env, id);
    rt.bindBackend = async () => {
      (rt as unknown as { _backend: unknown })._backend = backend.asBackend();
    };
    return rt;
  };
  const runtimeFor = (id: string) => {
    let l = live.get(id);
    if (!l) {
      const storage = createFakeStorage();
      const ctx = { id: { name: id }, storage: { ...storage, sql: { exec: () => [] } }, getWebSockets: () => [] };
      const backend = new FakeBackend();
      l = { rt: newRuntime(id, ctx, backend), backend, ctx };
      live.set(id, l);
    }
    return l;
  };
  const existing = (id: string) => {
    const l = live.get(id);
    if (!l) throw new Error(`Session ${id} has no meta; not created`);
    return l;
  };
  /**
   * The DO is evicted (a deploy, a reset): same storage and container, fresh
   * instance, whose constructor re-binds the stored sandbox (do/session.ts).
   * Whatever the old instance was running never finishes.
   */
  const evict = async (id: string) => {
    const l = existing(id);
    l.rt = newRuntime(id, l.ctx, l.backend);
    const m = await l.rt.requireMeta();
    if (m.sandbox_id) await l.rt.bindBackend(m.family, m.sandbox_id);
  };

  const overrides = new Map<string, Partial<Record<'resume', () => Promise<unknown>>>>();
  const stub = (id: string) => ({
    create: (input: Parameters<typeof lifecycle.createSession>[1]) => lifecycle.createSession(runtimeFor(id).rt, input),
    async status(): Promise<SessionStatus> {
      const { rt } = existing(id);
      const m = await rt.manifest();
      return {
        meta: await rt.requireMeta(),
        services: await rt.services(),
        snapshots: await rt.snapshots(),
        manifest_summary: m ? summarizeManifest(m) : undefined,
      } as unknown as SessionStatus;
    },
    resume: () => overrides.get(id)?.resume?.() ?? lifecycle.requestResume(existing(id).rt),
    begin: () => lifecycle.beginSession(existing(id).rt),
    cancelPrepared: () => lifecycle.cancelPrepared(existing(id).rt),
    endIfStuck: () => lifecycle.endIfStuck(existing(id).rt),
    end: (snapshot = true) => lifecycle.endSession(existing(id).rt, 'user', snapshot),
  });

  /** What the DO alarm does. */
  const alarm = (id: string) => lifecycle.handleAlarm(existing(id).rt);
  /** Makes every timer of `kind` due now, then runs the alarm. */
  const fire = async (id: string, kind: string) => {
    const { rt } = existing(id);
    await rt.putTimers((await rt.timers()).map((t) => (t.kind === kind ? { ...t, at: Date.now() - 1 } : t)));
    await lifecycle.handleAlarm(rt);
  };
  const rt = (id: string) => existing(id).rt;
  const meta = (id: string) => existing(id).rt.requireMeta();
  const timers = (id: string) => existing(id).rt.timers();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const row = async (id: string) => {
    await settle();
    return (sqlite.prepare('SELECT state, end_reason FROM sessions WHERE id = ?').get(id) ?? null) as { state: string; end_reason: string | null } | null;
  };
  const call = (method: string, path: string, body?: unknown, auth = 'Bearer svc-key') =>
    app.fetch(
      new Request(`https://api.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', Authorization: auth },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env
    );
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  /** Starts `lab-a` for `user` (POST /sessions); returns id and token. Does not boot. */
  const start = async (user = 'u1') => {
    const res = await call('POST', '/sessions', { lab: 'lab-a', user_id: user });
    expect(res.status).toBe(202);
    return (await json(res)) as { id: string; token: string };
  };
  /** A container call order for `id`: the index of the last call to `method`. */
  const lastCall = (id: string, method: string) => existing(id).backend.calls.map((c) => c.method).lastIndexOf(method);
  const backend = (id: string) => existing(id).backend;

  return { env, sqlite, evict, alarm, fire, rt, meta, timers, row, call, json, start, lastCall, backend, overrides, settle };
}

beforeEach(() => {
  pool.admit.mockReset().mockResolvedValue(undefined);
  pool.claim.mockReset().mockResolvedValue({ sandbox_id: 'sb-1' });
  pool.release.mockReset().mockResolvedValue(undefined);
  pool.releaseSession.mockReset().mockResolvedValue([]);
  services.startAllServices.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
describe('defect 1: a start or resume killed mid-boot is retried, bounded, and never holds the slot for long', () => {
  it('the start timer is re-armed as a watchdog before the boot runs, so a run killed mid-flight is retried and reaches running', async () => {
    const w = makeWorld();
    const { id } = await w.start();
    services.startAllServices.mockImplementationOnce(never); // the deploy lands here

    void w.alarm(id); // never settles: the instance dies under it
    await reachedServices(1);
    await w.evict(id);
    // The platform retries the alarm on the new instance. Nothing is due yet,
    // but the boot is still owed: a `start` watchdog is queued.
    await w.alarm(id);
    const watchdog = (await w.timers(id)).find((t) => t.kind === 'start');
    expect(watchdog, 'a start timer survives the killed run').toBeDefined();
    expect(watchdog!.at).toBeGreaterThan(Date.now() + BOOT_WATCHDOG_MS - 5_000);
    expect((await w.meta(id)).state).toBe('starting');

    await w.fire(id, 'start');

    const m = await w.meta(id);
    expect(m.state).toBe('running');
    expect(m.boot_attempts).toBeUndefined();
    // The retry reused the claim the killed run stored: one container.
    expect(pool.claim).toHaveBeenCalledTimes(1);
    expect(m.sandbox_id).toBe('sb-1');
    // ...and was told to stop what the killed run had launched.
    expect(services.startAllServices.mock.calls.at(-1)![2]).toEqual({ stopRecorded: true });
    expect((await w.timers(id)).some((t) => t.kind === 'start')).toBe(false);
    expect(await w.row(id)).toMatchObject({ state: 'running' });
  });

  it('a boot killed on every attempt ends as `error` after three and frees the user\'s slot', async () => {
    const w = makeWorld();
    const { id } = await w.start();
    services.startAllServices.mockImplementation(never);

    void w.alarm(id);
    await reachedServices(1);
    for (let attempt = 2; attempt <= MAX_BOOT_ATTEMPTS; attempt++) {
      await w.evict(id);
      void w.fire(id, 'start');
      await reachedServices(attempt);
      expect((await w.meta(id)).boot_attempts).toBe(attempt);
    }
    await w.evict(id);
    await w.fire(id, 'start');
    expect(services.startAllServices).toHaveBeenCalledTimes(MAX_BOOT_ATTEMPTS);

    expect(await w.meta(id)).toMatchObject({ state: 'ended', end_reason: 'error' });
    expect(pool.release).toHaveBeenCalledWith('sb-1');
    expect(await w.row(id)).toMatchObject({ state: 'ended', end_reason: 'error' });
    services.startAllServices.mockReset().mockResolvedValue(undefined);
    expect((await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' })).status).toBe(202);
  });

  it('a watchdog that comes due while the first boot is still running in the same instance does not start a second one', async () => {
    const w = makeWorld();
    const { id } = await w.start();
    let finish!: () => void;
    services.startAllServices.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));

    const first = w.alarm(id);
    await reachedServices(1);
    expect((await w.timers(id)).some((t) => t.kind === 'start')).toBe(true);
    await w.fire(id, 'start'); // a slow boot outlives its watchdog

    expect(services.startAllServices).toHaveBeenCalledTimes(1);
    expect(w.backend(id).callsTo('ensureRunning')).toHaveLength(1);
    expect((await w.meta(id)).boot_attempts).toBe(1); // not counted
    expect((await w.timers(id)).some((t) => t.kind === 'start')).toBe(true); // still watching

    finish();
    await first;
    expect((await w.meta(id)).state).toBe('running');
    expect((await w.timers(id)).some((t) => t.kind === 'start')).toBe(false);
  });

  it('a resume killed mid-boot is retried by its watchdog too', async () => {
    const w = makeWorld();
    const a = await w.start();
    await w.alarm(a.id);
    await w.call('DELETE', `/sessions/${a.id}?snapshot=0`);
    await w.rt(a.id).putSnapshots([{ backup_id: 'b1', dir: '/workspace', ttl: 3600, created_at: Date.now(), reason: 'user' }]);
    expect((await w.call('POST', `/sessions/${a.id}/resume`)).status).toBe(200);
    services.startAllServices.mockImplementationOnce(never);

    const before = services.startAllServices.mock.calls.length;
    void w.alarm(a.id);
    await reachedServices(before + 1);
    await w.evict(a.id);
    await w.alarm(a.id);
    expect((await w.timers(a.id)).some((t) => t.kind === 'resume')).toBe(true);
    await w.fire(a.id, 'resume');

    expect((await w.meta(a.id)).state).toBe('running');
    expect(await w.row(a.id)).toMatchObject({ state: 'running' });
  });

  it('a session stuck in `starting` for ten minutes (its timer lost) no longer blocks the user: start and prepare end it and go on', async () => {
    const w = makeWorld();
    const { id } = await w.start();
    // The deployed behaviour: the start timer was popped and its run killed.
    await w.rt(id).putTimers([]);
    await w.rt(id).patchMeta({ created_at: Date.now() - STUCK_BOOT_MS - 1_000 });

    const res = await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });
    expect(res.status).toBe(202);
    const body = await w.json(res);
    expect(body.id).not.toBe(id);
    expect(body.rejoined).toBeUndefined();
    expect(await w.meta(id)).toMatchObject({ state: 'ended', end_reason: 'error' });
    expect(await w.row(id)).toMatchObject({ state: 'ended', end_reason: 'error' });
    // It never stored a sandbox, so the end path asked the pool for any claim it held.
    expect(pool.releaseSession).toHaveBeenCalledWith(id);
  });

  it('prepare is no longer a 409 behind a stuck boot', async () => {
    const w = makeWorld();
    const { id } = await w.json(await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' }));
    await w.rt(id).putTimers([]);
    await w.rt(id).patchMeta({ created_at: Date.now() - STUCK_BOOT_MS - 1_000, prepare: undefined });
    expect((await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' })).status).toBe(202);
  });

  it('a boot younger than ten minutes is still live: start rejoins it', async () => {
    const w = makeWorld();
    const { id } = await w.start();
    const res = await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });
    expect(res.status).toBe(200);
    expect(await w.json(res)).toMatchObject({ id, rejoined: true });
    expect((await w.meta(id)).state).toBe('starting');
  });

  it('the sweeper ends a stuck boot without waiting three hours', async () => {
    const w = makeWorld();
    const { id } = await w.start();
    await w.rt(id).putTimers([]);
    const past = Date.now() - STUCK_BOOT_MS - 1_000;
    await w.rt(id).patchMeta({ created_at: past });
    w.sqlite.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(past, id);

    expect(await sweepStaleSessions(w.env)).toEqual({ checked: 1, healed: 1 });
    expect(await w.row(id)).toMatchObject({ state: 'ended', end_reason: 'error' });
  });

  it('the code uses the documented limits', () => {
    expect(state.STUCK_BOOT_MS).toBe(STUCK_BOOT_MS);
    expect(lifecycle.BOOT_WATCHDOG_MS).toBe(BOOT_WATCHDOG_MS);
    expect(lifecycle.MAX_BOOT_ATTEMPTS).toBe(MAX_BOOT_ATTEMPTS);
  });

  it('the pool hands a session that already holds a claim the same sandbox (a retry never takes a second one)', () => {
    const claimed = { 'sb-a': { session_id: 's1', claimed_at: 1 }, 'sb-b': { session_id: 's2', claimed_at: 2 } };
    expect(claimOf(claimed, 's1')).toBe('sb-a');
    expect(claimOf(claimed, 's3')).toBeUndefined();
    expect(claimsOf(claimed, 's2')).toEqual(['sb-b']);
  });
});

// ---------------------------------------------------------------------------
describe('defect 2: a resume passes pool admission and the one-session fence', () => {
  /** Session A ended with a snapshot, then session B started and running. */
  async function oldAndNew(w: ReturnType<typeof makeWorld>) {
    const a = await w.start();
    await w.alarm(a.id);
    await w.call('DELETE', `/sessions/${a.id}?snapshot=0`);
    await w.rt(a.id).putSnapshots([{ backup_id: 'b1', dir: '/workspace', ttl: 3600, created_at: Date.now(), reason: 'user' }]);
    pool.claim.mockResolvedValue({ sandbox_id: 'sb-2' });
    const b = await w.start();
    await w.alarm(b.id);
    return { a, b };
  }

  it('resuming an old session with its still-valid token while another is live is 409 active_session_exists, naming the live one', async () => {
    const w = makeWorld();
    const { a, b } = await oldAndNew(w);
    const claims = pool.claim.mock.calls.length;

    const res = await w.call('POST', `/sessions/${a.id}/resume`, undefined, `Bearer ${a.token}`);

    expect(res.status).toBe(409);
    const body = await w.json(res);
    expect(body.error.code).toBe('active_session_exists');
    expect(body.error.details.active_session_id).toBe(b.id);
    expect((await w.meta(a.id)).state).toBe('ended');
    expect((await w.timers(a.id)).some((t) => t.kind === 'resume')).toBe(false);
    expect(pool.claim).toHaveBeenCalledTimes(claims);
    expect(await w.row(a.id)).toMatchObject({ state: 'ended' });
    expect(await w.row(b.id)).toMatchObject({ state: 'running' });
  });

  it('the Session DO itself refuses a resume that did not reserve the slot', async () => {
    const w = makeWorld();
    const { a, b } = await oldAndNew(w);
    await expect(lifecycle.requestResume(w.rt(a.id))).rejects.toMatchObject({ status: 409, code: 'active_session_exists' });
    expect((await w.meta(a.id)).state).toBe('ended');
    expect((await w.meta(b.id)).state).toBe('running');
  });

  it('a resume takes the slot: the row is `resuming` at once, and a new start is refused until it ends', async () => {
    const w = makeWorld();
    const a = await w.start();
    await w.alarm(a.id);
    await w.call('DELETE', `/sessions/${a.id}?snapshot=0`);
    await w.rt(a.id).putSnapshots([{ backup_id: 'b1', dir: '/workspace', ttl: 3600, created_at: Date.now(), reason: 'user' }]);

    expect((await w.call('POST', `/sessions/${a.id}/resume`, undefined, `Bearer ${a.token}`)).status).toBe(200);
    expect(await w.row(a.id)).toMatchObject({ state: 'resuming' });
    expect((await w.call('POST', '/sessions', { lab: 'lab-a', user_id: 'u1' })).status).toBe(409);
    // A second resume of the same session while the first is under way.
    expect((await w.json(await w.call('POST', `/sessions/${a.id}/resume`))).error.code).toBe('cannot_resume');

    await w.alarm(a.id);
    expect(await w.row(a.id)).toMatchObject({ state: 'running' });
  });

  it('a pool that cannot admit refuses the resume (503) and reserves nothing', async () => {
    const w = makeWorld();
    const a = await w.start();
    await w.alarm(a.id);
    await w.call('DELETE', `/sessions/${a.id}?snapshot=0`);
    await w.rt(a.id).putSnapshots([{ backup_id: 'b1', dir: '/workspace', ttl: 3600, created_at: Date.now(), reason: 'user' }]);
    pool.admit.mockRejectedValueOnce(Object.assign(new Error('full; retry_after_s=30'), { name: 'ApiError:503:at_capacity' }));

    const res = await w.call('POST', `/sessions/${a.id}/resume`);
    expect(res.status).toBe(503);
    expect((await w.meta(a.id)).state).toBe('ended');
    expect(await w.row(a.id)).toMatchObject({ state: 'ended' });
  });

  it('a resume the DO refuses gives the slot back', async () => {
    const w = makeWorld();
    const a = await w.start();
    await w.alarm(a.id);
    await w.call('DELETE', `/sessions/${a.id}?snapshot=0`);
    await w.rt(a.id).putSnapshots([{ backup_id: 'b1', dir: '/workspace', ttl: 3600, created_at: Date.now(), reason: 'user' }]);
    w.overrides.set(a.id, { resume: async () => Promise.reject(new Error('rpc failed')) });

    expect((await w.call('POST', `/sessions/${a.id}/resume`)).status).toBe(500);
    expect(await w.row(a.id)).toMatchObject({ state: 'ended' });
    expect((await w.call('POST', '/sessions', { lab: 'lab-a', user_id: 'u1' })).status).toBe(202);
  });

  it('a resume whose boot fails ends the session and frees the slot', async () => {
    const w = makeWorld();
    const a = await w.start();
    await w.alarm(a.id);
    await w.call('DELETE', `/sessions/${a.id}?snapshot=0`);
    await w.rt(a.id).putSnapshots([{ backup_id: 'b1', dir: '/workspace', ttl: 3600, created_at: Date.now(), reason: 'user' }]);
    await w.call('POST', `/sessions/${a.id}/resume`);
    pool.claim.mockRejectedValueOnce(new Error('no capacity'));

    await w.alarm(a.id);
    expect(await w.meta(a.id)).toMatchObject({ state: 'ended', end_reason: 'error' });
    expect(await w.row(a.id)).toMatchObject({ state: 'ended', end_reason: 'error' });
  });
});

// ---------------------------------------------------------------------------
describe('defect 3: a cancel during the boot leaves no container running', () => {
  it('DELETE while ensureRunning is in flight: the container it brings back is destroyed, and the boot stops', async () => {
    const w = makeWorld();
    const { id } = await w.json(await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' }));
    const b = w.backend(id);
    const ensure = b.ensureRunning.bind(b);
    b.ensureRunning = async () => {
      await w.call('DELETE', `/sessions/${id}`); // endSession destroys the container here...
      return ensure(); // ...and the call in flight starts it again
    };

    await w.alarm(id);

    expect((await w.meta(id)).state).toBe('ended');
    expect(w.lastCall(id, 'destroy')).toBeGreaterThan(w.lastCall(id, 'ensureRunning'));
    expect(services.startAllServices).not.toHaveBeenCalled();
    expect(pool.release).toHaveBeenCalledWith('sb-1');
  });

  it('a cancel during startAllServices destroys the container after the services call returns', async () => {
    const w = makeWorld();
    const { id } = await w.json(await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' }));
    services.startAllServices.mockImplementationOnce(async () => {
      expect((await w.json(await w.call('POST', '/sessions/prepare/cancel', { user_id: 'u1' }))).cancelled).toBe(true);
    });

    await w.alarm(id);

    expect((await w.meta(id)).state).toBe('ended');
    // Once by endSession, once more after the in-flight services call.
    expect(w.backend(id).callsTo('destroy')).toHaveLength(2);
    expect(await w.row(id)).toMatchObject({ state: 'ended' });
  });

  it('a container call that throws after a cancel still ends with the container destroyed', async () => {
    const w = makeWorld();
    const { id } = await w.start();
    const b = w.backend(id);
    b.ensureRunning = async () => {
      await w.call('DELETE', `/sessions/${id}`);
      b.calls.push({ method: 'ensureRunning', args: [] });
      throw new Error('container reset');
    };

    await w.alarm(id);

    expect(await w.meta(id)).toMatchObject({ state: 'ended', end_reason: 'user' });
    expect(w.lastCall(id, 'destroy')).toBeGreaterThan(w.lastCall(id, 'ensureRunning'));
  });

  it('DELETE during a resume\'s restore destroys the restored container', async () => {
    const w = makeWorld();
    const a = await w.start();
    await w.alarm(a.id);
    await w.call('DELETE', `/sessions/${a.id}?snapshot=0`);
    await w.rt(a.id).putSnapshots([{ backup_id: 'b1', dir: '/workspace', ttl: 3600, created_at: Date.now(), reason: 'user' }]);
    await w.call('POST', `/sessions/${a.id}/resume`);
    const b = w.backend(a.id);
    const restore = b.restoreBackup.bind(b);
    b.restoreBackup = async (backup: unknown) => {
      await w.call('DELETE', `/sessions/${a.id}`);
      return restore(backup);
    };

    await w.alarm(a.id);

    expect((await w.meta(a.id)).state).toBe('ended');
    expect(w.lastCall(a.id, 'destroy')).toBeGreaterThan(w.lastCall(a.id, 'restoreBackup'));
    expect(await w.row(a.id)).toMatchObject({ state: 'ended' });
  });
});
