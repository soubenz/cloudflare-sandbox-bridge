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
type Reply = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> };

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
          if (r) return new Response(r.status === 416 ? null : (r.raw ?? JSON.stringify(r.body ?? {})), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
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

describe('GET /api/audio/:slug/:file', () => {
  const FILE = '82111213e8173703.mp3';
  const clip = (extra: Reply = {}): Reply => ({
    raw: 'MP3DATA',
    headers: { 'content-type': 'audio/mpeg', 'content-length': '7', 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000, immutable', 'x-secret': 'leak' },
    ...extra,
  });

  it('reads the clip from the API with the service key and passes the audio through', async () => {
    replies.push((u) => (u.endsWith(`/labs/see-what-a-gateway-does/audio/${FILE}`) ? clip() : undefined));
    const res = await call(`/api/audio/see-what-a-gateway-does/${FILE}`, { cookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('MP3DATA');
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('content-length')).toBe('7');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(calls[0]!.url).toBe(`https://api.internal/labs/see-what-a-gateway-does/audio/${FILE}`);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc-key');
  });

  it('keeps the clip out of shared caches (the API says public; behind the cookie it is private) and forwards nothing else', async () => {
    replies.push(() => clip());
    const res = await call(`/api/audio/see-what-a-gateway-does/${FILE}`, { cookie });
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('x-secret')).toBeNull();
  });

  it('forwards Range and passes 206 and Content-Range through', async () => {
    replies.push(() => clip({ status: 206, raw: 'P3D', headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 2-4/7', 'content-length': '3' } }));
    const res = await call(`/api/audio/see-what-a-gateway-does/${FILE}`, { cookie, headers: { range: 'bytes=2-4', 'x-other': 'no' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-4/7');
    expect(await res.text()).toBe('P3D');
    expect(calls[0]!.headers.get('range')).toBe('bytes=2-4');
    expect([...calls[0]!.headers.keys()].sort()).toEqual(['authorization', 'range']);
  });

  it('passes 416 through and an API 404 as it is', async () => {
    replies.push(() => ({ status: 416, headers: { 'content-range': 'bytes */7' } }));
    const res = await call(`/api/audio/see-what-a-gateway-does/${FILE}`, { cookie, headers: { range: 'bytes=99-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */7');
    replies.length = 0;
    replies.push(() => ({ status: 404, body: { error: { code: 'no_audio', message: 'none' } } }));
    const missing = await call(`/api/audio/see-what-a-gateway-does/${FILE}`, { cookie });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe('no_audio');
  });

  it('is behind the console cookie', async () => {
    const res = await call(`/api/audio/see-what-a-gateway-does/${FILE}`);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('refuses a slug or a file name that is not strictly what the API spells, and sends nothing on', async () => {
    for (const path of [
      `/api/audio/a%2Fb/${FILE}`,
      `/api/audio/%E0%A4%A/${FILE}`,
      `/api/audio/-x/${FILE}`,
      '/api/audio/see-what-a-gateway-does/manifest.json',
      '/api/audio/see-what-a-gateway-does/private.tgz',
      `/api/audio/see-what-a-gateway-does/${FILE}.bak`,
      '/api/audio/see-what-a-gateway-does/ABCDEF0123456789.mp3',
      '/api/audio/see-what-a-gateway-does/abc.mp3',
      '/api/audio/see-what-a-gateway-does/..%2Fprivate.tgz',
    ]) {
      expect((await call(path, { cookie })).status, path).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('answers 502 when the API refuses the console key, and only GET is served', async () => {
    replies.push(() => ({ status: 401, body: {} }));
    expect((await call(`/api/audio/see-what-a-gateway-does/${FILE}`, { cookie })).status).toBe(502);
    expect((await call(`/api/audio/see-what-a-gateway-does/${FILE}`, { cookie, method: 'POST', body: '{}' })).status).toBe(404);
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

describe('POST /api/prepare and /api/prepare/cancel', () => {
  const postTo = (path: string, cookie: string | null, body: unknown) =>
    call(path, { method: 'POST', cookie, headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('prepares the lab for the signed-in subject, with the service key, and hands the browser no session', async () => {
    replies.push((u) => (u.endsWith('/sessions/prepare') ? { status: 202, body: { id: 'sess-1', state: 'starting', prepared: true } } : undefined));
    const res = await postTo('/api/prepare', cookie, { lab: 'see-what-a-gateway-does' });
    expect(res.status).toBe(202);
    // No id, no token: the browser cannot remember a lab that is only warm.
    expect(await res.json()).toEqual({ prepared: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.internal/sessions/prepare');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc-key');
    expect(JSON.parse(calls[0]!.body)).toEqual({ lab: 'see-what-a-gateway-does', user_id: 'console', bypass_tier: true });
  });

  it('passes an API refusal through (a lab already running is a 409), for the page to ignore', async () => {
    replies.push((u) => (u.endsWith('/sessions/prepare') ? { status: 409, body: { error: { code: 'active_session_exists', message: 'busy' } } } : undefined));
    const res = await postTo('/api/prepare', cookie, { lab: 'x-lab' });
    expect(res.status).toBe(409);
  });

  it('refuses a missing or malformed lab without calling the API', async () => {
    for (const body of [{}, { lab: '' }, { lab: 7 }, { lab: '../x' }, 'nope']) {
      const res = await postTo('/api/prepare', cookie, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('is behind the console cookie, POST only', async () => {
    expect((await postTo('/api/prepare', null, { lab: 'x-lab' })).status).toBe(401);
    expect((await postTo('/api/prepare/cancel', null, { lab: 'x-lab' })).status).toBe(401);
    expect(calls).toHaveLength(0);
    expect((await call('/api/prepare', { cookie })).status).toBe(404);
  });

  it('cancels by user (and lab when it names one) through the API\'s conditional cancel', async () => {
    const res = await postTo('/api/prepare/cancel', cookie, { lab: 'see-what-a-gateway-does' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.internal/sessions/prepare/cancel');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer svc-key');
    expect(JSON.parse(calls[0]!.body)).toEqual({ user_id: 'console', lab: 'see-what-a-gateway-does' });
  });

  it('cancels with no lab, or with a body a beacon sent as plain text, and drops a junk lab', async () => {
    await postTo('/api/prepare/cancel', cookie, {});
    await postTo('/api/prepare/cancel', cookie, 'not json');
    await postTo('/api/prepare/cancel', cookie, { lab: '../../x' });
    expect(calls.map((c) => JSON.parse(c.body))).toEqual([{ user_id: 'console' }, { user_id: 'console' }, { user_id: 'console' }]);
  });

  it('cannot end anything but the signed-in subject\'s own session: the user id is the cookie\'s, never the body\'s', async () => {
    await postTo('/api/prepare/cancel', cookie, { lab: 'x-lab', user_id: 'someone-else' });
    await postTo('/api/prepare', cookie, { lab: 'x-lab', user_id: 'someone-else' });
    expect(calls.map((c) => JSON.parse(c.body).user_id)).toEqual(['console', 'console']);
  });
});

describe('GET /api/me', () => {
  it('says who is signed in and the opaque id the console\'s addresses carry', async () => {
    const res = await call('/api/me', { cookie });
    expect(res.status).toBe(200);
    // The console's one subject is the owner, so by default it may see the Admin switch.
    expect(await res.json()).toEqual({ sub: 'console', user_id: 'console', can_admin: true, admin_url: 'https://opalix-admin.soubenz94.workers.dev' });
  });

  it('needs the cookie', async () => {
    const res = await call('/api/me');
    expect(res.status).toBe(401);
  });

  it('never lets an email (or anything that is not a plain token) reach an address: it is hashed', async () => {
    // A cookie for a subject that is an email, minted the way the Worker mints one (same secret, same construction).
    const mint = async (sub: string) => {
      const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const payload = b64(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }));
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('cookie-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
      return `__Host-opx_console=${payload}.${b64(String.fromCharCode(...sig))}`;
    };
    const res = await call('/api/me', { cookie: await mint('Ada.Lovelace@example.com') });
    const body = (await res.json()) as { sub: string; user_id: string };
    expect(body.sub).toBe('Ada.Lovelace@example.com');
    expect(body.user_id).toMatch(/^u-[0-9a-f]{24}$/);
    expect(body.user_id).not.toMatch(/ada|example|@/i);
    // Stable, and different for another subject.
    const again = (await (await call('/api/me', { cookie: await mint('Ada.Lovelace@example.com') })).json()) as { user_id: string };
    const other = (await (await call('/api/me', { cookie: await mint('grace@example.com') })).json()) as { user_id: string };
    expect(again.user_id).toBe(body.user_id);
    expect(other.user_id).not.toBe(body.user_id);
  });
});

describe('GET /api/me can_admin (who is shown the Admin switch)', () => {
  /** A cookie for any subject, minted the way the Worker mints one (same secret, same construction). */
  const mint = async (sub: string) => {
    const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = b64(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('cookie-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
    return `__Host-opx_console=${payload}.${b64(String.fromCharCode(...sig))}`;
  };
  const meWith = async (vars: Record<string, string | undefined>, sub = 'console') => {
    const res = await worker.default.fetch(new Request(`${ORIGIN}/api/me`, { headers: { cookie: await mint(sub) } }), { ...e, ...vars });
    expect(res.status).toBe(200);
    return (await res.json()) as { sub: string; user_id: string; can_admin: boolean; admin_url?: string };
  };

  it('defaults to the console subject, and no other', async () => {
    expect((await meWith({})).can_admin).toBe(true);
    expect((await meWith({}, 'ada@example.com')).can_admin).toBe(false);
    expect((await meWith({}, 'console2')).can_admin).toBe(false);
  });

  it('is true only for a subject on the CONSOLE_ADMIN_SUBJECTS list (comma list, spaces ignored, exact match)', async () => {
    const vars = { CONSOLE_ADMIN_SUBJECTS: ' owner@example.com ,  ops@example.com,' };
    expect((await meWith(vars, 'owner@example.com')).can_admin).toBe(true);
    expect((await meWith(vars, 'ops@example.com')).can_admin).toBe(true);
    expect((await meWith(vars, 'Owner@example.com')).can_admin).toBe(false);
    expect((await meWith(vars, 'owner@example.com.evil')).can_admin).toBe(false);
    expect((await meWith(vars, 'someone@example.com')).can_admin).toBe(false);
  });

  it('a list that does not name the console takes the console\'s admin away; an empty list means nobody', async () => {
    expect((await meWith({ CONSOLE_ADMIN_SUBJECTS: 'owner@example.com' }, 'console')).can_admin).toBe(false);
    expect((await meWith({ CONSOLE_ADMIN_SUBJECTS: '' }, 'console')).can_admin).toBe(false);
    expect((await meWith({ CONSOLE_ADMIN_SUBJECTS: ' , ,' }, 'console')).can_admin).toBe(false);
  });

  it('hands the admin Worker\'s address to an admin only, and only when it is an https origin or localhost', async () => {
    const admin = await meWith({ ADMIN_URL: 'https://admin.example.com/some/path?x=1' });
    expect(admin.admin_url).toBe('https://admin.example.com');
    const learner = await meWith({}, 'ada@example.com');
    expect(learner).toEqual({ sub: 'ada@example.com', user_id: expect.stringMatching(/^u-/), can_admin: false });
    expect('admin_url' in learner).toBe(false);
    for (const bad of ['javascript:alert(1)', 'http://evil.example', 'not a url', 'ftp://x.example']) {
      expect((await meWith({ ADMIN_URL: bad })).admin_url, bad).toBe('https://opalix-admin.soubenz94.workers.dev');
    }
    expect((await meWith({ ADMIN_URL: 'http://localhost:8790' })).admin_url).toBe('http://localhost:8790');
  });

  it('is not a way in: it needs the cookie, and no route of the Worker looks at it', async () => {
    expect((await call('/api/me')).status).toBe(401);
    // The learner's calls to the API carry the service key and the subject, never an admin hint.
    calls = [];
    await call('/api/labs', { cookie, headers: { 'x-admin': '1' } });
    expect(calls.every((c) => !JSON.stringify([...c.headers.entries()]).includes('admin') && !c.url.includes('admin'))).toBe(true);
  });
});

describe('GET /api/sessions/active', () => {
  it('lists the learner\'s live sessions from the API with the service key, as ids, labs and states only', async () => {
    replies.push((u) =>
      u.endsWith('/users/console/sessions?active=1')
        ? { body: [{ id: 's1', user_id: 'console', lab_slug: 'hello', state: 'running', created_at: 1, secret: 'x' }, { nope: true }] }
        : undefined
    );
    const res = await call('/api/sessions/active', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [{ id: 's1', lab: 'hello', state: 'running' }] });
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer svc-key');
    expect(calls.at(-1)!.url).toContain('/users/console/sessions?active=1');
  });

  it('says so when there are none', async () => {
    replies.push((u) => (u.includes('/sessions?active=1') ? { body: [] } : undefined));
    expect(await (await call('/api/sessions/active', { cookie })).json()).toEqual({ sessions: [] });
  });

  it('is a 502 when the API cannot say (an API from before the route, or a body that is not a list)', async () => {
    replies.push((u) => (u.includes('/sessions?active=1') ? { status: 404, body: { error: 'nope' } } : undefined));
    expect((await call('/api/sessions/active', { cookie })).status).toBe(502);
    replies.length = 0;
    replies.push((u) => (u.includes('/sessions?active=1') ? { body: { not: 'a list' } } : undefined));
    expect((await call('/api/sessions/active', { cookie })).status).toBe(502);
    replies.length = 0;
    replies.push((u) => (u.includes('/sessions?active=1') ? { raw: '<html>' } : undefined));
    expect((await call('/api/sessions/active', { cookie })).status).toBe(502);
  });

  it('needs the cookie, and only answers GET', async () => {
    expect((await call('/api/sessions/active')).status).toBe(401);
    expect((await call('/api/sessions/active', { cookie, method: 'POST', body: '{}' })).status).toBe(404);
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

  it('passes archived through untouched, and does not filter the archived labs out', async () => {
    replies.push((u) =>
      u.endsWith('/labs')
        ? {
            body: [
              { slug: 'real', has_learn: false, title: 'A' },
              { slug: 'hello', has_learn: false, title: 'Hello', archived: true },
            ],
          }
        : undefined
    );
    const res = await call('/api/labs', { cookie });
    const labs = (await res.json()) as Array<{ slug: string; archived?: boolean }>;
    // Hiding is the launcher's job; the Worker hands the console every lab so a deep link to one still resolves.
    expect(labs.map((l) => l.slug)).toEqual(['real', 'hello']);
    expect(labs[1]!.archived).toBe(true);
    expect('archived' in labs[0]!).toBe(false);
  });
});

describe('deep links and signing in', () => {
  /** The path the login form will send the browser to, from its <meta name="return-to">. */
  const returnTo = async (res: Response) => /<meta name="return-to" content="([^"]*)">/.exec(await res.text())?.[1];

  it('serves the sign-in form (200) at the address that was asked for, naming that page to return to', async () => {
    for (const path of ['/labs/x1/session', '/labs/x1/lessons', '/paths/ai-platform', '/paths/ai-platform/modules/2', '/onboarding', '/labs/x1/session/service/echo', '/u/console/labs/x1/session/01j9zzzzzzzzzzzzzzzzzzzzzz', '/u/console/labs/x1/session/s1/service/echo']) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await returnTo(res), path).toBe(path);
    }
  });

  it('keeps the query of the page that was asked for', async () => {
    expect(await returnTo(await call('/labs/x1/session?comicTest=1'))).toBe('/labs/x1/session?comicTest=1');
  });

  it('honours ?next= when it is a path of the console, and nothing else', async () => {
    expect(await returnTo(await call('/?next=/labs/x1/lessons'))).toBe('/labs/x1/lessons');
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example', '%2F%2Fevil.example', '/.//evil.example', '/auth/logout', '/api/me', 'labs/x1', '%5C%5Cevil.example']) {
      const res = await call(`/?next=${next.startsWith('%') ? next : encodeURIComponent(next)}`);
      expect(res.status, next).toBe(200);
      expect(await returnTo(res), next).toBe('/');
    }
  });

  it("does not offer the Worker's own paths as somewhere to return to", async () => {
    expect(await returnTo(await call('/auth/elsewhere'))).toBe('/');
    expect(await returnTo(await call('/dist/app.js'))).toBe('/');
  });

  it('cannot be made to inject markup through the address', async () => {
    const res = await call(`/labs/x1?q=${encodeURIComponent('"><script>alert(1)</script>')}`);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(/<meta name="return-to" content="([^"]*)">/.exec(html)?.[1]).not.toMatch(/[<>']/);
  });

  it('answers /api/* with 401 JSON, not the form, when signed out', async () => {
    const res = await call('/api/labs');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/json/);
  });

  it('serves the app (not the form) at a deep link once signed in, with the same security headers', async () => {
    const res = await call('/labs/x1/session', { cookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('keeps the login script reachable without a cookie', async () => {
    const res = await call('/login.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset');
  });
});

describe('plan tier on start and prepare', () => {
  const mintFor = async (sub: string) => {
    const b64 = (v: string) => btoa(v).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = b64(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('cookie-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
    return `__Host-opx_console=${payload}.${b64(String.fromCharCode(...sig))}`;
  };
  const post = async (path: string, sub: string) =>
    worker.default.fetch(
      new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { cookie: await mintFor(sub), 'content-type': 'application/json' }, body: JSON.stringify({ lab: 'x-lab', bypass_tier: true }) }),
      e
    );
  const sent = () => JSON.parse(calls[calls.length - 1]!.body) as Record<string, unknown>;

  it('an admin subject asks the API to skip the plan check; anyone else never does, whatever the browser sends', async () => {
    calls.length = 0;
    await post('/api/start', 'console');
    expect(sent().bypass_tier).toBe(true);
    await post('/api/prepare', 'console');
    expect(sent().bypass_tier).toBe(true);
    await post('/api/start', 'ada@example.com');
    expect(sent()).toEqual({ lab: 'x-lab', user_id: 'ada@example.com' });
    await post('/api/prepare', 'ada@example.com');
    expect(sent()).toEqual({ lab: 'x-lab', user_id: 'ada@example.com' });
  });
});
