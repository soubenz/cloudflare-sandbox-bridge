import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/env';
import { SessionRuntime, summarizeManifest } from '../../src/session/state';
import type { SessionMeta, SessionStatus } from '../../src/session/state';
import { createFakeStorage } from '../fakes/fake-storage';
import { FakeBackend } from '../fakes/fake-backend';
import { sqliteD1, type Sqlite } from './sqlite-d1';
import { parseManifest } from '../../src/labs/manifest';
import { verifySessionToken } from '../../src/auth';
import { insertSession, isActiveSessionConflict } from '../../src/session/d1';
import * as lifecycle from '../../src/session/lifecycle';

/**
 * Lab pre-warming: `POST /sessions/prepare` boots a container but parks the
 * session in `ready` with no lab clocks; `begin` (or `POST /sessions/start`)
 * turns it into an ordinary running session.
 *
 * The router, the lifecycle and the D1 fence are all real here. Only the
 * container-facing edges are stubbed (pool, hydrate, services, backend), and
 * the Session DO is a thin in-process namespace over real SessionRuntimes, so
 * a route test drives exactly the code a Worker would. The `start` timer is
 * fired by hand (`boot`), which is what the DO alarm does in production.
 */

const pool = vi.hoisted(() => ({
  admit: vi.fn(async () => {}),
  claim: vi.fn(async (_sessionId: string) => ({ sandbox_id: 'sb-1' })),
  release: vi.fn(async (_id: string) => {}),
}));
vi.mock('../../src/do/pool', () => ({ poolStub: () => pool }));
vi.mock('../../src/session/hydrate', () => ({
  hydrateWorkspaceFiles: async () => {},
  hydratePressureScripts: async () => {},
  applySessionEnv: async () => {},
}));
const services = vi.hoisted(() => ({
  startAllServices: vi.fn(async () => {}),
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
  timeout_minutes: 90,
  idle_minutes: 10,
  services: [{ name: 'api', argv: ['python3', 'app.py'], port: 8000, ui: true }],
  checks: [{ name: 'c1', script: 'c1.sh' }],
  hints: [
    { after_minutes: 5, text: 'first' },
    { after_minutes: 20, text: 'second' },
  ],
  pressure: [{ id: 'p1', at_minutes: 15, argv: ['true'], title: 'T', message: 'M' }],
});
vi.mock('../../src/labs/bundle', () => ({
  loadCurrentManifest: async () => ({ version: '1.0.0', manifest }),
  listCatalogue: async () => ({ labs: [] }),
  publishLab: async () => ({}),
  INDEX_KEY: 'labs/index.json',
}));

const { createRouter } = await import('../../src/router');
const app = createRouter();

const SERVICE = { Authorization: 'Bearer svc-key' };

interface Live {
  rt: SessionRuntime;
  backend: FakeBackend;
}

function makeWorld() {
  const { db, sqlite } = sqliteD1();
  const live = new Map<string, Live>();
  const env = {
    SANDBOX_API_KEY: 'svc-key',
    SESSION_TOKEN_SECRET: 'secret',
    PUBLIC_BASE_URL: 'https://api.test',
    LLM_HOST: 'llm.test',
    LLM_MODEL: 'm',
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    AI_GATEWAY_NAME: 'gw',
    DB: db,
    SESSION: {
      idFromName: (id: string) => id,
      get: (id: string) => stub(id),
    },
  } as unknown as Env;

  const runtimeFor = (id: string): Live => {
    let l = live.get(id);
    if (!l) {
      const storage = createFakeStorage();
      const ctx = { id: { name: id }, storage: { ...storage, sql: { exec: () => [] } }, getWebSockets: () => [] };
      const rt = new SessionRuntime(ctx as unknown as DurableObjectState, env, id);
      const backend = new FakeBackend();
      rt.bindBackend = async () => {
        (rt as unknown as { _backend: unknown })._backend = backend.asBackend();
      };
      l = { rt, backend };
      live.set(id, l);
    }
    return l;
  };
  const existing = (id: string): Live => {
    const l = live.get(id);
    if (!l) throw new Error(`Session ${id} has no meta; not created`);
    return l;
  };

  const stub = (id: string) => ({
    create: (input: Parameters<typeof lifecycle.createSession>[1]) => lifecycle.createSession(runtimeFor(id).rt, input),
    async status(): Promise<SessionStatus> {
      const { rt } = existing(id);
      const meta = await rt.requireMeta();
      const m = await rt.manifest();
      return { meta, services: await rt.services(), manifest_summary: m ? summarizeManifest(m) : undefined } as unknown as SessionStatus;
    },
    begin: () => lifecycle.beginSession(existing(id).rt),
    cancelPrepared: () => lifecycle.cancelPrepared(existing(id).rt),
    end: (snapshot = true) => lifecycle.endSession(existing(id).rt, 'user', snapshot),
  });

  /** What the DO alarm does: runs every due timer (the `start` timer, once the session is created). */
  const boot = (id: string) => lifecycle.handleAlarm(existing(id).rt);
  /** Makes the timers of `kind` due, then runs the alarm. */
  const fire = async (id: string, kind: string) => {
    const { rt } = existing(id);
    await rt.putTimers((await rt.timers()).map((t) => (t.kind === kind ? { ...t, at: Date.now() - 1 } : t)));
    await lifecycle.handleAlarm(rt);
  };
  const meta = (id: string) => existing(id).rt.requireMeta();
  const timers = (id: string) => existing(id).rt.timers();
  /** `bestEffort` D1 writes are fire-and-forget; let them land. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const row = async (id: string) => {
    await settle();
    return (sqlite.prepare('SELECT state, end_reason, started_at, expires_at FROM sessions WHERE id = ?').get(id) ?? null) as {
      state: string;
      end_reason: string | null;
      started_at: number | null;
      expires_at: number | null;
    } | null;
  };
  const rows = (): number => (sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;

  const call = (method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`https://api.test${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...SERVICE },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env
    );
  const json = async (res: Response) => (await res.json()) as Record<string, any>;

  return { env, sqlite, live, boot, fire, meta, timers, row, rows, settle, call, json, backend: (id: string) => existing(id).backend, rt: (id: string) => existing(id).rt };
}

beforeEach(() => {
  pool.admit.mockReset().mockResolvedValue(undefined);
  pool.claim.mockReset().mockResolvedValue({ sandbox_id: 'sb-1' });
  pool.release.mockReset().mockResolvedValue(undefined);
  services.startAllServices.mockReset().mockResolvedValue(undefined);
});

/** Prepares `lab-a` for `user` and runs its start timer. Returns the session id. */
async function prepared(w: ReturnType<typeof makeWorld>, user = 'u1'): Promise<string> {
  const res = await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: user });
  expect(res.status).toBe(202);
  const { id } = await w.json(res);
  await w.boot(id);
  return id;
}

describe('POST /sessions/prepare: parks without clocks', () => {
  it('boots the container fully, then waits in `ready` with only the claim timer', async () => {
    const w = makeWorld();
    const res = await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' });
    expect(res.status).toBe(202);
    const body = await w.json(res);
    expect(body).toMatchObject({ prepared: true, state: 'starting' });
    // No token or URLs: those are minted when the lab begins.
    expect(body.token).toBeUndefined();
    expect((await w.meta(body.id)).prepare).toBe(true);

    const before = Date.now();
    await w.boot(body.id);

    const m = await w.meta(body.id);
    expect(m.state).toBe('ready');
    expect(m.prepared_at).toBeGreaterThanOrEqual(before);
    // The lab clock has not started.
    expect(m.started_at).toBeUndefined();
    expect(m.expires_at).toBeUndefined();
    // Container claimed once and the whole start sequence ran.
    expect(pool.claim).toHaveBeenCalledTimes(1);
    expect(w.backend(body.id).callsTo('ensureRunning')).toHaveLength(1);
    expect(services.startAllServices).toHaveBeenCalledTimes(1);
    // One timer: the claim timer. No hard/idle/pressure/hint/health/metrics.
    const t = await w.timers(body.id);
    expect(t.map((x) => x.kind)).toEqual(['prepare_expiry']);
    expect(t[0]!.at).toBeGreaterThanOrEqual(m.prepared_at! + lifecycle.PREPARE_TTL_MS - 5);
    expect(t[0]!.at).toBeLessThanOrEqual(m.prepared_at! + lifecycle.PREPARE_TTL_MS + 5);
    // D1 holds the slot as `ready`.
    expect((await w.row(body.id))!.state).toBe('ready');
  });

  it('is exposed through GET /sessions/:id as state `ready` with prepared_at', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    const status = await w.json(await w.call('GET', `/sessions/${id}`));
    expect(status.meta.state).toBe('ready');
    expect(typeof status.meta.prepared_at).toBe('number');
    expect(status.meta.expires_at).toBeUndefined();
  });

  it('preparing twice returns the one session', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    const again = await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' });
    expect(again.status).toBe(200);
    expect(await w.json(again)).toMatchObject({ id, prepared: true, reused: true, state: 'ready' });
    expect(w.rows()).toBe(1);
    expect(pool.claim).toHaveBeenCalledTimes(1);
  });

  it('preparing again while the first is still booting also returns it', async () => {
    const w = makeWorld();
    const first = await w.json(await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' }));
    const second = await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' });
    expect(second.status).toBe(200);
    expect((await w.json(second)).id).toBe(first.id);
    expect(w.rows()).toBe(1);
  });

  it('is refused (409) while the user has a lab running', async () => {
    const w = makeWorld();
    const started = await w.json(await w.call('POST', '/sessions', { lab: 'lab-a', user_id: 'u1' }));
    await w.boot(started.id);
    const res = await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' });
    expect(res.status).toBe(409);
    expect((await w.json(res)).error.code).toBe('active_session_exists');
    expect((await w.meta(started.id)).state).toBe('running');
  });

  it('a prepare for another lab replaces the user\'s earlier pre-warm', async () => {
    const w = makeWorld();
    const first = await prepared(w);
    // The mocked catalogue answers every slug with lab-a, so ask for the one
    // the existing pre-warm is not.
    await w.rt(first).patchMeta({ lab_slug: 'lab-z' });
    const res = await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' });
    expect(res.status).toBe(202);
    const next = await w.json(res);
    expect(next.id).not.toBe(first);
    expect((await w.meta(first)).state).toBe('ended');
    expect(await w.row(first)).toMatchObject({ state: 'ended', end_reason: 'user' });
  });

  it('requires lab and user_id, and the service key', async () => {
    const w = makeWorld();
    expect((await w.call('POST', '/sessions/prepare', { lab: 'lab-a' })).status).toBe(400);
    const anon = await app.fetch(new Request('https://api.test/sessions/prepare', { method: 'POST', body: '{}' }), w.env);
    expect(anon.status).toBe(401);
  });

  it('a failed container claim ends the session as `error` and frees the user\'s slot', async () => {
    const w = makeWorld();
    pool.claim.mockRejectedValueOnce(new Error('no capacity'));
    const { id } = await w.json(await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' }));
    await w.boot(id);

    expect(await w.meta(id)).toMatchObject({ state: 'ended', end_reason: 'error' });
    expect(await w.row(id)).toMatchObject({ state: 'ended', end_reason: 'error' });
    // The normal start still works, cold.
    const cold = await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });
    expect(cold.status).toBe(202);
    expect((await w.json(cold)).state).toBe('starting');
  });
});

describe('begin: ready -> running', () => {
  it('starts the clocks, drops the claim timer, and mints a token that outlives the session', async () => {
    const w = makeWorld();
    const id = await prepared(w);

    const before = Date.now();
    const res = await w.call('POST', `/sessions/${id}/begin`);
    expect(res.status).toBe(200);
    const body = await w.json(res);

    const m = await w.meta(id);
    expect(m.state).toBe('running');
    expect(m.prepare).toBeUndefined();
    expect(m.started_at).toBeGreaterThanOrEqual(before);
    expect(m.expires_at).toBe(m.started_at! + 90 * 60_000);
    expect((await w.timers(id)).some((t) => t.kind === 'prepare_expiry')).toBe(false);
    expect((await w.row(id))).toMatchObject({ state: 'running', expires_at: m.expires_at });

    const token = await verifySessionToken(w.env, body.token);
    expect(token).toMatchObject({ sid: id, uid: 'u1' });
    expect(token.exp * 1000).toBeGreaterThan(m.expires_at!);
  });

  it('schedules exactly the timers a normal start does', async () => {
    const w = makeWorld();
    const normal = await w.json(await w.call('POST', '/sessions', { lab: 'lab-a', user_id: 'normal' }));
    await w.boot(normal.id);
    const warmed = await prepared(w, 'warm');
    await w.call('POST', `/sessions/${warmed}/begin`);

    // kind, ref and offset from each session's own started_at.
    const shape = async (id: string) => {
      const m = await w.meta(id);
      return (await w.timers(id)).map((t) => `${t.kind}|${t.ref ?? ''}|${t.at - m.started_at!}`).sort();
    };
    const expected = await shape(normal.id);
    expect(expected.length).toBeGreaterThanOrEqual(8); // hard, hard_warn, idle, idle_warn, pressure, 2 hints, health, metrics
    expect(await shape(warmed)).toEqual(expected);
  });

  it('is idempotent: a second begin changes nothing', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    await w.call('POST', `/sessions/${id}/begin`);
    const first = await w.meta(id);
    const timers = await w.timers(id);

    const again = await w.call('POST', `/sessions/${id}/begin`);
    expect(again.status).toBe(200);
    expect(await w.meta(id)).toEqual(first);
    expect(await w.timers(id)).toEqual(timers);
  });

  it('on a session that is not a pre-warm (already running) is a no-op that still answers', async () => {
    const w = makeWorld();
    const { id } = await w.json(await w.call('POST', '/sessions', { lab: 'lab-a', user_id: 'u1' }));
    await w.boot(id);
    const before = await w.meta(id);
    const res = await w.call('POST', `/sessions/${id}/begin`);
    expect(res.status).toBe(200);
    expect(await w.meta(id)).toEqual(before);
  });

  it('on an ended session is a 409 cannot_begin', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    await w.call('DELETE', `/sessions/${id}`);
    const res = await w.call('POST', `/sessions/${id}/begin`);
    expect(res.status).toBe(409);
    expect((await w.json(res)).error.code).toBe('cannot_begin');
  });

  it('while the container is still booting, makes the start sequence finish straight into running', async () => {
    const w = makeWorld();
    const { id } = await w.json(await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' }));
    const res = await w.call('POST', `/sessions/${id}/begin`);
    expect(res.status).toBe(200);
    expect((await w.meta(id)).state).toBe('starting');
    expect((await w.meta(id)).prepare).toBeUndefined();

    await w.boot(id);

    const m = await w.meta(id);
    expect(m.state).toBe('running');
    expect(m.expires_at).toBeDefined();
    expect((await w.timers(id)).some((t) => t.kind === 'hard')).toBe(true);
    expect((await w.timers(id)).some((t) => t.kind === 'prepare_expiry')).toBe(false);
  });

  it('a ready session is not usable as a lab until begun (file and run routes are not_running)', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    await expect(w.rt(id).requireRunning()).rejects.toMatchObject({ status: 409, code: 'not_running' });
  });
});

describe('the claim timer', () => {
  it('ends an unbegun session as `unclaimed`: no snapshot, container destroyed and released, slot freed', async () => {
    const w = makeWorld();
    const id = await prepared(w);

    await w.fire(id, 'prepare_expiry');

    const m = await w.meta(id);
    expect(m).toMatchObject({ state: 'ended', end_reason: 'unclaimed', last_sandbox_id: 'sb-1' });
    expect(m.sandbox_id).toBeUndefined();
    expect(await w.rt(id).snapshots()).toEqual([]);
    expect(w.backend(id).callsTo('createBackup')).toHaveLength(0);
    expect(w.backend(id).callsTo('destroy')).toHaveLength(1);
    expect(pool.release).toHaveBeenCalledWith('sb-1');
    expect(await w.row(id)).toMatchObject({ state: 'ended', end_reason: 'unclaimed' });
    // The user can start again straight away.
    const next = await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });
    expect(next.status).toBe(202);
  });

  it('a stale claim timer never ends a lab that has begun', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    await w.call('POST', `/sessions/${id}/begin`);
    await w.rt(id).putTimers([...(await w.timers(id)), { kind: 'prepare_expiry', at: Date.now() - 1 }]);

    await lifecycle.handleAlarm(w.rt(id));

    expect((await w.meta(id)).state).toBe('running');
    expect(w.backend(id).callsTo('destroy')).toHaveLength(0);
  });
});

describe('POST /sessions/start reuses a pre-warm', () => {
  it('begins the ready session of that user and lab, with the same payload as a cold start', async () => {
    const w = makeWorld();
    const id = await prepared(w);

    const res = await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });
    expect(res.status).toBe(202);
    const body = await w.json(res);

    expect(body.id).toBe(id);
    expect(body.state).toBe('running');
    expect(body.rejoined).toBeUndefined();
    expect(Object.keys(body).sort()).toEqual(['id', 'state', 'token', 'urls']);
    expect(body.urls.services.api).toBe(`https://api.test/sessions/${id}/services/api/`);
    expect(body.urls.status).toBe(`https://api.test/sessions/${id}`);
    expect(await verifySessionToken(w.env, body.token)).toMatchObject({ sid: id, uid: 'u1' });
    // No second session, no second container.
    expect(w.rows()).toBe(1);
    expect(pool.claim).toHaveBeenCalledTimes(1);
    expect((await w.meta(id)).state).toBe('running');
    expect((await w.timers(id)).some((t) => t.kind === 'hard')).toBe(true);
  });

  it('a second Start rejoins the now-running session as it always did', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });
    const res = await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });
    expect(res.status).toBe(200);
    expect(await w.json(res)).toMatchObject({ id, rejoined: true, state: 'running' });
  });

  it('a Start that arrives while the pre-warm is still booting begins it, and it finishes into running', async () => {
    const w = makeWorld();
    const { id } = await w.json(await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' }));
    const res = await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });
    expect(res.status).toBe(202);
    expect(await w.json(res)).toMatchObject({ id, state: 'starting' });

    await w.boot(id);
    expect((await w.meta(id)).state).toBe('running');
    expect(w.rows()).toBe(1);
  });

  it('replaces the pre-warm of another lab with a cold start of the one asked for', async () => {
    const w = makeWorld();
    const first = await prepared(w);
    await w.rt(first).patchMeta({ lab_slug: 'lab-z' });

    const res = await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });
    expect(res.status).toBe(202);
    const body = await w.json(res);
    expect(body.id).not.toBe(first);
    expect(body.state).toBe('starting');
    expect(await w.row(first)).toMatchObject({ state: 'ended', end_reason: 'user' });
    expect(w.rows()).toBe(2);
  });

  it('starts fresh when the pre-warm expired a moment ago', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    await w.fire(id, 'prepare_expiry');
    const res = await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });
    expect(res.status).toBe(202);
    const body = await w.json(res);
    expect(body.id).not.toBe(id);
    expect(body.state).toBe('starting');
  });
});

describe('cancelling a pre-warm', () => {
  it('DELETE /sessions/:id on a ready session ends it without a snapshot', async () => {
    const w = makeWorld();
    const id = await prepared(w);

    const res = await w.call('DELETE', `/sessions/${id}`);
    expect(res.status).toBe(200);

    expect(await w.meta(id)).toMatchObject({ state: 'ended', end_reason: 'user' });
    expect(w.backend(id).callsTo('createBackup')).toHaveLength(0);
    expect(await w.rt(id).snapshots()).toEqual([]);
    expect(w.backend(id).callsTo('destroy')).toHaveLength(1);
    expect(pool.release).toHaveBeenCalledWith('sb-1');
    expect(await w.row(id)).toMatchObject({ state: 'ended', end_reason: 'user' });
    expect((await w.timers(id)).map((t) => t.kind)).toEqual(['cleanup']);
  });

  it('POST /sessions/prepare/cancel ends the user\'s unbegun pre-warm', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    const res = await w.call('POST', '/sessions/prepare/cancel', { user_id: 'u1', lab: 'lab-a' });
    expect(await w.json(res)).toEqual({ ok: true, cancelled: true });
    expect((await w.meta(id)).state).toBe('ended');
  });

  it('also cancels one that is still booting, and releases a container claimed after the cancel', async () => {
    const w = makeWorld();
    const { id } = await w.json(await w.call('POST', '/sessions/prepare', { lab: 'lab-a', user_id: 'u1' }));
    // The cancel lands while runStart is awaiting its claim.
    pool.claim.mockImplementationOnce(async () => {
      expect((await w.json(await w.call('POST', '/sessions/prepare/cancel', { user_id: 'u1' }))).cancelled).toBe(true);
      return { sandbox_id: 'sb-late' };
    });
    await w.boot(id);

    expect((await w.meta(id)).state).toBe('ended');
    expect((await w.meta(id)).sandbox_id).toBeUndefined();
    expect(pool.release).toHaveBeenCalledWith('sb-late');
    expect(w.backend(id).callsTo('ensureRunning')).toHaveLength(0);
    expect(await w.row(id)).toMatchObject({ state: 'ended' });
  });

  it('never ends a lab that has begun (a late beacon is a harmless no-op)', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    await w.call('POST', '/sessions/start', { lab: 'lab-a', user_id: 'u1' });

    const res = await w.call('POST', '/sessions/prepare/cancel', { user_id: 'u1', lab: 'lab-a' });
    expect(await w.json(res)).toEqual({ ok: true, cancelled: false });
    expect((await w.meta(id)).state).toBe('running');
    expect(w.backend(id).callsTo('destroy')).toHaveLength(0);
  });

  it('with a lab filter, leaves another lab\'s pre-warm alone; with no session at all it is ok', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    expect(await w.json(await w.call('POST', '/sessions/prepare/cancel', { user_id: 'u1', lab: 'other-lab' }))).toEqual({ ok: true, cancelled: false });
    expect((await w.meta(id)).state).toBe('ready');
    expect(await w.json(await w.call('POST', '/sessions/prepare/cancel', { user_id: 'nobody' }))).toEqual({ ok: true, cancelled: false });
    expect((await w.call('POST', '/sessions/prepare/cancel', {})).status).toBe(400);
  });
});

describe('the one-session-per-user fence counts `ready`', () => {
  const row = (id: string, user: string, state: SessionMeta['state']): SessionMeta => ({
    id,
    user_id: user,
    lab_slug: 'lab-a',
    lab_version: '1.0.0',
    family: 'agent',
    state,
    created_at: 1,
    resumed_count: 0,
  });

  it('refuses a second active row while the first is `ready`, and allows it once that has ended', async () => {
    const { db, sqlite } = sqliteD1();
    const env = { DB: db } as unknown as Env;
    await insertSession(env, row('a', 'u1', 'ready'));
    let err: unknown;
    await insertSession(env, row('b', 'u1', 'starting')).catch((e) => (err = e));
    expect(isActiveSessionConflict(err)).toBe(true);
    // Another user is unaffected.
    await insertSession(env, row('c', 'u2', 'ready'));

    (sqlite as Sqlite).prepare("UPDATE sessions SET state = 'ended' WHERE id = 'a'").run();
    await insertSession(env, row('b', 'u1', 'starting'));
  });
});

describe('ready sessions in listings', () => {
  it('GET /sessions and the user\'s active list include a ready session (its container is held)', async () => {
    const w = makeWorld();
    const id = await prepared(w);
    const live = (await w.json(await w.call('GET', '/sessions'))) as unknown as Array<{ id: string; state: string }>;
    expect(live).toEqual([expect.objectContaining({ id, state: 'ready' })]);
    const mine = (await w.json(await w.call('GET', '/users/u1/sessions?active=1'))) as unknown as Array<{ id: string }>;
    expect(mine.map((r) => r.id)).toEqual([id]);
  });
});

describe('resume shares the timer list with start and begin', () => {
  it('a resumed session gets the same timers as a normal start', async () => {
    const w = makeWorld();
    const { id } = await w.json(await w.call('POST', '/sessions', { lab: 'lab-a', user_id: 'n' }));
    await w.boot(id);
    const shape = async () => {
      const m = await w.meta(id);
      return (await w.timers(id))
        .filter((t) => t.kind !== 'cleanup')
        .map((t) => `${t.kind}|${t.ref ?? ''}|${t.at - m.started_at!}`)
        .sort();
    };
    const started = await shape();

    await w.call('DELETE', `/sessions/${id}?snapshot=0`);
    await w.rt(id).putSnapshots([{ backup_id: 'b1', dir: '/workspace', ttl: 3600, created_at: Date.now(), reason: 'user' }]);
    await lifecycle.requestResume(w.rt(id));
    await w.boot(id);

    expect((await w.meta(id)).state).toBe('running');
    expect(await shape()).toEqual(started);
  });
});
