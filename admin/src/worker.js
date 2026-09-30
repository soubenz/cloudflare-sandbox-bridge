/**
 * The admin panel's server side.
 *
 * A clone of the console Worker's shape (dashboard/src/worker.js), for a
 * different trust tier: the console lets a learner start a container, this
 * lets the owner see and steer the whole platform. So it is a separate Worker
 * on a separate origin with a separate password and cookie, and it holds
 * SANDBOX_API_KEY server-side. Because the password *is* the high tier here,
 * `/api/*` is a blanket passthrough that adds the key, rather than an
 * allowlist of routes; which calls succeed is still decided where it always
 * was, by requireServiceAuth in the API.
 *
 * The gate is one shared password, as the console's is: Cloudflare Access
 * needs a hostname in a zone the account controls, and workers.dev is not
 * one. It is interim and its limits are real -- one secret, no per-person
 * revocation, no SSO, no audit trail of who did what. Putting Access in front
 * later changes this file and nothing else.
 */

// `__Host-` makes the browser refuse the cookie unless it is Secure, has
// Path=/ and no Domain -- exactly how it is set below -- so a sibling
// subdomain cannot plant or overwrite it.
const COOKIE = '__Host-opx_admin';
const SESSION_HOURS = 8;

/* ------------------------------------------------------------------ crypto
 * Same construction as the API's session tokens (src/auth.ts) and the
 * console's cookie: a base64url payload, a dot, and an HMAC over it. Copied
 * rather than imported, since the Workers do not share a bundle.
 */

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return atob(padded);
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64url(new Uint8Array(sig));
}

/** Compares equal-length strings without an early exit, so a wrong guess leaks nothing by timing. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Password check. Both sides are hashed to a fixed length first, so neither
 * the content nor the length of the real password shows in how long a wrong
 * guess takes.
 */
async function passwordMatches(env, supplied) {
  const [a, b] = await Promise.all([hmac(env.ADMIN_COOKIE_SECRET, `pw:${supplied}`), hmac(env.ADMIN_COOKIE_SECRET, `pw:${env.ADMIN_PASSWORD}`)]);
  return timingSafeEqual(a, b);
}

async function mintCookie(env, sub) {
  const payload = base64url(
    new TextEncoder().encode(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 }))
  );
  return `${payload}.${await hmac(env.ADMIN_COOKIE_SECRET, payload)}`;
}

/** The signed-in subject, or null. Never throws: a bad cookie is just absent. */
async function subjectFrom(request, env) {
  const jar = (request.headers.get('Cookie') ?? '').split(';').map((p) => p.trim());
  const raw = jar.find((p) => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;

  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  if (!timingSafeEqual(sig, await hmac(env.ADMIN_COOKIE_SECRET, payload))) return null;

  try {
    const claims = JSON.parse(fromBase64url(payload));
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/** All three secrets, or the panel is closed: a missing one must never read as "no password". */
const configured = (env) => Boolean(env.ADMIN_PASSWORD && env.ADMIN_COOKIE_SECRET && env.SANDBOX_API_KEY);

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });

/* -------------------------------------------------------------------- api */

/** Request headers worth forwarding. The browser's cookie and Authorization are deliberately not among them. */
const FORWARDED = ['content-type', 'accept', 'if-none-match'];

/**
 * `/api/<rest>` -> the API's `/<rest>`, with the service key added.
 *
 * Through a service binding rather than `fetch()`: a Worker cannot call
 * another Worker over workers.dev at all, and a binding dispatches directly
 * without the request leaving the edge. Method, path, query and body are
 * forwarded as they came; the API's own status and body come back, so its
 * errors stay readable.
 */
async function proxy(request, env, url) {
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${env.SANDBOX_API_KEY}`);

  const path = url.pathname.slice('/api'.length) || '/';
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let res;
  try {
    res = await env.API.fetch(
      new Request(`${env.API_BASE}${path}${url.search}`, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: 'manual',
      })
    );
  } catch {
    return json({ error: { code: 'api_unreachable', message: 'The admin panel could not reach the API' } }, 502);
  }

  // A 401 from the API means *this Worker's* service key is wrong, not that
  // the person is signed out. 401 from the panel is reserved for "no cookie",
  // which the page renders as the signed-out state.
  if (res.status === 401) {
    return json({ error: { code: 'service_key_rejected', message: 'The admin panel could not authenticate to the API (service key rejected)' } }, 502);
  }

  const out = new Headers({ 'cache-control': 'no-store' });
  for (const name of ['content-type', 'retry-after']) {
    const value = res.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

/* ---------------------------------------------------------------- headers */

/**
 * Headers for every response this Worker returns. `connect-src 'self'`
 * only: unlike the console, the admin page never talks to the API from the
 * browser -- everything goes through /api on this origin -- and it frames
 * nothing. Styles are `'self'` too: the pages carry no inline style.
 */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'x-robots-tag': 'noindex, nofollow',
};

/** Re-wraps a response so its headers are mutable, then stamps the security set on it. */
function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

/* ------------------------------------------------------------------- page */

// No inline script and no inline style: the CSP allows neither, so the page
// links its stylesheet and script, and the Worker lets exactly those (and the
// design files they need) through the gate.
const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opalix Ops</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>▣</text></svg>">
<script src="/theme-init.js"></script>
<link rel="stylesheet" href="/design/tokens.css">
<link rel="stylesheet" href="/design/fonts.css">
<link rel="stylesheet" href="/login.css">
</head>
<body class="login">
<form id="f" class="login-card">
  <h1><span aria-hidden="true">▣</span> Opalix Ops</h1>
  <p>Back office. It can end sessions and change what learners are given, so it asks for a password.</p>
  <label for="pw">Password</label>
  <input id="pw" type="password" autocomplete="current-password" autofocus required>
  <button type="submit" class="btn btn-primary">Sign in</button>
  <div class="err" id="err" role="alert">__ERR__</div>
</form>
<script src="/login.js" defer></script>
</body></html>`;

const loginPage = (status = 200, message = '', extra = {}) =>
  new Response(LOGIN_PAGE.replace('__ERR__', message), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

const TOO_MANY = 'Too many attempts — try again in a minute';

/** Static files the login page needs before anyone is signed in. */
const PUBLIC_FILES = new Set(['/login.js', '/login.css', '/theme-init.js', '/design/tokens.css', '/design/fonts.css']);
const isPublicFile = (pathname) => PUBLIC_FILES.has(pathname) || pathname.startsWith('/design/fonts/');

/**
 * Five attempts a minute per address, via a Cloudflare rate-limit binding.
 * The binding is absent in local dev, and a failing limiter must not lock the
 * owner out of their own panel, so both cases allow the request.
 */
async function loginAllowed(request, env) {
  if (!env.LOGIN_LIMIT) return true;
  try {
    const { success } = await env.LOGIN_LIMIT.limit({
      key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
    });
    return success;
  } catch {
    return true;
  }
}

/**
 * A state-changing request must come from this origin. The cookie is
 * SameSite=Lax, which already keeps it off cross-site POSTs; this is the
 * second lock, and costs nothing when the browser sends no Origin at all.
 */
function crossOrigin(request, url) {
  if (request.method === 'GET' || request.method === 'HEAD') return false;
  const origin = request.headers.get('Origin');
  return origin !== null && origin !== url.origin;
}

/* ----------------------------------------------------------------- routing */

export default {
  async fetch(request, env) {
    return withSecurityHeaders(await route(request, env));
  },
};

async function route(request, env) {
  const url = new URL(request.url);

  if (crossOrigin(request, url)) return json({ error: 'cross-origin request refused' }, 403);

  if (url.pathname === '/auth/login' && request.method === 'POST') {
    if (!configured(env)) return json({ error: 'the admin panel is not configured' }, 503);
    if (!(await loginAllowed(request, env))) {
      return loginPage(429, TOO_MANY, { 'retry-after': '60' });
    }
    const body = await request.json().catch(() => ({}));
    const supplied = typeof body.password === 'string' ? body.password : '';
    if (!(await passwordMatches(env, supplied))) return json({ error: 'wrong password' }, 401);

    const headers = new Headers();
    headers.append(
      'set-cookie',
      `${COOKIE}=${await mintCookie(env, 'admin')}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`
    );
    return new Response(null, { status: 204, headers });
  }

  // POST only: a GET must not be able to sign someone out (an <img src> on
  // any page would do it).
  if (url.pathname === '/auth/logout') {
    if (request.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }
    const headers = new Headers();
    headers.append('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return new Response(null, { status: 204, headers });
  }

  // The login page's own files have to load before anyone is signed in.
  if (request.method === 'GET' && isPublicFile(url.pathname)) return env.ASSETS.fetch(request);

  const subject = configured(env) ? await subjectFrom(request, env) : null;

  // An expired tab must fail loudly rather than render a login page into a
  // JSON parser, so /api/* answers 401 instead of serving HTML.
  if (!subject) {
    return url.pathname.startsWith('/api/') ? json({ error: 'not signed in' }, 401) : loginPage();
  }

  if (url.pathname.startsWith('/api/')) return proxy(request, env, url);

  // Only GET and HEAD reach static files; nothing there takes a body.
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  return env.ASSETS.fetch(request);
}
