/**
 * The console's server side.
 *
 * The dashboard used to be assets-only, which meant the browser had to be
 * able to start a session by itself — so the API carried an unauthenticated
 * `POST /dev/sessions`, and anyone with this URL could start containers on
 * the account. That route is gone. This Worker holds the service key and is
 * the only thing that may use it; the browser never sees it.
 *
 * The gate is a password, deliberately: Cloudflare Access defines
 * applications on hostnames in a zone the account controls, and this Worker
 * lives on workers.dev, which is not one. A password needs no domain, no
 * identity provider and nothing outside this repo. It is interim, and its
 * limits are real — one shared secret, no per-person revocation, no SSO.
 * Putting Access in front later changes this file and nothing else.
 */

// `__Host-` makes the browser refuse the cookie unless it is Secure, has
// Path=/ and no Domain -- which is exactly how it is set below -- so a
// sibling subdomain cannot plant or overwrite it. The bare name is still
// read (never written) so a session opened before this change survives
// until it expires.
const COOKIE = '__Host-opx_console';
const LEGACY_COOKIE = 'opx_console';
const SESSION_HOURS = 12;

/* ------------------------------------------------------------------ crypto
 * Same construction as the API's session tokens (src/auth.ts): a base64url
 * payload, a dot, and an HMAC over it. Copied rather than imported, since
 * the two Workers do not share a bundle.
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

/** Length-independent comparison, so a wrong guess leaks nothing by timing. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function mintCookie(env, sub) {
  const payload = base64url(
    new TextEncoder().encode(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600 }))
  );
  return `${payload}.${await hmac(env.CONSOLE_COOKIE_SECRET, payload)}`;
}

/** The signed-in subject, or null. Never throws — a bad cookie is just absent. */
async function subjectFrom(request, env) {
  const jar = (request.headers.get('Cookie') ?? '').split(';').map((p) => p.trim());
  const read = (name) => jar.find((p) => p.startsWith(`${name}=`))?.slice(name.length + 1);
  const raw = read(COOKIE) || read(LEGACY_COOKIE);
  if (!raw) return null;

  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  if (!timingSafeEqual(sig, await hmac(env.CONSOLE_COOKIE_SECRET, payload))) return null;

  try {
    const claims = JSON.parse(fromBase64url(payload));
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- api */

/**
 * Calls the sandbox API with the service key.
 *
 * Through a service binding rather than `fetch()`: a Worker cannot call
 * another Worker over workers.dev at all — Cloudflare answers error 1042 —
 * and a binding dispatches directly without the request leaving the edge.
 * No Origin header is involved, so none of this touches the API's CORS
 * allowlist; the key is the only credential.
 */
async function callApi(env, path, init = {}) {
  return env.API.fetch(`${env.API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${env.SANDBOX_API_KEY}`,
    },
  });
}

/** Passes the API's own status and body through, so its errors stay readable. */
function relay(res) {
  // A 401 from the API means *this Worker's* service key is wrong, not that
  // the person is signed out -- 401 from the console is reserved for "no
  // console cookie", and the launcher renders it as the signed-out state.
  if (res.status === 401) {
    return json({ error: 'console could not authenticate to the API (service key rejected)' }, 502);
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/* ---------------------------------------------------------------- headers */

/**
 * Headers for every response this Worker returns. The API origin comes from
 * config (`API_PUBLIC_ORIGIN`), never a literal: `API_BASE` is only a
 * well-formed placeholder for the service binding, not a browsable origin.
 */
function securityHeaders(env) {
  let api = '';
  try {
    api = env.API_PUBLIC_ORIGIN ? new URL(env.API_PUBLIC_ORIGIN).origin : '';
  } catch {
    // A malformed var just leaves the API origin out; the console then
    // cannot reach the API, which is louder than allowing everything.
  }
  const wss = api.replace(/^http/, 'ws');
  return {
    'content-security-policy': [
      "default-src 'self'",
      `connect-src 'self'${api ? ` ${api} ${wss}` : ''}`,
      `frame-src${api ? ` ${api}` : " 'none'"}`,
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
}

/** Re-wraps a response so its headers are mutable, then stamps the security set on it. */
function withSecurityHeaders(res, env) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(securityHeaders(env))) out.headers.set(k, v);
  return out;
}

/* ------------------------------------------------------------------- page */

const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opalix lab console</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='13' font-size='13'>▣</text></svg>">
<style>
  :root { color-scheme: dark; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0e1116; color:#e6e9ef;
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  form { background:#151a21; border:1px solid #262d38; border-radius:8px; padding:28px 32px; width:320px; }
  h1 { font-size:16px; margin:0 0 4px; }
  p { color:#6f7b8b; font-size:12px; margin:0 0 18px; }
  input { width:100%; box-sizing:border-box; background:#1b212a; border:1px solid #262d38;
          border-radius:6px; color:#e6e9ef; padding:8px 10px; font-size:13px; }
  button { width:100%; margin-top:10px; background:#1b212a; color:#e6e9ef; border:1px solid #262d38;
           border-radius:6px; padding:8px 12px; font-size:13px; cursor:pointer; }
  button:hover { border-color:#5b9dd9; }
  .err { color:#d9737a; font-size:12px; margin-top:10px; min-height:1em; }
</style></head>
<body>
<form id="f">
  <h1>▣ Opalix lab console</h1>
  <p>This console starts real containers, so it asks for a password.</p>
  <input id="pw" type="password" placeholder="Password" autocomplete="current-password" autofocus>
  <button type="submit">Sign in</button>
  <div class="err" id="err">__ERR__</div>
</form>
<script src="/login.js" defer></script>
</body></html>`;

const loginPage = (status = 200, message = '', extra = {}) =>
  new Response(LOGIN_PAGE.replace('__ERR__', message), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

const TOO_MANY = 'Too many attempts \u2014 try again in a minute';

/**
 * Five attempts a minute per address, via a Cloudflare rate-limit binding.
 * The binding is absent in local dev, and a failing limiter must not lock
 * the owner out of their own console, so both cases allow the request.
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

/* ----------------------------------------------------------------- routing */

export default {
  async fetch(request, env) {
    return withSecurityHeaders(await route(request, env), env);
  },
};

async function route(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/auth/login' && request.method === 'POST') {
      if (!(await loginAllowed(request, env))) {
        return loginPage(429, TOO_MANY, { 'retry-after': '60' });
      }
      const body = await request.json().catch(() => ({}));
      const supplied = typeof body.password === 'string' ? body.password : '';
      if (!env.CONSOLE_PASSWORD || !timingSafeEqual(supplied, env.CONSOLE_PASSWORD)) {
        return json({ error: 'wrong password' }, 401);
      }
      // One subject, because one person uses this. That makes the API's
      // one-active-session-per-user fence mean what we want: a second tab
      // rejoins rather than starting a second container.
      const cookie = await mintCookie(env, 'console');
      const headers = new Headers();
      headers.append(
        'set-cookie',
        `${COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`
      );
      // A session from before the rename would otherwise linger beside the new one.
      headers.append('set-cookie', `${LEGACY_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      return new Response(null, { status: 204, headers });
    }

    // POST only: a GET must not be able to sign someone out (an <img src>
    // on any page would do it).
    if (url.pathname === '/auth/logout') {
      if (request.method !== 'POST') {
        return new Response(null, { status: 405, headers: { allow: 'POST' } });
      }
      const headers = new Headers();
      for (const name of [COOKIE, LEGACY_COOKIE]) {
        headers.append('set-cookie', `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      }
      return new Response(null, { status: 204, headers });
    }

    // The login page's script has to load before anyone is signed in.
    if (url.pathname === '/login.js' && request.method === 'GET') return env.ASSETS.fetch(request);

    const subject = await subjectFrom(request, env);

    // An expired tab must fail loudly rather than render a login page into
    // a JSON parser, so /api/* answers 401 instead of serving HTML.
    if (!subject) {
      return url.pathname.startsWith('/api/') ? json({ error: 'not signed in' }, 401) : loginPage();
    }

    if (url.pathname === '/api/labs' && request.method === 'GET') {
      return relay(await callApi(env, '/labs'));
    }

    if (url.pathname === '/api/start' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (typeof body.lab !== 'string' || !body.lab) return json({ error: 'lab is required' }, 400);
      return relay(
        await callApi(env, '/sessions/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lab: body.lab, user_id: subject }),
        })
      );
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);

    return env.ASSETS.fetch(request);
}
