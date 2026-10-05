import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/env';
import { parseManifest } from '../../src/labs/manifest';
import { mintSessionToken } from '../../src/auth';
import { ApiError } from '../../src/lib/errors';
import { createFakeD1, type D1Call } from '../fakes/fake-d1';
import { sweepStaleSessions } from '../../src/session/reconcile';

const pool = vi.hoisted(() => ({ admit: vi.fn(async () => {}), stats: vi.fn() }));
vi.mock('../../src/do/pool', () => ({ poolStub: () => pool }));

const tierOf = vi.hoisted(() => ({ value: 'free' as 'free' | 'pro' }));
const manifest = parseManifest({
  slug: 'lab-a', version: '1.0.0', title: 'Lab A', type: 'build', family: 'agent', tier: 'free', timeout_minutes: 60,
  services: [{ name: 'api', argv: ['python3', 'app.py'], port: 8000, ui: true }],
  checks: [{ name: 'c1', script: 'c1.sh' }],
});
vi.mock('../../src/labs/bundle', () => ({
  loadCurrentManifest: async () => ({ version: '1.0.0', manifest: { ...manifest, tier: tierOf.value } }),
  listCatalogue: async () => ({ labs: [] }),
  publishLab: async () => ({}),
  INDEX_KEY: 'labs/index.json',
}));

const { createRouter } = await import('../../src/router');
const app = createRouter();

const UNIQUE = new Error('D1_ERROR: UNIQUE constraint failed: sessions.user_id: SQLITE_CONSTRAINT');
const SERVICE = { Authorization: 'Bearer svc-key' };

type StubBehavior = { status?: () => Promise<unknown>; create?: () => Promise<unknown> };

function makeEnv(opts: { d1?: (call: D1Call) => unknown; stubs?: Record<string, StubBehavior>; defaultCreate?: () => Promise<unknown> } = {}) {
  const fake = createFakeD1(opts.d1);
  const created: string[] = [];
  const env = {
    SANDBOX_API_KEY: 'svc-key',
    SESSION_TOKEN_SECRET: 'secret',
    PUBLIC_BASE_URL: 'https://api.test',
    DB: fake.db,
    SESSION: {
      idFromName: (id: string) => id,
      get: (id: string) => {
        const b = opts.stubs?.[id] ?? {};
        return {
          status: b.status ?? (async () => { throw new Error(`Session ${id} has no meta; not created`); }),
          create:
            b.create ??
            (async () => {
              created.push(id);
              return opts.defaultCreate ? opts.defaultCreate() : { meta: { state: 'starting' }, token: 'tok' };
            }),
        };
      },
    },
  } as unknown as Env;
  return { env, ...fake, created };
}

const call = (env: Env, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) =>
  app.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    env
  );

async function sessionAuth(env: Env, sid = 's1', uid = 'u1') {
  return { Authorization: `Bearer ${await mintSessionToken(env, { sid, uid, exp: Math.floor(Date.now() / 1000) + 3600 })}` };
}

beforeEach(() => {
  pool.admit.mockReset();
  pool.admit.mockResolvedValue(undefined);
});

describe('createSession reconciliation (B-18)', () => {
  /** insert #1 conflicts, every later insert succeeds. */
  function conflictOnce(extra: (call: D1Call) => unknown = () => undefined) {
    let inserts = 0;
    return (c: D1Call) => {
      if (/^INSERT INTO sessions/.test(c.sql) && inserts++ === 0) throw UNIQUE;
      if (/FROM sessions WHERE user_id/.test(c.sql)) return [{ id: 'old-session', state: 'running' }];
      return extra(c);
    };
  }

  it('conflict + DO ended -> the stale row is healed and the retry returns 202', async () => {
    const { env, calls } = makeEnv({
      d1: conflictOnce(),
      stubs: { 'old-session': { status: async () => ({ meta: { state: 'ended', ended_at: 5, end_reason: 'idle' } }) } },
    });

    const res = await call(env, 'POST', '/sessions', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE });

    expect(res.status).toBe(202);
    const heal = calls.find((c) => /UPDATE sessions SET state = 'ended'/.test(c.sql))!;
    expect(heal.params).toEqual([5, 'idle', 'old-session']);
    expect(calls.filter((c) => /^INSERT INTO sessions/.test(c.sql))).toHaveLength(2);
  });

  it('conflict + the DO has no meta -> healed with reason error, 202', async () => {
    const { env, calls } = makeEnv({ d1: conflictOnce() });
    const res = await call(env, 'POST', '/sessions', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE });
    expect(res.status).toBe(202);
    expect(calls.find((c) => /UPDATE sessions SET state = 'ended'/.test(c.sql))!.params.slice(1)).toEqual(['error', 'old-session']);
  });

  it('conflict + the DO is genuinely live -> 409 active_session_exists and nothing healed', async () => {
    const { env, calls } = makeEnv({
      d1: conflictOnce(),
      stubs: { 'old-session': { status: async () => ({ meta: { state: 'running' } }) } },
    });
    const res = await call(env, 'POST', '/sessions', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('active_session_exists');
    expect(calls.some((c) => /UPDATE sessions SET state = 'ended'/.test(c.sql))).toBe(false);
  });

  it('a DO that cannot be reached is not treated as dead', async () => {
    const { env } = makeEnv({
      d1: conflictOnce(),
      stubs: { 'old-session': { status: async () => { throw new Error('network lost'); } } },
    });
    const res = await call(env, 'POST', '/sessions', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE });
    expect(res.status).toBe(409);
  });

  it('the retry is one attempt: a second conflict is a 409', async () => {
    const { env } = makeEnv({
      d1: (c) => {
        if (/^INSERT INTO sessions/.test(c.sql)) throw UNIQUE;
        if (/FROM sessions WHERE user_id/.test(c.sql)) return [{ id: 'old-session', state: 'running' }];
      },
      stubs: { 'old-session': { status: async () => ({ meta: { state: 'ended' } }) } },
    });
    expect((await call(env, 'POST', '/sessions', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE })).status).toBe(409);
  });

  it('a D1 error that is not the unique-index violation is a 500, not a 409', async () => {
    const { env, calls } = makeEnv({
      d1: (c) => {
        if (/^INSERT INTO sessions/.test(c.sql)) throw new Error('D1_ERROR: no such table: sessions');
      },
    });
    const res = await call(env, 'POST', '/sessions', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('internal_error');
    expect(calls.some((c) => /FROM sessions WHERE user_id/.test(c.sql))).toBe(false);
  });

  it('the unique index is recognised by name as well as by message', async () => {
    const { env } = makeEnv({
      d1: (c) => {
        if (/^INSERT INTO sessions/.test(c.sql)) throw new Error('constraint sessions_active_user violated');
        if (/FROM sessions WHERE user_id/.test(c.sql)) return [{ id: 'old-session', state: 'running' }];
      },
      stubs: { 'old-session': { status: async () => ({ meta: { state: 'running' } }) } },
    });
    expect((await call(env, 'POST', '/sessions', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE })).status).toBe(409);
  });

  it('stub.create() throwing marks the new row ended/error and rethrows', async () => {
    const { env, calls } = makeEnv({ defaultCreate: async () => { throw new Error('boom'); } });
    const res = await call(env, 'POST', '/sessions', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE });
    expect(res.status).toBe(500);
    const insert = calls.find((c) => /^INSERT INTO sessions/.test(c.sql))!;
    const heal = calls.find((c) => /UPDATE sessions SET state = 'ended'/.test(c.sql))!;
    expect(heal.params[1]).toBe('error');
    expect(heal.params[2]).toBe(insert.params[0]); // the id that was just inserted
  });

  it('POST /sessions/start heals a stale row and starts fresh instead of rejoining a dead session', async () => {
    const { env, created } = makeEnv({
      d1: (c) => {
        if (/FROM sessions\s+WHERE user_id = \? AND state IN/.test(c.sql) && c.kind === 'first') return { id: 'old-session', lab_slug: 'lab-a', lab_version: '1.0.0' };
      },
      stubs: { 'old-session': { status: async () => ({ meta: { state: 'ended', ended_at: 1, end_reason: 'expired' } }) } },
    });
    const res = await call(env, 'POST', '/sessions/start', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE });
    expect(res.status).toBe(202);
    expect(created).toHaveLength(1);
  });
});

describe('hourly sweeper (B-18)', () => {
  it('heals stale rows whose DO ended or is gone and leaves live ones', async () => {
    const now = 10 * 3_600_000;
    const { env, calls } = makeEnv({
      d1: (c) => {
        if (/^SELECT id FROM sessions/.test(c.sql)) return [{ id: 'gone' }, { id: 'ended' }, { id: 'live' }];
      },
      stubs: {
        ended: { status: async () => ({ meta: { state: 'ended', ended_at: 9, end_reason: 'idle' } }) },
        live: { status: async () => ({ meta: { state: 'running' } }) },
      },
    });

    expect(await sweepStaleSessions(env, now)).toEqual({ checked: 3, healed: 2 });

    const select = calls.find((c) => /^SELECT id FROM sessions/.test(c.sql))!;
    // Every active state past three hours, and the boot states past ten minutes.
    expect(select.sql).toContain("state IN ('starting','ready','running','recovering','resuming')");
    expect(select.sql).toContain("state IN ('starting','resuming','recovering')");
    expect(select.params[0]).toBe(now - 3 * 3_600_000);
    expect(select.params[1]).toBe(now - 10 * 60_000);
    expect(calls.filter((c) => /UPDATE sessions SET state = 'ended'/.test(c.sql)).map((c) => c.params.at(-1))).toEqual(['gone', 'ended']);
  });
});

describe('admission control on POST /sessions (B-19)', () => {
  it('a refusal is a 503 at_capacity with Retry-After, before any D1 write', async () => {
    pool.admit.mockRejectedValue(new ApiError(503, 'at_capacity', 'full', { retry_after_s: 42 }));
    const { env, calls } = makeEnv();
    const res = await call(env, 'POST', '/sessions', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('42');
    const body = (await res.json()) as { error: { code: string; details: { retry_after_s: number } } };
    expect(body.error.code).toBe('at_capacity');
    expect(body.error.details.retry_after_s).toBe(42);
    expect(calls).toHaveLength(0);
  });

  it('the retry hint survives the Durable Object RPC boundary, which keeps only name and message', async () => {
    const flattened = Object.assign(new Error('No capacity to start a session right now; retry_after_s=17'), { name: 'ApiError:503:at_capacity' });
    pool.admit.mockRejectedValue(flattened);
    const { env } = makeEnv();
    const res = await call(env, 'POST', '/sessions/start', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('17');
  });

  it('an admitted request goes on to insert and create', async () => {
    const { env, calls } = makeEnv();
    const res = await call(env, 'POST', '/sessions', { body: { lab: 'lab-a', user_id: 'u1' }, headers: SERVICE });
    expect(res.status).toBe(202);
    expect(pool.admit).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => /^INSERT INTO sessions/.test(c.sql))).toBe(true);
  });
});

describe('feedback route (B-16)', () => {
  const stubs = { s1: { status: async () => ({ meta: { user_id: 'u1', lab_slug: 'lab-a' } }) } };

  it('rating 6 is a 400 bad_feedback and touches nothing', async () => {
    const { env, calls } = makeEnv({ stubs });
    const res = await call(env, 'POST', '/sessions/s1/feedback', { body: { rating: 6 }, headers: await sessionAuth(env) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_feedback');
    expect(calls).toHaveLength(0);
  });

  it('a 2001-character text is a 400', async () => {
    const { env } = makeEnv({ stubs });
    const res = await call(env, 'POST', '/sessions/s1/feedback', { body: { rating: 5, text: 'x'.repeat(2001) }, headers: await sessionAuth(env) });
    expect(res.status).toBe(400);
  });

  it('a malformed body is a 400', async () => {
    const { env } = makeEnv({ stubs });
    const res = await app.fetch(
      new Request('https://api.test/sessions/s1/feedback', { method: 'POST', body: '{nope', headers: await sessionAuth(env) }),
      env
    );
    expect(res.status).toBe(400);
  });

  it('a valid body upserts by session with user and lab from meta and answers 201', async () => {
    const { env, calls } = makeEnv({ stubs });
    const res = await call(env, 'POST', '/sessions/s1/feedback', { body: { rating: 4, text: 'good' }, headers: await sessionAuth(env) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    const upsert = calls[0]!;
    expect(upsert.sql).toContain('ON CONFLICT(session_id) DO UPDATE');
    expect(upsert.params.slice(1, 6)).toEqual(['s1', 'u1', 'lab-a', 4, 'good']);
  });

  it('needs a token for that session', async () => {
    const { env } = makeEnv({ stubs });
    expect((await call(env, 'POST', '/sessions/s1/feedback', { body: { rating: 4 } })).status).toBe(401);
    expect((await call(env, 'POST', '/sessions/s1/feedback', { body: { rating: 4 }, headers: await sessionAuth(env, 'other') })).status).toBe(401);
  });
});

describe('progress and history routes (B-14)', () => {
  it('GET /users/:uid/progress aggregates from check_runs for that user', async () => {
    const { env, calls } = makeEnv({ d1: () => [{ slug: 'lab-a', attempts: 2, best_score: 1, passed_all: 1, last_run_at: 7, sessions: 1 }] });
    const res = await call(env, 'GET', '/users/u1/progress', { headers: SERVICE });
    expect(await res.json()).toEqual({ labs: [{ slug: 'lab-a', attempts: 2, best_score: 1, passed_all: true, last_run_at: 7, sessions: 1 }], plan: 'free' });
    expect(calls[0]!.params).toEqual(['u1']);
  });

  it('GET /users/:uid/progress carries the plan: free without a row, pro for a paid user', async () => {
    const plan = (row: unknown) =>
      makeEnv({ d1: (c) => (/FROM users WHERE id/.test(c.sql) ? row : /FROM check_runs/.test(c.sql) ? [] : undefined) });
    const free = plan(undefined);
    expect(await (await call(free.env, 'GET', '/users/u1/progress', { headers: SERVICE })).json()).toEqual({ labs: [], plan: 'free' });
    const pro = plan({ plan: 'pro' });
    expect(await (await call(pro.env, 'GET', '/users/u1/progress', { headers: SERVICE })).json()).toEqual({ labs: [], plan: 'pro' });
  });

  it('service routes refuse a session token', async () => {
    const { env } = makeEnv();
    expect((await call(env, 'GET', '/users/u1/progress', { headers: await sessionAuth(env) })).status).toBe(401);
    expect((await call(env, 'GET', '/users/u1/checks')).status).toBe(401);
  });

  it('GET /users/:uid/checks passes lab, limit and before through', async () => {
    const { env, calls } = makeEnv();
    const res = await call(env, 'GET', '/users/u1/checks?lab=lab-a&limit=5&before=900', { headers: SERVICE });
    expect(await res.json()).toEqual({ runs: [] });
    expect(calls[0]!.params).toEqual(['u1', 'lab-a', 900, 5]);
    expect((await call(env, 'GET', '/users/u1/checks?before=abc', { headers: SERVICE })).status).toBe(400);
  });

  it('GET /sessions/:id/checks?limit= returns parsed runs for that session', async () => {
    const row = { id: 'r1', started_at: 1, finished_at: 2, passed: 1, total: 1, score: 1, results_json: '[{"name":"c1","pass":true}]' };
    const { env, calls } = makeEnv({ d1: () => [row] });
    const res = await call(env, 'GET', '/sessions/s1/checks?limit=3', { headers: await sessionAuth(env) });
    expect(await res.json()).toEqual({
      runs: [{ run_id: 'r1', started_at: 1, finished_at: 2, passed: 1, total: 1, score: 1, results: [{ name: 'c1', pass: true }] }],
    });
    expect(calls[0]!.params).toEqual(['s1', 3]);
  });

  it('GET /sessions/:id/progress-summary uses the session\'s user and lab and adds attempts_this_session', async () => {
    const { env, calls } = makeEnv({
      d1: () => ({ attempts: 2, best_score: 0.5, passed_all: 0, last_run_at: 9, sessions: 1, attempts_this_session: 2 }),
      stubs: { s1: { status: async () => ({ meta: { user_id: 'u1', lab_slug: 'lab-a' } }) } },
    });
    const res = await call(env, 'GET', '/sessions/s1/progress-summary', { headers: await sessionAuth(env) });
    expect(await res.json()).toEqual({
      slug: 'lab-a', attempts: 2, best_score: 0.5, passed_all: false, last_run_at: 9, sessions: 1, attempts_this_session: 2,
    });
    expect(calls[0]!.params).toEqual(['s1', 'u1', 'lab-a']);
  });
});

describe('plan tier at lab start', () => {
  const plan = (p: string | null) => (c: D1Call) => (/FROM users WHERE id/.test(c.sql) ? (p ? { plan: p } : null) : undefined);
  const start = (env: Env, body: Record<string, unknown>, path = '/sessions/start') =>
    call(env, 'POST', path, { body: { lab: 'lab-a', user_id: 'u1', ...body }, headers: SERVICE });

  it('a free user cannot start a pro lab: 403 plan_required, nothing reserved', async () => {
    tierOf.value = 'pro';
    const { env, calls } = makeEnv({ d1: plan(null) });
    const res = await start(env, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('plan_required');
    expect(calls.some((c) => /^INSERT INTO sessions/.test(c.sql))).toBe(false);
    expect((await start(env, {}, '/sessions/prepare')).status).toBe(403);
  });

  it('a paid user starts a pro lab', async () => {
    tierOf.value = 'pro';
    const { env } = makeEnv({ d1: plan('pro') });
    expect((await start(env, {})).status).toBe(202);
  });

  it('a free user starts a free lab', async () => {
    tierOf.value = 'free';
    const { env } = makeEnv({ d1: plan(null) });
    expect((await start(env, {})).status).toBe(202);
  });

  it('bypass_tier (the console vouching for its admin) starts a pro lab for a free user; the operator create route needs no flag', async () => {
    tierOf.value = 'pro';
    const { env } = makeEnv({ d1: plan(null) });
    expect((await start(env, { bypass_tier: true })).status).toBe(202);
    expect((await start(env, { user_id: 'u2' }, '/sessions')).status).toBe(202);
    tierOf.value = 'free';
  });
});
