import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../src/env';
import { currentKey, learnKey, manifestKey } from '../../src/labs/bundle';
import { warmUpSessionId, WARM_UP_FINISHED, parseWarmUpBody } from '../../src/labs/warmup';
import { sqliteD1 } from './sqlite-d1';

/**
 * POST /users/:uid/warmups/:slug/complete, driven through the real router
 * against real SQLite (the repo's own migrations) and an in-memory R2: the
 * completion is one passed `check_runs` row, so progress reads it as done.
 */

const pool = vi.hoisted(() => ({ admit: vi.fn(async () => {}), stats: vi.fn() }));
vi.mock('../../src/do/pool', () => ({ poolStub: () => pool }));

const { createRouter } = await import('../../src/router');
const app = createRouter();

const SERVICE = { Authorization: 'Bearer svc-key' };

function fakeBucket() {
  const store = new Map<string, string>();
  const bucket = {
    async get(key: string) {
      const v = store.get(key);
      return v === undefined ? null : { text: async () => v, json: async () => JSON.parse(v) };
    },
  };
  return { bucket, store };
}

const warmUpManifest = (slug: string) => ({ slug, version: '1.0.0', title: 'First steps', type: 'warm-up', tier: 'free', difficulty: 'intro', estimated_minutes: 10 });
const buildManifest = (slug: string) => ({
  slug, version: '1.0.0', title: 'A build lab', type: 'build', family: 'agent', timeout_minutes: 60,
  services: [{ name: 'svc', argv: ['x'], port: 8000 }],
  checks: [{ name: 'c', script: 'c.sh' }],
});

const GAMES = [
  {
    kind: 'sort', id: 'sort-calls', title: 'Who pays?', prompt: 'Put each call where its cost lands.', explanation: 'The team that owns the key pays.',
    buckets: [{ id: 'team', label: 'The team' }, { id: 'platform', label: 'The platform' }],
    cards: [
      { id: 'c1', text: 'A call with the team key', bucket: 'team' },
      { id: 'c2', text: 'A health check', bucket: 'platform' },
      { id: 'c3', text: 'A retry of a team call', bucket: 'team' },
    ],
  },
  {
    kind: 'flag', id: 'flag-logs', title: 'Spot the leak', prompt: 'Flag the log lines that leak a secret.', explanation: 'Keys never belong in logs.',
    items: [
      { id: 'a', text: 'key=sk-123', flag: true, why: 'A raw key.' },
      { id: 'b', text: 'status=200', flag: false },
      { id: 'c', text: 'model=fast', flag: false },
    ],
  },
];

function makeEnv(opts: { games?: unknown[]; manifest?: unknown } = {}) {
  const { db, sqlite } = sqliteD1();
  const { bucket, store } = fakeBucket();
  const slug = 'first-steps';
  store.set(currentKey(slug), '1.0.0');
  store.set(manifestKey(slug, '1.0.0'), JSON.stringify(opts.manifest ?? warmUpManifest(slug)));
  store.set(learnKey(slug, '1.0.0'), JSON.stringify({ version: 1, concepts: [], questions: [], games: opts.games ?? GAMES }));
  const env = { SANDBOX_API_KEY: 'svc-key', SESSION_TOKEN_SECRET: 'secret', PUBLIC_BASE_URL: 'https://api.test', DB: db, LABS_BUCKET: bucket } as unknown as Env;
  return { env, sqlite, store };
}

const complete = (env: Env, body: unknown, opts: { uid?: string; slug?: string; headers?: Record<string, string> } = {}) =>
  app.fetch(
    new Request(`https://api.test/users/${opts.uid ?? 'u1'}/warmups/${opts.slug ?? 'first-steps'}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? SERVICE) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env
  );
const j = async (res: Response) => (await res.json()) as any;

const solvedAll = { games: [{ id: 'sort-calls', solved: true, tries: 1 }, { id: 'flag-logs', solved: true, tries: 3 }], started_at: 1_000 };

type Row = { id: string; session_id: string; user_id: string; lab_slug: string; lab_version: string; passed: number; total: number; score: number; passed_all: number; started_at: number; results_json: string };
const rows = (sqlite: ReturnType<typeof sqliteD1>['sqlite']) => sqlite.prepare('SELECT * FROM check_runs').all() as Row[];

describe('POST /users/:uid/warmups/:slug/complete', () => {
  it('writes one passed check run with one result per game', async () => {
    const { env, sqlite } = makeEnv();
    const res = await complete(env, solvedAll);
    expect(res.status).toBe(201);
    const body = await j(res);
    expect(body).toMatchObject({ done: true, already: false });
    expect(typeof body.run_id).toBe('string');

    const all = rows(sqlite);
    expect(all).toHaveLength(1);
    const row = all[0]!;
    expect(row).toMatchObject({
      id: body.run_id,
      session_id: warmUpSessionId('u1', 'first-steps'),
      user_id: 'u1',
      lab_slug: 'first-steps',
      lab_version: '1.0.0',
      passed: 2,
      total: 2,
      score: 1,
      passed_all: 1,
      started_at: 1_000,
    });
    const results = JSON.parse(row.results_json) as Array<{ name: string; pass: boolean; weight: number }>;
    expect(results.map((r) => [r.name, r.pass, r.weight])).toEqual([
      ['sort-calls', true, 1],
      ['flag-logs', true, 1],
    ]);
  });

  it('is idempotent: a second call is `already` and writes nothing', async () => {
    const { env, sqlite } = makeEnv();
    expect((await complete(env, solvedAll)).status).toBe(201);
    const again = await complete(env, solvedAll);
    expect(again.status).toBe(200);
    expect(await j(again)).toEqual({ done: true, already: true });
    expect(rows(sqlite)).toHaveLength(1);
  });

  it('is 400 warm_up_incomplete, naming the games not reported solved', async () => {
    const { env, sqlite } = makeEnv();
    const res = await complete(env, { games: [{ id: 'sort-calls', solved: true, tries: 1 }, { id: 'flag-logs', solved: false, tries: 2 }] });
    expect(res.status).toBe(400);
    const body = await j(res);
    expect(body.error.code).toBe('warm_up_incomplete');
    expect(body.error.details).toEqual({ missing: ['flag-logs'] });
    expect(rows(sqlite)).toHaveLength(0);

    const none = await complete(env, {});
    expect((await j(none)).error.details).toEqual({ missing: ['sort-calls', 'flag-logs'] });
  });

  it('needs no entries for a warm-up with no games, and files one `finished` result', async () => {
    const { env, sqlite } = makeEnv({ games: [] });
    const res = await complete(env, {});
    expect(res.status).toBe(201);
    const [row] = rows(sqlite);
    expect(row).toMatchObject({ passed: 1, total: 1, passed_all: 1 });
    expect(JSON.parse(row!.results_json).map((r: { name: string }) => r.name)).toEqual([WARM_UP_FINISHED]);
  });

  it('is 400 not_a_warm_up for a lab with a container', async () => {
    const { env, sqlite } = makeEnv({ manifest: buildManifest('first-steps') });
    const res = await complete(env, solvedAll);
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe('not_a_warm_up');
    expect(rows(sqlite)).toHaveLength(0);
  });

  it('is 404 lab_not_found for an unknown or malformed slug', async () => {
    const { env } = makeEnv();
    const res = await complete(env, solvedAll, { slug: 'no-such-lab' });
    expect(res.status).toBe(404);
    expect((await j(res)).error.code).toBe('lab_not_found');
    const bad = await complete(env, solvedAll, { slug: 'Not_A_Slug' });
    expect(bad.status).toBe(404);
  });

  it('is 401 without the service key, and writes nothing', async () => {
    const { env, sqlite } = makeEnv();
    expect((await complete(env, solvedAll, { headers: {} })).status).toBe(401);
    expect((await complete(env, solvedAll, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect(rows(sqlite)).toHaveLength(0);
  });

  it('refuses a malformed or oversized body', async () => {
    const { env } = makeEnv();
    const notJson = await complete(env, '{nope');
    expect(notJson.status).toBe(400);
    expect((await j(notJson)).error.code).toBe('invalid_warm_up_body');
    const badShape = await complete(env, { games: [{ id: 'sort-calls', solved: 'yes', tries: 1 }] });
    expect((await j(badShape)).error.code).toBe('invalid_warm_up_body');
    const big = await complete(env, JSON.stringify({ games: [], pad: 'x'.repeat(20 * 1024) }));
    expect(big.status).toBe(413);
  });

  it('then reads as done in GET /users/:uid/progress', async () => {
    const { env } = makeEnv();
    await complete(env, solvedAll);
    const res = await app.fetch(new Request('https://api.test/users/u1/progress', { headers: SERVICE }), env);
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.labs).toEqual([expect.objectContaining({ slug: 'first-steps', passed_all: true, best_score: 1, attempts: 1 })]);
  });
});

describe('parseWarmUpBody', () => {
  it('defaults games to none and keeps started_at', () => {
    expect(parseWarmUpBody({})).toEqual({ games: [] });
    expect(parseWarmUpBody({ games: [], started_at: 5 })).toEqual({ games: [], started_at: 5 });
  });
});
