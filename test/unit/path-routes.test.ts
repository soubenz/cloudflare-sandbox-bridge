import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Env } from '../../src/env';
import { INDEX_KEY } from '../../src/labs/bundle';
import { sqliteD1 } from './sqlite-d1';
import { CATALOGUE, slugs } from './path-fixtures';

/**
 * The three learning-path routes through the real router. The model call is
 * the Worker's own `fetch` to the AI Gateway, which is stubbed: nothing here
 * reaches the network.
 */

vi.mock('../../src/do/pool', () => ({ poolStub: () => ({ admit: async () => {}, stats: async () => ({}) }) }));
const { createRouter } = await import('../../src/router');
const app = createRouter();

const SERVICE = { Authorization: 'Bearer svc-key' };
const ALL = ['gw-intro', 'gw-routing', 'gw-capstone', 'mcp-intro', 'mcp-virtual', 'rag-basics', 'standalone'];
const BODY = { areas: { gateway: 'new', mcp: 'familiar' }, goal_text: 'Know the platform', goal_kind: 'explore', hours_per_week: 4 };

function makeEnv() {
  const { db, sqlite } = sqliteD1();
  sqlite.prepare(`INSERT INTO users (id, plan, created_at) VALUES ('ann', 'pro', 0)`).run();
  const env = {
    SANDBOX_API_KEY: 'svc-key',
    SESSION_TOKEN_SECRET: 'secret',
    DB: db,
    LABS_BUCKET: { get: async (key: string) => (key === INDEX_KEY ? { json: async () => CATALOGUE } : null) },
    LLM_HOST: 'gateway.ai.cloudflare.com',
    AI_GATEWAY_NAME: 'opalix',
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    AI_GATEWAY_TOKEN: 'tok',
  } as unknown as Env;
  return { env, sqlite };
}

/** Stubs the global fetch the gateway call uses; the model answers with `order` (slugs). */
function stubGateway(order: string[] | 'fail') {
  const stub = vi.fn(async () => {
    if (order === 'fail') return new Response('upstream down', { status: 502 });
    const content = JSON.stringify({ steps: order.map((slug) => ({ slug, why: `Why ${slug}.` })) });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

afterEach(() => vi.unstubAllGlobals());

const call = (env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = SERVICE) =>
  app.request(path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

describe('auth', () => {
  it.each([
    ['PUT', '/users/ann/path-inputs', BODY],
    ['POST', '/users/ann/path', undefined],
    ['GET', '/users/ann/path', undefined],
  ])('%s %s needs the service key', async (method, path, body) => {
    const { env } = makeEnv();
    stubGateway([]);
    expect((await call(env, method!, path!, body, {})).status).toBe(401);
    expect((await call(env, method!, path!, body, { Authorization: 'Bearer wrong' })).status).toBe(401);
  });
});

describe('GET /users/:uid/path', () => {
  it('is 404 no_inputs for a user who never took the quiz', async () => {
    const { env } = makeEnv();
    const fetchStub = stubGateway([]);
    const res = await call(env, 'GET', '/users/ann/path');
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'no_inputs' } });
    expect(fetchStub).not.toHaveBeenCalled();
    expect((await call(env, 'POST', '/users/ann/path')).status).toBe(404);
  });

  it('returns the stored path afterwards, from cache', async () => {
    const { env } = makeEnv();
    const fetchStub = stubGateway(ALL);
    const put = await call(env, 'PUT', '/users/ann/path-inputs', BODY);
    expect(put.status).toBe(200);
    expect(put.headers.get('x-path-cache')).toBe('miss');
    const putBody = (await put.json()) as { steps: Array<{ slug: string; why: string }>; source: string };
    expect(putBody.source).toBe('ai');
    expect(putBody.steps[0]).toMatchObject({ why: 'Why gw-intro.' });

    const got = await call(env, 'GET', '/users/ann/path');
    expect(got.status).toBe(200);
    expect(got.headers.get('x-path-cache')).toBe('hit');
    expect(await got.json()).toEqual(putBody);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('POST /users/:uid/path', () => {
  it('recomputes from the cache, and ?force=1 asks the model again', async () => {
    const { env } = makeEnv();
    const fetchStub = stubGateway(ALL);
    await call(env, 'PUT', '/users/ann/path-inputs', BODY);
    const again = await call(env, 'POST', '/users/ann/path');
    expect(again.headers.get('x-path-cache')).toBe('hit');
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const forced = await call(env, 'POST', '/users/ann/path?force=1');
    expect(forced.status).toBe(200);
    expect(forced.headers.get('x-path-cache')).toBe('forced');
    expect(fetchStub).toHaveBeenCalledTimes(2);
    const sent = (fetchStub.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect((sent.headers as Record<string, string>)['cf-aig-skip-cache']).toBe('true');
  });

  it('a gateway failure still answers 200 with the rules\' path', async () => {
    const { env } = makeEnv();
    stubGateway('fail');
    const res = await call(env, 'PUT', '/users/ann/path-inputs', BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; steps: Array<{ slug: string; status: string }> };
    expect(body.source).toBe('rules');
    expect(slugs(body.steps)).toEqual(['gw-intro', 'gw-routing', 'gw-capstone', 'mcp-intro', 'mcp-virtual', 'rag-basics', 'standalone']);
    expect(body.steps[0]!.status).toBe('next');
  });
});

describe('PUT /users/:uid/path-inputs', () => {
  it.each([
    ['hours below 1', { ...BODY, hours_per_week: 0 }],
    ['hours above 20', { ...BODY, hours_per_week: 21 }],
    ['a goal over 200 characters', { ...BODY, goal_text: 'g'.repeat(201) }],
    ['an unknown goal kind', { ...BODY, goal_kind: 'career' }],
    ['an unknown area', { ...BODY, areas: { nonsense: 'new' } }],
    ['an unknown level', { ...BODY, areas: { gateway: 'expert' } }],
    ['an extra field', { ...BODY, plan: 'pro' }],
  ])('rejects %s with 400 invalid_path_inputs and stores nothing', async (_name, body) => {
    const { env, sqlite } = makeEnv();
    const fetchStub = stubGateway([]);
    const res = await call(env, 'PUT', '/users/ann/path-inputs', body);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'invalid_path_inputs' } });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM user_profile_inputs`).get()).toEqual({ n: 0 });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON', async () => {
    const { env } = makeEnv();
    const res = await app.request('/users/ann/path-inputs', { method: 'PUT', headers: SERVICE, body: 'nope' }, env);
    expect(res.status).toBe(400);
  });

  it('a retake replaces the inputs and gives a new path', async () => {
    const { env, sqlite } = makeEnv();
    const fetchStub = stubGateway(ALL);
    await call(env, 'PUT', '/users/ann/path-inputs', BODY);
    const retake = await call(env, 'PUT', '/users/ann/path-inputs', { ...BODY, areas: { gateway: 'strong' }, hours_per_week: 10 });
    expect(retake.headers.get('x-path-cache')).toBe('miss');
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare(`SELECT areas_json, hours_per_week FROM user_profile_inputs WHERE user_id = 'ann'`).get()).toEqual({ areas_json: '{"gateway":"strong"}', hours_per_week: 10 });
    expect(slugs(((await retake.json()) as { steps: Array<{ slug: string }> }).steps)).not.toContain('gw-routing');
  });
});
