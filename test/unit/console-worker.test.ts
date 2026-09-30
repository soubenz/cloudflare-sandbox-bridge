import { describe, it, expect, beforeEach } from 'vitest';

/**
 * The console Worker's learning routes (dashboard/src/worker.js).
 *
 * The Worker is plain JS with no Cloudflare imports, so it is called directly
 * with a fake env: `API` is a service binding whose fetch records what the
 * Worker sent, and the cookie comes from the real login route. There was no
 * test of this Worker before; these cover the routes the learning flow added
 * and the catalogue passthrough they depend on (`has_learn`).
 */
type Call = { url: string; method: string; headers: Headers; body: string };
type Reply = { status?: number; body?: unknown; raw?: string };

const worker = (await import('../../dashboard/src/worker.js' as string)) as {
  default: { fetch: (req: Request, env: unknown) => Promise<Response> };
};

const ORIGIN = 'https://console.test';
let calls: Call[] = [];
let replies: Array<(url: string) => Reply | undefined> = [];

function env() {
  return {
    CONSOLE_PASSWORD: 'pw',
    CONSOLE_COOKIE_SECRET: 'cookie-secret',
    SANDBOX_API_KEY: 'svc-key',
    API_BASE: 'https://api.internal',
    API_PUBLIC_ORIGIN: 'https://api.example',
    ASSETS: { fetch: async () => new Response('asset') },
    API: {
      fetch: async (url: string, init: RequestInit = {}) => {
        calls.push({
          url,
          method: init.method ?? 'GET',
          headers: new Headers(init.headers),
          body: typeof init.body === 'string' ? init.body : '',
        });
        for (const reply of replies) {
          const r = reply(url);
          if (r) return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  };
}

const e = env();
const call = (path: string, init: RequestInit & { cookie?: string | null } = {}) => {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (cookie) headers.set('cookie', cookie);
  return worker.default.fetch(new Request(`${ORIGIN}${path}`, { ...rest, headers }), e);
};

async function signIn(): Promise<string> {
  const res = await call('/auth/login', { method: 'POST', body: JSON.stringify({ password: 'pw' }) });
  expect(res.status).toBe(204);
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.split(';')[0]!;
}

const answer = (o: Record<string, unknown> = {}) => ({ question_id: 'q-alias-purpose', concept: 'gateway.routing-aliases', correct: true, phase: 'diagnostic', ...o });
const post = (cookie: string | null, body: unknown, extra: RequestInit = {}) =>
  call('/api/learn/answers', { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra });

let cookie = '';
beforeEach(async () => {
  calls = [];
  replies = [];
  cookie = await signIn();
});

describe('GET /api/learn/:slug', () => {
  it('reads the lab bundle from the API with the service key', async () => {
    replies.push((u) => (u.endsWith('/labs/see-what-a-gateway-does/learn') ? { body: { version: '1.0.0', learn: { version: 1 } } } : undefined));
    const res = await call('/api/learn/see-what-a-gateway-does', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1.0.0', learn: { version: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.internal/labs/see-what-a-gateway-does/learn');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc-key');
  });

  it('is behind the console cookie like the other /api routes', async () => {
    const res = await call('/api/learn/hello');
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('passes a 404 no_learn through as it is', async () => {
    replies.push(() => ({ status: 404, body: { error: { code: 'no_learn', message: 'Lab "hello" has no learning content' } } }));
    const res = await call('/api/learn/hello', { cookie });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no_learn');
  });

  it('sends no subject or address to the API', async () => {
    await call('/api/learn/hello', { cookie, headers: { 'cf-connecting-ip': '203.0.113.9' } });
    const sent = calls[0]!;
    expect(sent.url).not.toContain('console');
    expect(sent.url).not.toContain('203.0.113');
    expect([...sent.headers.keys()].sort()).toEqual(['authorization']);
    expect(sent.body).toBe('');
  });

  it('refuses a slug that could walk out of the route', async () => {
    // `..` is folded away by URL parsing before the route sees it (a 404); the
    // others reach the route and fail the slug pattern (a 400). None is sent on.
    for (const bad of ['a%2Fb', '%E0%A4%A', '-x', '.hidden']) {
      const res = await call(`/api/learn/${bad}`, { cookie });
      expect(res.status, bad).toBe(400);
    }
    for (const dots of ['..', '%2e%2e']) expect((await call(`/api/learn/${dots}`, { cookie })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('answers 502 when the API refuses the console key, not 401', async () => {
    replies.push(() => ({ status: 401, body: { error: { code: 'unauthorized', message: 'no' } } }));
    const res = await call('/api/learn/hello', { cookie });
    expect(res.status).toBe(502);
  });

  it('does not treat GET /api/learn/answers as a lab', async () => {
    const res = await call('/api/learn/answers', { cookie });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('GET /api/onboarding', () => {
  it('reads the quiz from the API', async () => {
    replies.push((u) => (u.endsWith('/learn/onboarding') ? { body: { version: 1, intro: 'hi', questions: [] } } : undefined));
    const res = await call('/api/onboarding', { cookie });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { intro: string }).intro).toBe('hi');
    expect(calls[0]!.url).toBe('https://api.internal/learn/onboarding');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc-key');
  });

  it('needs the cookie', async () => {
    expect((await call('/api/onboarding')).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('passes a 404 no_onboarding through', async () => {
    replies.push(() => ({ status: 404, body: { error: { code: 'no_onboarding', message: 'none' } } }));
    const res = await call('/api/onboarding', { cookie });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no_onboarding');
  });
});

describe('POST /api/learn/answers', () => {
  it('forwards the validated body to the API, and only that', async () => {
    replies.push(() => ({ status: 201, body: { ok: true, recorded: 2 } }));
    const body = { lab_slug: 'see-what-a-gateway-does', lab_version: '1.0.0', answers: [answer(), answer({ question_id: 'q-two', correct: false })] };
    const res = await post(cookie, body);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, recorded: 2 });
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(sent.url).toBe('https://api.internal/learn/answers');
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('authorization')).toBe('Bearer svc-key');
    expect(JSON.parse(sent.body)).toEqual(body);
  });

  it('adds no user, subject, session or address', async () => {
    await post(cookie, { answers: [answer({ phase: 'onboarding' })] }, { headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.4' } });
    const sent = calls[0]!;
    expect(JSON.parse(sent.body)).toEqual({ answers: [answer({ phase: 'onboarding' })] });
    expect(sent.body).not.toMatch(/console|user|sub|ip|203\.0\.113|198\.51/i);
    expect([...sent.headers.keys()].sort()).toEqual(['authorization', 'content-type']);
  });

  it('needs the cookie', async () => {
    const res = await post(null, { answers: [answer()] });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('refuses a body with any key the API does not take, without calling it', async () => {
    const bad: unknown[] = [
      { answers: [answer()], user_id: 'console' },
      { answers: [answer({ user_id: 'console' })] },
      { answers: [answer({ email: 'a@b.c' })] },
      { lab_slug: 'hello-lab', extra: 1, answers: [answer()] },
    ];
    for (const body of bad) expect((await post(cookie, body)).status, JSON.stringify(body)).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses malformed answers', async () => {
    const bad: unknown[] = [
      null,
      [],
      'text',
      { answers: [] },
      { answers: 'x' },
      { answers: [answer({ correct: 'yes' })] },
      { answers: [answer({ phase: 'other' })] },
      { answers: [answer({ question_id: 'Has Spaces' })] },
      { answers: [answer({ concept: 'nodot' })] },
      { lab_slug: 'Bad Slug', answers: [answer()] },
      { lab_version: '1.0', answers: [answer()] },
      { answers: Array.from({ length: 61 }, () => answer()) },
    ];
    for (const body of bad) expect((await post(cookie, body)).status, JSON.stringify(body)).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses text that is not JSON', async () => {
    expect((await post(cookie, '{nope')).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('accepts exactly 60 answers', async () => {
    const res = await post(cookie, { answers: Array.from({ length: 60 }, (_, i) => answer({ question_id: `q-${i}` })) });
    expect(res.status).toBe(200);
    expect(JSON.parse(calls[0]!.body).answers).toHaveLength(60);
  });

  it('caps the body at 16 KB', async () => {
    const big = { answers: [answer()], pad: 'x'.repeat(17 * 1024) };
    expect((await post(cookie, big)).status).toBe(413);
    // The declared length alone is enough to refuse, before anything is read.
    const declared = await post(cookie, { answers: [answer()] }, { headers: { 'content-type': 'application/json', 'content-length': String(17 * 1024) } });
    expect(declared.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('passes the API status and error through', async () => {
    replies.push(() => ({ status: 400, body: { error: { code: 'bad_answers', message: 'nope' } } }));
    const res = await post(cookie, { answers: [answer()] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_answers');
  });
});

describe('GET /api/labs', () => {
  it('passes has_learn through to the launcher', async () => {
    replies.push((u) =>
      u.endsWith('/labs')
        ? {
            body: [
              { slug: 'with-learn', has_learn: true, title: 'A' },
              { slug: 'without', has_learn: false, title: 'B' },
            ],
          }
        : undefined
    );
    const res = await call('/api/labs', { cookie });
    const labs = (await res.json()) as Array<{ slug: string; has_learn: boolean; progress: unknown }>;
    expect(labs.map((l) => [l.slug, l.has_learn])).toEqual([
      ['with-learn', true],
      ['without', false],
    ]);
    expect(labs.every((l) => l.progress === null)).toBe(true);
  });
});
