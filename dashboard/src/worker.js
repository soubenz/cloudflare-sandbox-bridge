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

const COOKIE = 'opx_console';
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
  const raw = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
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

/** Calls the sandbox API with the service key. Server-side only, so no CORS. */
async function callApi(env, path, init = {}) {
  return fetch(`${env.API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${env.SANDBOX_API_KEY}`,
    },
  });
}

/** Passes the API's own status and body through, so its errors stay readable. */
function relay(res) {
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
  <div class="err" id="err"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value }),
  });
  if (res.ok) location.reload();
  else err.textContent = res.status === 401 ? 'Wrong password.' : 'Could not sign in (' + res.status + ').';
});
</script>
</body></html>`;

const loginPage = (status = 200) =>
  new Response(LOGIN_PAGE, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });

/* ----------------------------------------------------------------- routing */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/auth/login' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const supplied = typeof body.password === 'string' ? body.password : '';
      if (!env.CONSOLE_PASSWORD || !timingSafeEqual(supplied, env.CONSOLE_PASSWORD)) {
        return json({ error: 'wrong password' }, 401);
      }
      // One subject, because one person uses this. That makes the API's
      // one-active-session-per-user fence mean what we want: a second tab
      // rejoins rather than starting a second container.
      const cookie = await mintCookie(env, 'console');
      return new Response(null, {
        status: 204,
        headers: {
          'set-cookie': `${COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`,
        },
      });
    }

    if (url.pathname === '/auth/logout') {
      return new Response(null, {
        status: 204,
        headers: { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` },
      });
    }

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
  },
};
