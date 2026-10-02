import { describe, it, expect, beforeEach } from 'vitest';

/**
 * The console Worker's skills, awards and personal-path routes (dashboard/src/worker.js): the learner is
 * always the cookie's subject, the service key is attached, and what the browser sends is rebuilt from
 * the parts that are allowed. Same harness as console-worker.test.ts: the Worker is called directly with
 * a fake env whose `API` binding records what it was sent.
 */
type Call = { url: string; method: string; headers: Headers; body: string };
type Reply = { status?: number; body?: unknown };

const worker = (await import('../../dashboard/src/worker.js' as string)) as {
  default: { fetch: (req: Request, env: unknown) => Promise<Response> };
};

const ORIGIN = 'https://console.test';
let calls: Call[] = [];
let replies: Array<(url: string) => Reply | undefined> = [];

const e = {
  CONSOLE_PASSWORD: 'pw',
  CONSOLE_COOKIE_SECRET: 'cookie-secret',
  SANDBOX_API_KEY: 'svc-key',
  API_BASE: 'https://api.internal',
  API_PUBLIC_ORIGIN: 'https://api.example',
  ASSETS: { fetch: async () => new Response('asset') },
  API: {
    fetch: async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : '' });
      for (const reply of replies) {
        const r = reply(url);
        if (r) return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  },
};

const call = (path: string, init: RequestInit & { cookie?: string | null } = {}, env: unknown = e) => {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (cookie) headers.set('cookie', cookie);
  return worker.default.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers }), env);
};

let cookie = '';
beforeEach(async () => {
  calls = [];
  replies = [];
  const res = await call('/auth/login', { method: 'POST', body: JSON.stringify({ password: 'pw' }) });
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
});

const put = (path: string, body: unknown) =>
  call(path, { method: 'PUT', cookie, headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('GET /api/profile and /api/awards', () => {
  it('reads the profile for the cookie subject with the service key', async () => {
    replies.push((u) => (u.includes('/profile') ? { body: { user_id: 'console', xp: 5 } } : undefined));
    const res = await call('/api/profile', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'console', xp: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.internal/users/console/profile');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc-key');
  });

  it('passes compact=1 and the quiz result as ?starting=, rebuilt from the pairs that fit', async () => {
    await call('/api/profile?compact=1&starting=gateway:ok,mcp:new,rag:strong', { cookie });
    expect(calls[0]!.url).toBe('https://api.internal/users/console/profile?compact=1&starting=gateway%3Aok%2Cmcp%3Anew%2Crag%3Astrong');
  });

  it('drops a starting pair that is not area:ok|new|strong, and a compact that is not 1', async () => {
    await call('/api/profile?compact=yes&starting=gateway:ok,x:../..,mcp:familiar,Rag:new,otel:new%26user_id%3Dsomeone', { cookie });
    expect(calls[0]!.url).toBe('https://api.internal/users/console/profile?starting=gateway%3Aok');
  });

  it('never takes a user id from the address: only the cookie names the learner', async () => {
    await call('/api/profile?user_id=someone-else&uid=x', { cookie });
    await call('/api/awards?user_id=someone-else', { cookie });
    expect(calls.map((c) => c.url)).toEqual(['https://api.internal/users/console/profile', 'https://api.internal/users/console/awards']);
  });

  it('reads the awards', async () => {
    replies.push((u) => (u.endsWith('/awards') ? { body: { user_id: 'console', earned: [], locked: [] } } : undefined));
    const res = await call('/api/awards', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'console', earned: [], locked: [] });
  });

  it('needs the cookie, and only answers GET', async () => {
    expect((await call('/api/profile')).status).toBe(401);
    expect((await call('/api/awards')).status).toBe(401);
    expect((await call('/api/profile', { method: 'POST', cookie })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('passes an API error status on for the console to put in plain words; a refused key or an API that is down is a 502', async () => {
    replies.push(() => ({ status: 500, body: { error: { code: 'internal_error', message: 'D1 failed' } } }));
    expect((await call('/api/profile', { cookie })).status).toBe(500);
    replies.length = 0;
    replies.push(() => ({ status: 401, body: { error: { code: 'unauthorized', message: 'x' } } }));
    expect((await call('/api/awards', { cookie })).status).toBe(502);
    const down = { ...e, API: { fetch: async () => Promise.reject(new Error('down')) } };
    const res = await call('/api/profile', { cookie }, down);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/try again/);
  });
});

describe('the personal path', () => {
  it('reads the path (GET) for the cookie subject', async () => {
    replies.push(() => ({ body: { steps: [], total_minutes: 0, weeks_estimate: 0 } }));
    const res = await call('/api/path', { cookie });
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe('https://api.internal/users/console/path');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc-key');
  });

  it('passes a 404 (no inputs yet) through', async () => {
    replies.push(() => ({ status: 404, body: { error: { code: 'no_inputs', message: 'no inputs' } } }));
    expect((await call('/api/path', { cookie })).status).toBe(404);
  });

  it('rebuilds with POST, and only POST ?force=1 forces it', async () => {
    await call('/api/path', { method: 'POST', cookie });
    await call('/api/path?force=1', { method: 'POST', cookie });
    await call('/api/path?force=1', { cookie });
    await call('/api/path?force=true', { method: 'POST', cookie });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.internal/users/console/path',
      'POST https://api.internal/users/console/path?force=1',
      'GET https://api.internal/users/console/path',
      'POST https://api.internal/users/console/path',
    ]);
  });

  it('is behind the cookie', async () => {
    expect((await call('/api/path')).status).toBe(401);
    expect((await call('/api/path', { method: 'POST' })).status).toBe(401);
    expect((await call('/api/path-inputs', { method: 'PUT', body: '{}' })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe('PUT /api/path-inputs', () => {
  const good = { areas: { gateway: 'new', mcp: 'ok', rag: 'strong' }, goal_text: 'Run our AI gateway', goal_kind: 'role-ready', hours_per_week: 4 };

  it('forwards the checked body to the API for the cookie subject, and the answer back', async () => {
    replies.push(() => ({ body: { steps: [], total_minutes: 0, weeks_estimate: 0 } }));
    const res = await put('/api/path-inputs', good);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.internal/users/console/path-inputs');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc-key');
    expect(JSON.parse(calls[0]!.body)).toEqual(good);
  });

  it("accepts the console's own ok, familiar, and no goal text", async () => {
    const res = await put('/api/path-inputs', { areas: { gateway: 'ok', mcp: 'familiar' }, hours_per_week: 20 });
    expect(res.status).toBe(200);
    expect(JSON.parse(calls[0]!.body)).toEqual({ areas: { gateway: 'ok', mcp: 'familiar' }, hours_per_week: 20 });
  });

  it('adds no user: a user id in the body is refused and never forwarded', async () => {
    expect((await put('/api/path-inputs', { ...good, user_id: 'someone-else' })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('tidies the goal text and refuses one over 200 characters', async () => {
    await put('/api/path-inputs', { ...good, goal_text: '  Run\n  our\tgateway  ' });
    expect(JSON.parse(calls[0]!.body).goal_text).toBe('Run our gateway');
    expect((await put('/api/path-inputs', { ...good, goal_text: 'x'.repeat(200) })).status).toBe(200);
    expect((await put('/api/path-inputs', { ...good, goal_text: 'x'.repeat(201) })).status).toBe(400);
  });

  it('refuses what the API would refuse, without calling it', async () => {
    const bad: unknown[] = [
      {},
      { ...good, hours_per_week: 0 },
      { ...good, hours_per_week: 21 },
      { ...good, hours_per_week: 2.5 },
      { ...good, hours_per_week: '4' },
      { ...good, goal_kind: 'fun' },
      { ...good, goal_text: 5 },
      { ...good, areas: [] },
      { ...good, areas: { gateway: 'expert' } },
      { ...good, areas: { 'ga/te': 'new' } },
      { areas: { gateway: 'new' } },
      [],
      null,
    ];
    for (const body of bad) expect((await put('/api/path-inputs', body)).status, JSON.stringify(body)).toBe(400);
    expect((await put('/api/path-inputs', '{not json')).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('caps the body at 4 KB', async () => {
    const res = await put('/api/path-inputs', JSON.stringify({ ...good, goal_text: 'x'.repeat(5000) }));
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('passes an API refusal on, and only answers PUT', async () => {
    replies.push(() => ({ status: 400, body: { error: { code: 'invalid_path_inputs', message: 'nope' } } }));
    expect((await put('/api/path-inputs', good)).status).toBe(400);
    expect((await call('/api/path-inputs', { cookie })).status).toBe(404);
  });
});
