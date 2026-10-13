import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../../src/env';
import { currentKey, learnKey, manifestKey } from '../../src/labs/bundle';
import { MAX_LEARN_PROGRESS_BYTES, parseLearnProgressBody } from '../../src/labs/learn-progress';
import { sqliteD1 } from './sqlite-d1';

/**
 * GET, PUT and DELETE /users/:uid/labs/:slug/learn-progress through the real router against real SQLite
 * (the repo's own migrations): one learner's place in a lab's "Before you begin" or a warm-up.
 */

const pool = vi.hoisted(() => ({ admit: vi.fn(async () => {}), stats: vi.fn() }));
vi.mock('../../src/do/pool', () => ({ poolStub: () => pool }));

const { createRouter } = await import('../../src/router');
const app = createRouter();

const SERVICE = { Authorization: 'Bearer svc-key' };
const SLUG = 'first-steps';

function makeEnv() {
  const { db, sqlite } = sqliteD1();
  const store = new Map<string, string>();
  const bucket = {
    async get(key: string) {
      const v = store.get(key);
      return v === undefined ? null : { text: async () => v, json: async () => JSON.parse(v) };
    },
  };
  // A warm-up with no games, so its completion needs nothing reported.
  store.set(currentKey(SLUG), '1.0.0');
  store.set(manifestKey(SLUG, '1.0.0'), JSON.stringify({ slug: SLUG, version: '1.0.0', title: 'First steps', type: 'warm-up', tier: 'free', difficulty: 'intro', estimated_minutes: 10 }));
  store.set(learnKey(SLUG, '1.0.0'), JSON.stringify({ version: 1, concepts: [], questions: [], games: [] }));
  const env = { SANDBOX_API_KEY: 'svc-key', SESSION_TOKEN_SECRET: 'secret', PUBLIC_BASE_URL: 'https://api.test', DB: db, LABS_BUCKET: bucket } as unknown as Env;
  return { env, sqlite };
}

const STATE = {
  v: 1,
  steps: [
    { kind: 'story' },
    { kind: 'round', round: 1, rounds: 1, questions: ['q1', 'q2'] },
    { kind: 'lessons', part: 1, parts: 1, concepts: ['gateway.alias'], plan: [{ concept: 'gateway.alias', state: 'expanded' }] },
    { kind: 'story', closing: true },
    { kind: 'game', game: 'sort-calls' },
  ],
  at: 2,
  answers: { q1: { question_id: 'q1', concept: 'gateway.alias', correct: true, selected: ['a'] } },
  games: {},
  started_at: 1_700_000_000_000,
  lessons: { at: { 'gateway.alias': 'gateway.alias' }, pages: { 'gateway.alias': 1 }, read: [] },
  label: 'Lessons',
};
const BODY = { version: '1.0.0', state: STATE };

const call = (env: Env, method: string, body?: unknown, opts: { uid?: string; slug?: string; headers?: Record<string, string> } = {}) =>
  app.fetch(
    new Request(`https://api.test/users/${opts.uid ?? 'u1'}/labs/${opts.slug ?? SLUG}/learn-progress`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(opts.headers ?? SERVICE) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env
  );
const j = async (res: Response) => (await res.json()) as any;
const count = (sqlite: ReturnType<typeof sqliteD1>['sqlite']) => (sqlite.prepare('SELECT COUNT(*) AS n FROM learn_progress').get() as { n: number }).n;

describe('learn progress routes', () => {
  it('GET is null before anything is saved', async () => {
    const { env } = makeEnv();
    const res = await call(env, 'GET');
    expect(res.status).toBe(200);
    expect(await j(res)).toEqual({ user_id: 'u1', slug: SLUG, progress: null });
  });

  it('PUT saves, GET reads it back with its version, and a second PUT replaces it', async () => {
    const { env, sqlite } = makeEnv();
    const put = await call(env, 'PUT', BODY);
    expect(put.status).toBe(200);
    expect(await j(put)).toMatchObject({ saved: true });
    const got = await j(await call(env, 'GET'));
    expect(got.progress.version).toBe('1.0.0');
    expect(got.progress.state).toEqual(STATE);
    expect(typeof got.progress.updated_at).toBe('number');

    expect((await call(env, 'PUT', { version: '1.1.0', state: { ...STATE, at: 4 } })).status).toBe(200);
    const again = await j(await call(env, 'GET'));
    expect(again.progress.version).toBe('1.1.0');
    expect(again.progress.state.at).toBe(4);
    expect(count(sqlite)).toBe(1);
  });

  it('keeps each user and each lab apart', async () => {
    const { env, sqlite } = makeEnv();
    await call(env, 'PUT', BODY);
    await call(env, 'PUT', { ...BODY, state: { ...STATE, at: 1 } }, { uid: 'u2' });
    await call(env, 'PUT', { ...BODY, state: { ...STATE, at: 3 } }, { slug: 'other-lab' });
    expect(count(sqlite)).toBe(3);
    expect((await j(await call(env, 'GET'))).progress.state.at).toBe(2);
    expect((await j(await call(env, 'GET', undefined, { uid: 'u2' }))).progress.state.at).toBe(1);
    expect((await j(await call(env, 'GET', undefined, { slug: 'other-lab' }))).progress.state.at).toBe(3);
  });

  it('DELETE forgets it (start over), and says whether there was any', async () => {
    const { env } = makeEnv();
    await call(env, 'PUT', BODY);
    expect(await j(await call(env, 'DELETE'))).toEqual({ deleted: true });
    expect((await j(await call(env, 'GET'))).progress).toBeNull();
    expect(await j(await call(env, 'DELETE'))).toEqual({ deleted: false });
  });

  it('finishing the warm-up deletes its saved place', async () => {
    const { env, sqlite } = makeEnv();
    await call(env, 'PUT', BODY);
    const done = await app.fetch(
      new Request(`https://api.test/users/u1/warmups/${SLUG}/complete`, { method: 'POST', headers: { 'content-type': 'application/json', ...SERVICE }, body: '{"games":[]}' }),
      env
    );
    expect(done.status).toBe(201);
    expect(count(sqlite)).toBe(0);
    // Saved again and finished again (`already`): still forgotten.
    await call(env, 'PUT', BODY);
    const again = await app.fetch(
      new Request(`https://api.test/users/u1/warmups/${SLUG}/complete`, { method: 'POST', headers: { 'content-type': 'application/json', ...SERVICE }, body: '{"games":[]}' }),
      env
    );
    expect(again.status).toBe(200);
    expect(count(sqlite)).toBe(0);
  });

  it.each(['GET', 'PUT', 'DELETE'])('%s is 401 without the service key, and touches nothing', async (method) => {
    const { env, sqlite } = makeEnv();
    await call(env, 'PUT', BODY);
    for (const headers of [{}, { Authorization: 'Bearer wrong' }] as Array<Record<string, string>>) {
      const res = await call(env, method, method === 'PUT' ? { ...BODY, state: { ...STATE, at: 0 } } : undefined, { headers });
      expect(res.status).toBe(401);
    }
    expect(count(sqlite)).toBe(1);
    expect((await j(await call(env, 'GET'))).progress.state.at).toBe(2);
  });

  it('refuses a bad user id and a slug that is not one', async () => {
    const { env } = makeEnv();
    expect((await call(env, 'GET', undefined, { uid: 'x'.repeat(129) })).status).toBe(400);
    const slug = await call(env, 'PUT', BODY, { slug: 'Not_A_Slug' });
    expect(slug.status).toBe(404);
    expect((await j(slug)).error.code).toBe('lab_not_found');
  });

  it('refuses a body that is not a flow record, an oversized one, and one that is not JSON', async () => {
    const { env, sqlite } = makeEnv();
    const bad: unknown[] = [
      '{nope',
      {},
      { version: '1.0.0' },
      { version: '', state: STATE },
      { version: '1.0.0', state: { ...STATE, v: 2 } },
      { version: '1.0.0', state: { ...STATE, steps: [] } },
      { version: '1.0.0', state: { ...STATE, at: 5 } },
      { version: '1.0.0', state: { ...STATE, at: -1 } },
      { version: '1.0.0', state: { ...STATE, steps: [{ kind: 'video' }] } },
      { version: '1.0.0', state: { ...STATE, steps: [{ kind: 'round', round: 1, rounds: 1, questions: [] }] , at: 0 } },
      { version: '1.0.0', state: { ...STATE, answers: { q1: { question_id: 'q1', correct: 'yes' } } } },
      { version: '1.0.0', state: { ...STATE, games: { g: { id: 'g', tries: -1 } } } },
    ];
    for (const body of bad) {
      const res = await call(env, 'PUT', body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await j(res)).error.code).toBe('invalid_learn_progress');
    }
    const big = await call(env, 'PUT', { ...BODY, state: { ...STATE, label: 'x'.repeat(100) }, pad: 'x'.repeat(MAX_LEARN_PROGRESS_BYTES) });
    expect(big.status).toBe(413);
    expect(count(sqlite)).toBe(0);
  });
});

describe('parseLearnProgressBody', () => {
  it('drops fields it does not know, and fills the defaults', () => {
    const parsed = parseLearnProgressBody({ version: '1', extra: 1, state: { v: 1, steps: [{ kind: 'story', extra: true }], at: 0, user_id: 'someone' } });
    expect(parsed).toEqual({ version: '1', state: { v: 1, steps: [{ kind: 'story' }], at: 0, answers: {} } });
  });
});
