import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { Env } from '../../src/env';
import { mountAdmin } from '../../src/admin';
import { mintSessionToken } from '../../src/auth';
import { ApiError, fromSdkError } from '../../src/lib/errors';
import { createFakeD1 } from '../fakes/fake-d1';

/**
 * The admin D1 routes, run against a real SQLite (node:sqlite) built from the
 * repo's own migration files, so the SQL itself is exercised: ordering,
 * cursors, filters, aggregates and joins are answered by an engine, not by a
 * hand-written stand-in. The engine is the same one D1 runs.
 */

// `node:sqlite` is prefix-only; a require() sidesteps the bundler's resolver.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown };
  };
};

const MIGRATIONS = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();

/** A D1-shaped wrapper over one in-memory SQLite database. */
function sqliteD1(skip: string[] = []) {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of MIGRATIONS) {
    if (skip.some((s) => file.includes(s))) continue;
    sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }
  const bound = (sql: string, params: unknown[]) => ({
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => {
      sqlite.prepare(sql).run(...params);
      return { meta: { changes: 1 } };
    },
  });
  const db = { prepare: (sql: string) => ({ ...bound(sql, []), bind: (...p: unknown[]) => bound(sql, p) }) };
  return { db: db as unknown as Env['DB'], sqlite };
}

const KEY = { Authorization: 'Bearer svc-key' };

function makeApp(db: Env['DB']) {
  const app = new Hono<{ Bindings: Env }>();
  // The router's own mapping, so a thrown ApiError reads as it does in production.
  app.onError((err) => (err instanceof ApiError ? err : fromSdkError(err)).toResponse());
  mountAdmin(app);
  const env = { SANDBOX_API_KEY: 'svc-key', SESSION_TOKEN_SECRET: 'secret', DB: db } as unknown as Env;
  const get = async (path: string, headers: Record<string, string> = KEY) => {
    const res = await app.fetch(new Request(`https://api.test${path}`, { headers }), env);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { app, env, get };
}

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 8, 1); // 1 Sep 2026 00:00 UTC

interface S {
  id: string;
  user: string;
  lab: string;
  state?: string;
  at: number;
  cost?: number | null;
  llm?: number | null;
  run?: number | null;
  done?: number | null;
  hints?: number | null;
}

function seedSessions(sqlite: ReturnType<typeof sqliteD1>['sqlite'], rows: S[]) {
  const insert = sqlite.prepare(
    `INSERT INTO sessions (id, user_id, lab_slug, lab_version, family, state, created_at, cost_usd, llm_usd, running_s, completed_at, hints_delivered)
     VALUES (?, ?, ?, '1.0.0', 'agent', ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of rows) {
    insert.run(r.id, r.user, r.lab, r.state ?? 'ended', r.at, r.cost ?? null, r.llm ?? null, r.run ?? null, r.done ?? null, r.hints ?? null);
  }
}

describe('GET /admin/sessions', () => {
  // s1..s6 across two users and two labs; ids chosen so ties are deterministic.
  const rows: S[] = [
    { id: 's1', user: 'ann', lab: 'lab-a', at: T0 + 1 * H, cost: 0.1, llm: 0.01, run: 600, done: T0 + 2 * H, hints: 1 },
    { id: 's2', user: 'bob', lab: 'lab-b', at: T0 + 2 * H, cost: 0.2, run: 900, hints: 0 },
    { id: 's3', user: 'dee', lab: 'lab-b', at: T0 + 3 * H, state: 'running' },
    { id: 's4', user: 'cy', lab: 'lab-a', at: T0 + 4 * H, state: 'starting' },
    { id: 's5', user: 'bob', lab: 'lab-a', at: T0 + 5 * H, cost: 0.3, run: 300 },
    { id: 's6', user: 'eve', lab: 'lab-a', at: T0 + 6 * H, state: 'recovering' },
  ];
  const setup = () => {
    const { db, sqlite } = sqliteD1();
    seedSessions(sqlite, rows);
    return makeApp(db);
  };

  it('returns every state, newest first, with cost and completion columns', async () => {
    const { get } = setup();
    const { status, body } = await get('/admin/sessions');
    expect(status).toBe(200);
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(['s6', 's5', 's4', 's3', 's2', 's1']);
    expect(body.next).toBeUndefined();
    const s1 = body.sessions.at(-1);
    expect(s1).toMatchObject({
      id: 's1', user_id: 'ann', lab_slug: 'lab-a', state: 'ended', cost_usd: 0.1, llm_usd: 0.01, running_s: 600,
      completed_at: T0 + 2 * H, hints_delivered: 1,
    });
    // A live row has no cost yet; that is null, not zero.
    expect(body.sessions.find((s: { id: string }) => s.id === 's3')).toMatchObject({ cost_usd: null, running_s: null, completed_at: null });
  });

  it('pages with limit and a created_at cursor, and the last page has no next', async () => {
    const { get } = setup();
    const p1 = (await get('/admin/sessions?limit=2')).body;
    expect(p1.sessions.map((s: { id: string }) => s.id)).toEqual(['s6', 's5']);
    expect(p1.next).toBe(T0 + 5 * H);
    const p2 = (await get(`/admin/sessions?limit=2&before=${p1.next}`)).body;
    expect(p2.sessions.map((s: { id: string }) => s.id)).toEqual(['s4', 's3']);
    const p3 = (await get(`/admin/sessions?limit=2&before=${p2.next}`)).body;
    expect(p3.sessions.map((s: { id: string }) => s.id)).toEqual(['s2', 's1']);
    expect(p3.next).toBeUndefined();
  });

  it('exactly a full page does not invent a next page', async () => {
    const { get } = setup();
    const { body } = await get('/admin/sessions?limit=6');
    expect(body.sessions).toHaveLength(6);
    expect(body.next).toBeUndefined();
  });

  it('filters by state (one or several), lab and user, and they combine', async () => {
    const { get } = setup();
    const ids = (b: { sessions: Array<{ id: string }> }) => b.sessions.map((s) => s.id);
    expect(ids((await get('/admin/sessions?state=running')).body)).toEqual(['s3']);
    expect(ids((await get('/admin/sessions?state=running,starting')).body)).toEqual(['s4', 's3']);
    expect(ids((await get('/admin/sessions?lab=lab-b')).body)).toEqual(['s3', 's2']);
    expect(ids((await get('/admin/sessions?user=bob')).body)).toEqual(['s5', 's2']);
    expect(ids((await get('/admin/sessions?user=bob&lab=lab-a&state=ended')).body)).toEqual(['s5']);
    expect(ids((await get('/admin/sessions?user=nobody')).body)).toEqual([]);
  });

  it('a filter value is a bound parameter, never SQL', async () => {
    const fake = createFakeD1(() => []);
    const { get } = makeApp(fake.db);
    const evil = "x' OR '1'='1";
    await get(`/admin/sessions?lab=${encodeURIComponent(evil)}&user=${encodeURIComponent(evil)}`);
    const call = fake.calls[0]!;
    expect(call.sql).not.toContain("x'");
    expect(call.params).toEqual([Number.MAX_SAFE_INTEGER, evil, evil, 51]);
  });

  it('clamps the limit to 1-200 and treats a junk limit as the default', async () => {
    const fake = createFakeD1(() => []);
    const { get } = makeApp(fake.db);
    await get('/admin/sessions?limit=99999');
    await get('/admin/sessions?limit=0');
    await get('/admin/sessions?limit=abc');
    expect(fake.calls.map((c) => c.params.at(-1))).toEqual([201, 2, 51]);
  });

  it('rejects a malformed cursor and a malformed state with 400', async () => {
    const { get } = setup();
    expect((await get('/admin/sessions?before=abc')).body.error.code).toBe('bad_cursor');
    expect((await get('/admin/sessions?state=running;DROP')).body.error.code).toBe('bad_state');
    expect((await get('/admin/sessions?state=a,b,c,d,e,f,g,h,i')).status).toBe(400);
  });
});

describe('GET /admin/usage/summary', () => {
  const rows: S[] = [
    // 1 Sep: two sessions, one completed
    { id: 'a', user: 'ann', lab: 'lab-a', at: T0 + 1 * H, cost: 1, llm: 0.1, run: 100, done: T0 + 2 * H },
    { id: 'b', user: 'bob', lab: 'lab-b', at: T0 + 20 * H, cost: 3, llm: 0.3, run: 300 },
    // 3 Sep: one session, still running (no cost yet)
    { id: 'c', user: 'cy', lab: 'lab-a', at: T0 + 2 * D + 5 * H, state: 'running' },
    // 4 Sep: ended, completed
    { id: 'd', user: 'cy', lab: 'lab-c', at: T0 + 3 * D + 1 * H, cost: 0.5, llm: 0.05, run: 50, done: T0 + 3 * D + 2 * H },
    // outside the default and explicit windows below
    { id: 'old', user: 'ann', lab: 'lab-a', at: T0 - 90 * D, cost: 99, llm: 9, run: 9999 },
  ];
  const NOW = T0 + 10 * D;
  const setup = () => {
    const { db, sqlite } = sqliteD1();
    seedSessions(sqlite, rows);
    return makeApp(db);
  };
  const win = `from=${T0}&to=${T0 + 5 * D}`;

  it('totals, by_lab (by cost), by_day (oldest first) and completion for a window', async () => {
    const { get } = setup();
    const { status, body } = await get(`/admin/usage/summary?${win}`);
    expect(status).toBe(200);
    expect(body.from).toBe(T0);
    expect(body.to).toBe(T0 + 5 * D);
    expect(body.totals).toEqual({ sessions: 4, running_s: 450, cost_usd: 4.5, llm_usd: 0.45 });
    expect(body.by_lab).toEqual([
      { lab_slug: 'lab-b', sessions: 1, running_s: 300, cost_usd: 3, llm_usd: 0.3, completed: 0 },
      { lab_slug: 'lab-a', sessions: 2, running_s: 100, cost_usd: 1, llm_usd: 0.1, completed: 1 },
      { lab_slug: 'lab-c', sessions: 1, running_s: 50, cost_usd: 0.5, llm_usd: 0.05, completed: 1 },
    ]);
    expect(body.by_day).toEqual([
      { day: '2026-09-01', sessions: 2, cost_usd: 4 },
      { day: '2026-09-03', sessions: 1, cost_usd: 0 },
      { day: '2026-09-04', sessions: 1, cost_usd: 0.5 },
    ]);
    // 3 ended sessions in the window (a, b, d); 2 of them completed. The running one is not "ended".
    expect(body.completion).toEqual({ completed: 2, ended: 3, rate: 2 / 3 });
  });

  it('accepts ISO dates as well as epoch milliseconds', async () => {
    const { get } = setup();
    const { body } = await get('/admin/usage/summary?from=2026-09-01&to=2026-09-02T00:00:00Z');
    expect(body.from).toBe(T0);
    expect(body.to).toBe(T0 + D);
    expect(body.totals.sessions).toBe(2);
  });

  it('defaults to the last 30 days ending now', async () => {
    const { get } = setup();
    const before = Date.now();
    const { body } = await get('/admin/usage/summary');
    expect(body.to).toBeGreaterThanOrEqual(before);
    expect(body.to - body.from).toBe(30 * D);
    // Real rows are in September 2026 and "now" may be later or earlier than that: only the shape is fixed.
    expect(Object.keys(body).sort()).toEqual(['by_day', 'by_lab', 'completion', 'from', 'to', 'totals']);
    void NOW;
  });

  it('an empty window is zeros and a null completion rate, not an error', async () => {
    const { get } = setup();
    const { status, body } = await get(`/admin/usage/summary?from=${T0 + 100 * D}&to=${T0 + 101 * D}`);
    expect(status).toBe(200);
    expect(body.totals).toEqual({ sessions: 0, running_s: 0, cost_usd: 0, llm_usd: 0 });
    expect(body.by_lab).toEqual([]);
    expect(body.by_day).toEqual([]);
    expect(body.completion).toEqual({ completed: 0, ended: 0, rate: null });
  });

  it('caps by_lab at the top 20 by cost', async () => {
    const { db, sqlite } = sqliteD1();
    seedSessions(
      sqlite,
      Array.from({ length: 25 }, (_, i) => ({ id: `x${i}`, user: `u${i}`, lab: `lab-${String(i).padStart(2, '0')}`, at: T0 + H, cost: i + 1 }))
    );
    const { body } = await makeApp(db).get(`/admin/usage/summary?${win}`);
    expect(body.by_lab).toHaveLength(20);
    expect(body.by_lab[0].lab_slug).toBe('lab-24');
    expect(body.by_lab.at(-1).cost_usd).toBe(6);
    expect(body.totals.sessions).toBe(25); // the cap is on the list, not on the totals
  });

  it('rejects an unreadable or inverted window with 400', async () => {
    const { get } = setup();
    expect((await get('/admin/usage/summary?from=yesterday')).body.error.code).toBe('bad_window');
    expect((await get('/admin/usage/summary?from=-5')).status).toBe(400);
    expect((await get(`/admin/usage/summary?from=${T0 + D}&to=${T0}`)).body.error.code).toBe('bad_window');
  });
});

describe('GET /admin/users', () => {
  const setup = (dropUsers = false) => {
    const { db, sqlite } = sqliteD1();
    seedSessions(sqlite, [
      { id: '1', user: 'ann', lab: 'lab-a', at: T0 + 1 * H, cost: 1, done: T0 + 2 * H },
      { id: '2', user: 'ann', lab: 'lab-b', at: T0 + 9 * H, cost: 0.5 },
      { id: '3', user: 'bob', lab: 'lab-a', at: T0 + 5 * H, cost: 2, done: T0 + 6 * H },
      { id: '4', user: 'cy', lab: 'lab-a', at: T0 + 3 * H, state: 'running' },
    ]);
    sqlite.prepare(`INSERT INTO users (id, plan, created_at) VALUES ('ann', 'pro', 1)`).run();
    sqlite.prepare(`INSERT INTO users (id, plan, created_at) VALUES ('bob', 'free', 1)`).run();
    if (dropUsers) sqlite.exec('DROP TABLE users');
    return makeApp(db);
  };

  it('one row per user, most recently active first, with totals and plan when known', async () => {
    const { get } = setup();
    const { status, body } = await get('/admin/users');
    expect(status).toBe(200);
    expect(body.users).toEqual([
      { user_id: 'ann', sessions: 2, last_session_at: T0 + 9 * H, cost_usd: 1.5, completed: 1, plan: 'pro' },
      { user_id: 'bob', sessions: 1, last_session_at: T0 + 5 * H, cost_usd: 2, completed: 1, plan: 'free' },
      { user_id: 'cy', sessions: 1, last_session_at: T0 + 3 * H, cost_usd: 0, completed: 0, plan: null },
    ]);
    expect(body.next).toBeUndefined();
  });

  it('pages by last session time', async () => {
    const { get } = setup();
    const p1 = (await get('/admin/users?limit=2')).body;
    expect(p1.users.map((u: { user_id: string }) => u.user_id)).toEqual(['ann', 'bob']);
    expect(p1.next).toBe(T0 + 5 * H);
    const p2 = (await get(`/admin/users?limit=2&before=${p1.next}`)).body;
    expect(p2.users.map((u: { user_id: string }) => u.user_id)).toEqual(['cy']);
    expect(p2.next).toBeUndefined();
  });

  it('a deployment without the users table still lists users, with no plan', async () => {
    const { get } = setup(true);
    const { status, body } = await get('/admin/users');
    expect(status).toBe(200);
    expect(body.users.map((u: { user_id: string; plan: unknown }) => [u.user_id, u.plan])).toEqual([
      ['ann', null],
      ['bob', null],
      ['cy', null],
    ]);
  });

  it('a bad cursor is a 400', async () => {
    expect((await setup().get('/admin/users?before=x')).status).toBe(400);
  });
});

describe('GET /admin/waitlist', () => {
  const seed = (sqlite: ReturnType<typeof sqliteD1>['sqlite']) => {
    const ins = sqlite.prepare(`INSERT INTO waitlist (email, plan, role, country, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    ins.run('a@x.io', 'individual', 'developer', 'GB', 'hero', T0 + 1, T0 + 1);
    ins.run('b@x.io', 'team', null, 'US', 'pricing', T0 + 3, T0 + 9);
    ins.run('c@x.io', 'individual', 'lead', null, null, T0 + 2, T0 + 2);
  };

  it('lists signups newest first with every column', async () => {
    const { db, sqlite } = sqliteD1();
    seed(sqlite);
    const { status, body } = await makeApp(db).get('/admin/waitlist');
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.rows.map((r: { email: string }) => r.email)).toEqual(['b@x.io', 'c@x.io', 'a@x.io']);
    expect(body.rows[0]).toEqual({ email: 'b@x.io', plan: 'team', role: null, country: 'US', source: 'pricing', created_at: T0 + 3, updated_at: T0 + 9 });
    expect(body.next).toBeUndefined();
  });

  it('pages with a created_at cursor', async () => {
    const { db, sqlite } = sqliteD1();
    seed(sqlite);
    const { get } = makeApp(db);
    const p1 = (await get('/admin/waitlist?limit=2')).body;
    expect(p1.rows).toHaveLength(2);
    expect(p1.next).toBe(T0 + 2);
    const p2 = (await get(`/admin/waitlist?limit=2&before=${p1.next}`)).body;
    expect(p2.rows.map((r: { email: string }) => r.email)).toEqual(['a@x.io']);
    expect(p2.next).toBeUndefined();
  });

  it('a missing table is { available: false, rows: [] }, not a 500', async () => {
    const { db } = sqliteD1(['0004']);
    const { status, body } = await makeApp(db).get('/admin/waitlist');
    expect(status).toBe(200);
    expect(body).toEqual({ available: false, rows: [] });
  });

  it("recognises D1's own wording of a missing table", async () => {
    const fake = createFakeD1(() => {
      throw new Error('D1_ERROR: no such table: waitlist: SQLITE_ERROR');
    });
    expect((await makeApp(fake.db).get('/admin/waitlist')).body).toEqual({ available: false, rows: [] });
  });

  it('any other D1 failure is still a 500 (an outage is not "not available")', async () => {
    const fake = createFakeD1(() => {
      throw new Error('D1_ERROR: database is locked');
    });
    expect((await makeApp(fake.db).get('/admin/waitlist')).status).toBe(500);
  });
});

describe('GET /admin/feedback', () => {
  const seed = (sqlite: ReturnType<typeof sqliteD1>['sqlite'], opts: { lab?: boolean; site?: boolean } = {}) => {
    if (opts.lab !== false) {
      const ins = sqlite.prepare(`INSERT INTO feedback (id, session_id, user_id, lab_slug, rating, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      ins.run('f1', 's1', 'ann', 'lab-a', 5, 'great', T0 + 10);
      ins.run('f2', 's2', 'bob', 'lab-b', 2, null, T0 + 30);
    }
    if (opts.site !== false) {
      const ins = sqlite.prepare(`INSERT INTO feedback_site (id, rating, message, email, country, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      ins.run('g1', 4, 'nice site', 'z@x.io', 'GB', 'footer', T0 + 20);
      ins.run('g2', null, 'a message', null, null, null, T0 + 40);
    }
  };

  it('merges lab and site feedback newest first, each tagged with its source', async () => {
    const { db, sqlite } = sqliteD1();
    seed(sqlite);
    const { status, body } = await makeApp(db).get('/admin/feedback');
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.rows.map((r: { id: string; source: string }) => `${r.source}:${r.id}`)).toEqual(['site:g2', 'lab:f2', 'site:g1', 'lab:f1']);
    expect(body.rows[3]).toMatchObject({ source: 'lab', rating: 5, message: 'great', lab_slug: 'lab-a', user_id: 'ann', session_id: 's1', email: null });
    // The site table's own `source` column is surfaced as `origin`, so it cannot be mistaken for the row's source.
    expect(body.rows[2]).toMatchObject({ source: 'site', rating: 4, message: 'nice site', email: 'z@x.io', country: 'GB', origin: 'footer', lab_slug: null });
  });

  it('pages across both tables with one cursor', async () => {
    const { db, sqlite } = sqliteD1();
    seed(sqlite);
    const { get } = makeApp(db);
    const p1 = (await get('/admin/feedback?limit=3')).body;
    expect(p1.rows.map((r: { id: string }) => r.id)).toEqual(['g2', 'f2', 'g1']);
    expect(p1.next).toBe(T0 + 20);
    const p2 = (await get(`/admin/feedback?limit=3&before=${p1.next}`)).body;
    expect(p2.rows.map((r: { id: string }) => r.id)).toEqual(['f1']);
    expect(p2.next).toBeUndefined();
  });

  it('shows the source that exists when the other table is missing', async () => {
    const { db, sqlite } = sqliteD1(['0006']);
    seed(sqlite, { site: false });
    const { body } = await makeApp(db).get('/admin/feedback');
    expect(body.available).toBe(true);
    expect(body.missing).toEqual(['feedback_site']);
    expect(body.rows.map((r: { id: string }) => r.id)).toEqual(['f2', 'f1']);
  });

  it('both tables missing is { available: false, rows: [] }', async () => {
    const { db } = sqliteD1(['0006', '0007']);
    const { status, body } = await makeApp(db).get('/admin/feedback');
    expect(status).toBe(200);
    expect(body).toEqual({ available: false, rows: [] });
  });

  it('empty tables are available with no rows', async () => {
    const { db } = sqliteD1();
    expect((await makeApp(db).get('/admin/feedback')).body).toEqual({ available: true, rows: [] });
  });
});

describe('service key only', () => {
  const PATHS: Array<[string, string]> = [
    ['GET', '/admin/sessions'],
    ['GET', '/admin/usage/summary'],
    ['GET', '/admin/users'],
    ['GET', '/admin/waitlist'],
    ['GET', '/admin/feedback'],
    ['GET', '/labs/some-lab/versions'],
    ['POST', '/labs/some-lab/promote'],
  ];

  it.each(PATHS)('%s %s is 401 with no key, a wrong key, and a session token', async (method, path) => {
    const fake = createFakeD1(() => []);
    const { app, env } = makeApp(fake.db);
    const token = await mintSessionToken(env, { sid: 's1', uid: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const attempts: Array<Record<string, string>> = [{}, { Authorization: 'Bearer nope' }, { Authorization: `Bearer ${token}` }];
    for (const headers of attempts) {
      const res = await app.fetch(new Request(`https://api.test${path}`, { method, headers, body: method === 'POST' ? '{"version":"1.0.0"}' : undefined }), env);
      expect(res.status, `${method} ${path} with ${JSON.stringify(headers)}`).toBe(401);
    }
    expect(fake.calls, 'nothing touched D1 before auth').toHaveLength(0);
  });

  it('the previous key is accepted during a rotation, like every other service route', async () => {
    const fake = createFakeD1(() => []);
    const { app, env } = makeApp(fake.db);
    const rotating = { ...env, SANDBOX_API_KEY_PREVIOUS: 'old-key' } as Env;
    const res = await app.fetch(new Request('https://api.test/admin/users', { headers: { Authorization: 'Bearer old-key' } }), rotating);
    expect(res.status).toBe(200);
  });

  it('every route registered in src/admin.ts calls requireServiceAuth (source-level, like the auth matrix)', () => {
    const src = readFileSync('src/admin.ts', 'utf8');
    const registrations = [...src.matchAll(/\n {2}app\.(get|post)\('([^']+)'/g)];
    expect(registrations.map((m) => `${m[1]} ${m[2]}`)).toEqual([
      'get /admin/sessions',
      'get /admin/usage/summary',
      'get /admin/users',
      'get /admin/waitlist',
      'get /admin/feedback',
      'get /labs/:slug/versions',
      'post /labs/:slug/promote',
    ]);
    for (const [i, m] of registrations.entries()) {
      const body = src.slice(m.index!, registrations[i + 1]?.index ?? src.indexOf('\n}\n', m.index!));
      expect(body, `${m[1]} ${m[2]}`).toContain('requireServiceAuth(');
      expect(body, `${m[1]} ${m[2]}`).not.toContain('requireBrowserAuth(');
    }
  });
});
