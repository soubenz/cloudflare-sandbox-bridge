import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../src/env';
import { SessionRuntime } from '../../src/session/state';
import type { SessionMeta } from '../../src/session/state';
import { parseManifest } from '../../src/labs/manifest';
import { INDEX_KEY } from '../../src/labs/bundle';
import { buildFacts, recomputeAwards, insertAwards, loadProfile, syncSessionHints } from '../../src/profile/store';
import { parseUserId, parseStartingLevels } from '../../src/profile/request';
import { announceNewAwards } from '../../src/profile/notify';
import { createFakeStorage } from '../fakes/fake-storage';
import { createFakeD1 } from '../fakes/fake-d1';
import { FakeBackend, FakeProcess } from '../fakes/fake-backend';
import { sqliteD1, type Sqlite } from './sqlite-d1';
import { NOW, DAY, MIN } from './profile-helpers';

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

const { createRouter } = await import('../../src/router');

interface IndexEntry {
  slug: string;
  title: string;
  path?: string;
  module?: number;
  order?: number;
  difficulty?: string;
  estimated_minutes?: number;
  archived?: true;
}

const CATALOGUE: IndexEntry[] = [
  { slug: 'lab-a', title: 'Lab A', path: 'ai-platform', module: 1, order: 1, difficulty: 'core', estimated_minutes: 30 },
  { slug: 'lab-b', title: 'Lab B', path: 'ai-platform', module: 1, order: 2, difficulty: 'intro' },
  { slug: 'lab-c', title: 'Lab C', path: 'ai-platform', module: 2, order: 1, difficulty: 'advanced' },
];

function makeEnv(catalogue: IndexEntry[] = CATALOGUE, db?: Env['DB']) {
  const sql = sqliteD1();
  const env = {
    SANDBOX_API_KEY: 'svc-key',
    SESSION_TOKEN_SECRET: 's',
    DB: db ?? sql.db,
    LABS_BUCKET: {
      get: async (key: string) => (key === INDEX_KEY ? { json: async () => catalogue } : { body: new Uint8Array() }),
    },
  } as unknown as Env;
  return { env, sqlite: sql.sqlite };
}

let n = 0;
/** Seeds a session row and its check runs (each `[score, offsetMs]`) straight into SQLite. */
function seed(sqlite: Sqlite, o: { user?: string; session: string; lab: string; startedAt: number; hints?: number | null; runs: Array<[number, number]> }) {
  const user = o.user ?? 'u1';
  sqlite
    .prepare(`INSERT INTO sessions (id, user_id, lab_slug, lab_version, family, state, created_at, started_at, hints_delivered) VALUES (?, ?, ?, '1.0.0', 'agent', 'ended', ?, ?, ?)`)
    .run(o.session, user, o.lab, o.startedAt, o.startedAt, o.hints ?? null);
  for (const [score, offset] of o.runs) {
    const t = o.startedAt + offset;
    sqlite
      .prepare(`INSERT INTO check_runs (id, session_id, started_at, finished_at, passed, total, results_json, user_id, lab_slug, lab_version, score, passed_all) VALUES (?, ?, ?, ?, 0, 0, '[]', ?, ?, '1.0.0', ?, ?)`)
      .run(`run-${++n}`, o.session, t, t + 1000, user, o.lab, score, score === 1 ? 1 : 0);
  }
}

const awardRows = (sqlite: Sqlite, user = 'u1') =>
  sqlite.prepare('SELECT award_id, earned_at, session_id FROM awards WHERE user_id = ? ORDER BY award_id').all(user) as Array<{ award_id: string; earned_at: number; session_id: string | null }>;

describe('migration 0009', () => {
  it('creates awards with (user_id, award_id) as the primary key', () => {
    const { sqlite } = makeEnv();
    const info = sqlite.prepare(`PRAGMA table_info(awards)`).all() as Array<{ name: string; pk: number; notnull: number }>;
    expect(info.map((c) => c.name)).toEqual(['user_id', 'award_id', 'earned_at', 'session_id']);
    expect(info.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['user_id', 'award_id']);
    sqlite.prepare(`INSERT INTO awards VALUES ('u', 'a', 1, NULL)`).run();
    expect(() => sqlite.prepare(`INSERT INTO awards VALUES ('u', 'a', 2, NULL)`).run()).toThrow(/UNIQUE|PRIMARY/i);
  });
});

describe('buildFacts', () => {
  it('reads only this user\'s runs, their sessions\' hints and their stored awards', async () => {
    const { env, sqlite } = makeEnv();
    seed(sqlite, { session: 's1', lab: 'lab-a', startedAt: NOW - DAY, hints: 2, runs: [[0.5, MIN], [1, 2 * MIN]] });
    seed(sqlite, { user: 'other', session: 's2', lab: 'lab-a', startedAt: NOW - DAY, runs: [[1, MIN]] });
    sqlite.prepare(`INSERT INTO awards VALUES ('u1', 'first-lab', 77, 's1'), ('other', 'first-lab', 88, 's2')`).run();

    const f = await buildFacts(env, 'u1', NOW);
    expect(f.runs.map((r) => [r.session_id, r.score, r.passed_all])).toEqual([['s1', 1, true], ['s1', 0.5, false]]);
    expect(f.sessions).toEqual([{ id: 's1', lab_slug: 'lab-a', created_at: NOW - DAY, started_at: NOW - DAY, hints_delivered: 2 }]);
    expect(f.earned).toEqual([{ award_id: 'first-lab', earned_at: 77, session_id: 's1' }]);
    expect(f.now).toBe(NOW);
  });

  it('treats NULL score, passed_all and hints (rows from before the product migration) as zero', async () => {
    const { env, sqlite } = makeEnv();
    seed(sqlite, { session: 's1', lab: 'lab-a', startedAt: NOW - DAY, hints: null, runs: [] });
    sqlite.prepare(`INSERT INTO check_runs (id, session_id, started_at, passed, total, user_id, lab_slug) VALUES ('old', 's1', ?, 1, 1, 'u1', 'lab-a')`).run(NOW - DAY);
    const f = await buildFacts(env, 'u1', NOW);
    expect(f.runs[0]).toMatchObject({ score: 0, passed_all: false });
    expect(f.sessions[0]!.hints_delivered).toBe(0);
  });

  it('is empty for an unknown user', async () => {
    const { env } = makeEnv();
    expect(await buildFacts(env, 'nobody', NOW)).toEqual({ user_id: 'nobody', now: NOW, runs: [], sessions: [], earned: [] });
  });
});

describe('recomputeAwards', () => {
  it('stores the awards a learner has earned and returns them', async () => {
    const { env, sqlite } = makeEnv();
    seed(sqlite, { session: 's1', lab: 'lab-a', startedAt: NOW - DAY, hints: 0, runs: [[1, 10 * MIN]] });
    const added = await recomputeAwards(env, 'u1', { sessionId: 's1', now: NOW });
    // Two thirds of the gateway area's weight is done, which is a score of 67.
    expect(added.map((a) => a.id).sort()).toEqual(['area-proficient-gateway', 'first-lab', 'first-try-pass', 'no-hints-finish', 'speed-run']);
    expect(awardRows(sqlite).map((r) => [r.award_id, r.session_id])).toEqual([
      ['area-proficient-gateway', 's1'],
      ['first-lab', 's1'],
      ['first-try-pass', 's1'],
      ['no-hints-finish', 's1'],
      ['speed-run', 's1'],
    ]);
  });

  it('is idempotent: a second recompute inserts nothing and never moves earned_at', async () => {
    const { env, sqlite } = makeEnv();
    seed(sqlite, { session: 's1', lab: 'lab-a', startedAt: NOW - DAY, hints: 0, runs: [[1, 10 * MIN]] });
    await recomputeAwards(env, 'u1', { sessionId: 's1', now: NOW });
    const before = awardRows(sqlite);
    expect(await recomputeAwards(env, 'u1', { sessionId: 's2', now: NOW + 5 * DAY })).toEqual([]);
    expect(await recomputeAwards(env, 'u1', { now: NOW + 9 * DAY })).toEqual([]);
    expect(awardRows(sqlite)).toEqual(before);
  });

  it('only announces what is new when more activity arrives', async () => {
    const { env, sqlite } = makeEnv();
    seed(sqlite, { session: 's1', lab: 'lab-a', startedAt: NOW - 3 * DAY, hints: 0, runs: [[1, 10 * MIN]] });
    await recomputeAwards(env, 'u1', { now: NOW });
    seed(sqlite, { session: 's2', lab: 'lab-b', startedAt: NOW - 2 * DAY, hints: 0, runs: [[1, 10 * MIN]] });
    const second = await recomputeAwards(env, 'u1', { sessionId: 's2', now: NOW });
    expect(second.map((a) => a.id).sort()).toEqual(['area-expert-gateway', 'module-complete-ai-platform-1']);
    seed(sqlite, { session: 's3', lab: 'lab-c', startedAt: NOW - 1 * DAY, hints: 0, runs: [[1, 10 * MIN]] });
    const third = await recomputeAwards(env, 'u1', { sessionId: 's3', now: NOW });
    expect(third.map((a) => a.id).sort()).toEqual([
      'area-expert-mcp', 'area-proficient-mcp', 'module-complete-ai-platform-2', 'path-complete-ai-platform', 'streak-3-days', 'three-labs',
    ]);
    expect(awardRows(sqlite).find((r) => r.award_id === 'first-lab')!.session_id).toBeNull();
  });

  it('writes nothing for a learner with no runs', async () => {
    const { env, sqlite } = makeEnv();
    expect(await recomputeAwards(env, 'nobody', { now: NOW })).toEqual([]);
    expect(awardRows(sqlite, 'nobody')).toEqual([]);
  });

  it('a recompute that loses the race (the row is already there) announces nothing', async () => {
    const lost = createFakeD1((c) => (/^INSERT INTO awards/.test(c.sql) ? { meta: { changes: 0 } } : undefined));
    const out = await insertAwards({ DB: lost.db } as unknown as Env, 'u1', [{ id: 'first-lab', title: 't', description: 'd', icon: 'flag', tier: 'bronze', earned_at: 1, session_id: null }], 's1');
    expect(out).toEqual([]);
    expect(lost.calls[0]!.sql).toMatch(/ON CONFLICT\(user_id, award_id\) DO NOTHING/);
  });

  it('the insert never updates, so a stored earned_at cannot change', () => {
    const lost = createFakeD1();
    void insertAwards({ DB: lost.db } as unknown as Env, 'u1', [{ id: 'x', title: 't', description: 'd', icon: 'flag', tier: 'bronze', earned_at: 1, session_id: null }], null);
    return Promise.resolve().then(() => {
      for (const c of lost.calls) expect(c.sql).not.toMatch(/UPDATE|DO UPDATE|REPLACE/i);
    });
  });

  it('propagates a D1 failure, for the caller that must not fail to catch', async () => {
    const broken = createFakeD1(() => {
      throw new Error('d1 down');
    });
    await expect(recomputeAwards({ DB: broken.db, LABS_BUCKET: { get: async () => null } } as unknown as Env, 'u1')).rejects.toThrow('d1 down');
  });
});

describe('syncSessionHints', () => {
  it('only raises the stored count', async () => {
    const { env, sqlite } = makeEnv();
    seed(sqlite, { session: 's1', lab: 'lab-a', startedAt: NOW, hints: null, runs: [] });
    const read = () => (sqlite.prepare(`SELECT hints_delivered AS h FROM sessions WHERE id = 's1'`).get() as { h: number | null }).h;
    await syncSessionHints(env, 's1', 2);
    expect(read()).toBe(2);
    await syncSessionHints(env, 's1', 1);
    expect(read()).toBe(2);
    await syncSessionHints(env, 's1', 3);
    expect(read()).toBe(3);
  });
});

describe('loadProfile', () => {
  it('computes the profile from D1 and backfills the awards it shows, keeping earned_at stable across reads', async () => {
    const { env, sqlite } = makeEnv();
    seed(sqlite, { session: 's1', lab: 'lab-a', startedAt: NOW - DAY, hints: 1, runs: [[1, 10 * MIN]] });
    const first = await loadProfile(env, 'u1', { now: NOW });
    expect(first.xp).toBe(100 + 25); // core, first try, one hint
    expect(first.awards.earned.map((a) => a.id)).toContain('first-lab');
    const stored = awardRows(sqlite);
    expect(stored.map((r) => r.award_id)).toContain('first-lab');
    const later = await loadProfile(env, 'u1', { now: NOW + 3 * DAY });
    expect(later.awards.earned.find((a) => a.id === 'first-lab')!.earned_at).toBe(first.awards.earned.find((a) => a.id === 'first-lab')!.earned_at);
    expect(awardRows(sqlite)).toEqual(stored);
  });

  it('still returns the profile when storing the backfill fails', async () => {
    const { db } = sqliteD1();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = db.prepare.bind(db);
    const failing = { ...db, prepare: (sql: string) => (/^INSERT INTO awards/.test(sql) ? { bind: () => ({ run: async () => { throw new Error('d1 down'); } }) } : real(sql)) } as unknown as Env['DB'];
    const { env, sqlite } = makeEnv(CATALOGUE, failing);
    void sqlite;
    const p = await loadProfile(env, 'u1', { now: NOW });
    expect(p.user_id).toBe('u1');
    error.mockRestore();
  });

  it('is a well-formed empty profile for a learner with no activity and for an empty catalogue', async () => {
    const { env } = makeEnv([]);
    const p = await loadProfile(env, 'new-user', { now: NOW });
    expect(p).toMatchObject({ user_id: 'new-user', xp: 0, level: { n: 1, title: 'Newcomer' }, overall: { score: 0, level: 'Not started' }, updated_at: NOW });
    expect(p.skills).toHaveLength(6);
  });
});

describe('request parsing', () => {
  it('parseUserId accepts ordinary ids and rejects empty, control-character and oversized ones with bad_user_id', () => {
    expect(parseUserId('user_123')).toBe('user_123');
    expect(parseUserId('a@b.co')).toBe('a@b.co');
    for (const bad of [undefined, '', 'a\nb', 'a\u0000b', 'x'.repeat(129)]) {
      expect(() => parseUserId(bad), String(bad)).toThrowError(expect.objectContaining({ status: 400, code: 'bad_user_id' }));
    }
  });

  it('parseStartingLevels keeps valid pairs and ignores the rest', () => {
    expect(parseStartingLevels('gateway:ok,mcp:new,rag:strong')).toEqual({ gateway: 'ok', mcp: 'new', rag: 'strong' });
    expect(parseStartingLevels('gateway:ok,nope:ok,mcp:huge,rag')).toEqual({ gateway: 'ok' });
    expect(parseStartingLevels('')).toBeUndefined();
    expect(parseStartingLevels(undefined)).toBeUndefined();
    expect(parseStartingLevels('junk')).toBeUndefined();
  });
});

describe('profile routes', () => {
  const app = createRouter();
  const KEY = { Authorization: 'Bearer svc-key' };
  const get = (env: Env, path: string, headers: Record<string, string> = KEY) => app.fetch(new Request(`https://api.test${path}`, { headers }), env);

  it('GET /users/:uid/profile returns the documented shape', async () => {
    const { env, sqlite } = makeEnv();
    seed(sqlite, { session: 's1', lab: 'lab-a', startedAt: NOW - 60 * MIN, hints: 0, runs: [[1, 5 * MIN]] });
    const res = await get(env, '/users/u1/profile');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['awards', 'level', 'overall', 'skills', 'streak', 'updated_at', 'user_id', 'xp']);
    expect(body.user_id).toBe('u1');
    expect(body.xp).toBe(150);
    expect((body.skills as unknown[]).length).toBe(6);
    const awards = body.awards as { earned: Array<{ id: string }>; locked: unknown[] };
    expect(awards.earned.map((a) => a.id)).toContain('first-lab');
    expect(awards.locked.length).toBeGreaterThan(0);
  });

  it('GET /users/:uid/profile?compact=1 returns the Home widget slice', async () => {
    const { env } = makeEnv();
    const body = (await (await get(env, '/users/u1/profile?compact=1')).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['level', 'overall', 'recent_awards', 'streak', 'top_skills', 'updated_at', 'user_id', 'xp']);
    expect((body.top_skills as unknown[]).length).toBe(3);
  });

  it('compact=0 and any other value is the full profile', async () => {
    const { env } = makeEnv();
    expect(Object.keys((await (await get(env, '/users/u1/profile?compact=0')).json()) as object)).toContain('skills');
    expect(Object.keys((await (await get(env, '/users/u1/profile?compact=true')).json()) as object)).toContain('skills');
  });

  it('echoes the onboarding starting levels, ignoring bad entries', async () => {
    const { env } = makeEnv();
    const body = (await (await get(env, '/users/u1/profile?starting=gateway:strong,bogus:ok')).json()) as { skills: Array<{ area: string; starting_level: string | null }> };
    expect(body.skills.find((s) => s.area === 'gateway')!.starting_level).toBe('strong');
    expect(body.skills.filter((s) => s.starting_level !== null)).toHaveLength(1);
  });

  it('GET /users/:uid/awards returns earned and locked', async () => {
    const { env, sqlite } = makeEnv();
    seed(sqlite, { session: 's1', lab: 'lab-a', startedAt: NOW - 60 * MIN, hints: 0, runs: [[1, 5 * MIN]] });
    const res = await get(env, '/users/u1/awards');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string; earned: Array<{ id: string; earned_at: number }>; locked: Array<{ id: string; progress: { have: number; need: number } }> };
    expect(Object.keys(body).sort()).toEqual(['earned', 'locked', 'user_id']);
    expect(body.earned.map((a) => a.id)).toContain('first-try-pass');
    expect(body.locked.find((a) => a.id === 'three-labs')!.progress).toEqual({ have: 1, need: 3 });
  });

  it('refuses a request with no key, a wrong key, or a session token', async () => {
    const { env } = makeEnv();
    for (const path of ['/users/u1/profile', '/users/u1/awards', '/users/u1/profile?compact=1']) {
      expect((await get(env, path, {})).status, path).toBe(401);
      expect((await get(env, path, { Authorization: 'Bearer nope' })).status, path).toBe(401);
    }
  });

  it('answers 400 bad_user_id for an id that cannot be one', async () => {
    const { env } = makeEnv();
    const res = await get(env, `/users/${'x'.repeat(200)}/profile`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_user_id');
  });

  it('answers 200 with an empty profile for a user nobody has seen', async () => {
    const { env } = makeEnv();
    const res = await get(env, '/users/never-seen/profile');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { xp: number }).xp).toBe(0);
  });
});

describe('award.earned events from a finished check run', () => {
  const meta: SessionMeta = {
    id: 'sess-1', user_id: 'u1', lab_slug: 'lab-a', lab_version: '1.0.0', family: 'agent', state: 'running',
    created_at: Date.now() - 60_000, started_at: Date.now() - 60_000, resumed_count: 0,
  };

  function runtime(env: Env) {
    const storage = createFakeStorage();
    const events: Array<{ type: string; data: unknown }> = [];
    const sql = {
      exec: (query: string, ...params: unknown[]) => {
        if (/^INSERT INTO events/.test(query)) events.push({ type: String(params[1]), data: JSON.parse(String(params[2])) });
        return [];
      },
    };
    const ctx = { id: { name: 'sess-1' }, storage: { ...storage, sql }, getWebSockets: () => [] };
    return { rt: new SessionRuntime(ctx as unknown as DurableObjectState, env, 'sess-1'), events };
  }

  const manifest = () =>
    parseManifest({
      slug: 'lab-a', version: '1.0.0', title: 'Lab A', type: 'build', family: 'agent', timeout_minutes: 90,
      services: [{ name: 'api', argv: ['python3', 'app.py'], port: 8000 }],
      checks: [{ name: 'c1', script: 'c1.sh' }],
      hints: [{ after_minutes: 5, text: 'try this' }],
    });

  async function flush() {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  }

  async function finishLab(rt: SessionRuntime, env: Env, pass: boolean) {
    const { runChecks } = await import('../../src/session/checks');
    const { insertSession } = await import('../../src/session/d1');
    await insertSession(env, meta).catch(() => {}); // the row exists once per session
    const fake = new FakeBackend();
    const proc = (out: object) => new FakeProcess().resolveNext('output', out);
    fake.resolveNext('exec', proc({ exitCode: 0, stdout: '', stderr: '', timedOut: false })); // staging
    fake.resolveNext('exec', proc({ exitCode: pass ? 0 : 1, stdout: JSON.stringify({ pass, message: pass ? 'ok' : 'no' }), stderr: '', timedOut: false }));
    (rt as unknown as { _backend: unknown })._backend = fake.asBackend();
    await runChecks(rt, manifest());
    await flush();
  }

  it('emits award.earned {id, title, tier} for each award a passing run earns, once', async () => {
    const { env, sqlite } = makeEnv();
    const { rt, events } = runtime(env);
    await rt.putMeta(meta);

    await finishLab(rt, env, true);
    const earned = events.filter((e) => e.type === 'award.earned');
    expect(earned.map((e) => (e.data as { id: string }).id).sort()).toEqual(['area-proficient-gateway', 'first-lab', 'first-try-pass', 'no-hints-finish', 'speed-run']);
    for (const e of earned) expect(Object.keys(e.data as object).sort()).toEqual(['id', 'tier', 'title']);
    expect(awardRows(sqlite).every((r) => r.session_id === 'sess-1')).toBe(true);

    // The same facts again announce nothing.
    events.length = 0;
    await announceNewAwards(rt, 'u1', 'sess-1');
    expect(events.filter((e) => e.type === 'award.earned')).toEqual([]);
  });

  it('a hint that unlocked before the run stops the no-hints award, even though the session has not ended', async () => {
    const { env } = makeEnv();
    const { rt, events } = runtime(env);
    await rt.putMeta(meta);
    await rt.recordHintDelivered({ index: 0, after_minutes: 5, text: 'try this' });
    await finishLab(rt, env, true);
    const ids = events.filter((e) => e.type === 'award.earned').map((e) => (e.data as { id: string }).id);
    expect(ids).toContain('first-lab');
    expect(ids).not.toContain('no-hints-finish');
  });

  it('a failing run earns nothing and emits nothing', async () => {
    const { env } = makeEnv();
    const { rt, events } = runtime(env);
    await rt.putMeta(meta);
    await finishLab(rt, env, false);
    expect(events.filter((e) => e.type === 'award.earned')).toEqual([]);
  });

  it('a D1 or catalogue failure inside the recompute is swallowed: it neither throws nor emits', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { DB: createFakeD1(() => { throw new Error('d1 down'); }).db, LABS_BUCKET: { get: async () => null } } as unknown as Env;
    const { rt, events } = runtime(broken);
    await expect(announceNewAwards(rt, 'u1', 'sess-1')).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
