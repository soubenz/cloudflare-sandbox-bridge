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

import { returnPathFor } from './return-path.js';

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

/**
 * The id a console address carries for a subject (`/u/<user_id>/labs/...`): the subject itself when it is
 * already a plain opaque token (today the console's one subject is `console`), else a short hash of it, so
 * an email or anything else that names a person never reaches a URL. It is a label for the address bar,
 * not a credential, and the API never sees it: calls to the API still carry the subject.
 */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
async function userIdFor(subject) {
  if (OPAQUE_ID.test(subject)) return subject;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subject));
  let hex = '';
  for (const b of new Uint8Array(digest).slice(0, 12)) hex += b.toString(16).padStart(2, '0');
  return `u-${hex}`;
}

/* ------------------------------------------------------------- admin view */

/**
 * Who may SEE the console's "Admin" switch. This is the only thing the Worker decides about admin mode: the
 * switch is a client-side view mode (it opens locks in the UI, adds shortcuts and a debug strip) and grants no
 * server-side power. The API and the graders stay gated by the service key and per-session tokens, which admin
 * mode never touches.
 *
 * `CONSOLE_ADMIN_SUBJECTS` is a comma list of subjects. Unset, it is `console`: today's one subject, the owner.
 * Set to an empty string, nobody is an admin. When real accounts arrive their subjects (an email, say) must be
 * listed here by hand; nothing else makes a subject an admin.
 */
const DEFAULT_ADMIN_SUBJECTS = 'console';
/** Where the admin Worker lives (its own origin and password); `ADMIN_URL` overrides, only an https origin or localhost is taken. */
const DEFAULT_ADMIN_URL = 'https://opalix-admin.soubenz94.workers.dev';

function canAdmin(subject, env) {
  const raw = typeof env.CONSOLE_ADMIN_SUBJECTS === 'string' ? env.CONSOLE_ADMIN_SUBJECTS : DEFAULT_ADMIN_SUBJECTS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(subject);
}

function adminUrl(env) {
  try {
    const url = new URL(env.ADMIN_URL);
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol === 'https:' || local) return url.origin;
  } catch {
    /* unset or malformed: the default */
  }
  return DEFAULT_ADMIN_URL;
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
    return json({ error: 'The labs are not available right now. Please try again in a moment.' }, 502);
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

/** A narration clip's file name: sixteen hex digits and .mp3 (the API's own rule). */
const CLIP_FILE = /^[0-9a-f]{16}\.mp3$/;

/**
 * Passes a clip through as it came, status and the headers a player needs (type, length, range). The
 * API says `public` because the file name is a content hash; behind this cookie it is `private`, so a
 * shared cache never hands a lab's audio to someone who is not signed in. Errors go the usual way.
 */
function relayAudio(res) {
  if (res.status !== 200 && res.status !== 206 && res.status !== 416) return relay(res);
  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = res.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set('cache-control', res.status === 416 ? 'no-store' : 'private, max-age=31536000, immutable');
  return new Response(res.status === 416 ? null : res.body, { status: res.status, headers });
}

/**
 * The catalogue with this person's progress folded in.
 *
 * `GET /labs` and `GET /users/:uid/progress` are independent, so they are
 * asked for together. Progress is an enhancement: a 404 (an API from before
 * the route), a 500 or a malformed body all read as "no progress yet", never
 * as a failed catalogue -- the launcher still has to list the labs. Only the
 * catalogue's own failure is passed through. Each lab gets
 * `progress: {attempts, best_score, passed_all, last_run_at} | null`, and, when the API said which plan this person
 * is on, `plan: 'free' | 'pro'` (the catalogue marks a Pro lab as locked for a free learner), plus `bypass: true`
 * for the owner's own subject (`canAdmin`), who is never held back by a plan (see `bypass_tier` below).
 */
async function labsWithProgress(env, subject) {
  const [labsRes, progressRes] = await Promise.all([
    callApi(env, '/labs'),
    callApi(env, `/users/${encodeURIComponent(subject)}/progress`).catch(() => null),
  ]);
  if (!labsRes.ok) return relay(labsRes);
  let labs;
  try {
    const body = await labsRes.json();
    labs = Array.isArray(body) ? body : body.labs;
  } catch {
    return json({ error: 'The labs could not be loaded right now. Please try again in a moment.' }, 502);
  }
  if (!Array.isArray(labs)) return json({ error: 'The labs could not be loaded right now. Please try again in a moment.' }, 502);

  const bySlug = new Map();
  let plan = null;
  if (progressRes?.ok) {
    try {
      const body = await progressRes.json();
      for (const p of Array.isArray(body?.labs) ? body.labs : []) bySlug.set(p.slug, p);
      if (body?.plan === 'free' || body?.plan === 'pro') plan = body.plan;
    } catch {
      /* unreadable progress is no progress */
    }
  }
  const bypass = canAdmin(subject, env);
  return json(
    labs.map((lab) => {
      const p = bySlug.get(lab.slug);
      return {
        ...lab,
        ...(plan ? { plan } : {}),
        ...(bypass ? { bypass: true } : {}),
        progress: p
          ? {
              attempts: p.attempts ?? 0,
              best_score: p.best_score ?? null,
              passed_all: Boolean(p.passed_all),
              last_run_at: p.last_run_at ?? null,
            }
          : null,
      };
    })
  );
}

/** The learner's live sessions from `GET /users/:uid/sessions?active=1`, reduced to what an address needs. */
async function activeSessions(env, subject) {
  let res;
  try {
    res = await callApi(env, `/users/${encodeURIComponent(subject)}/sessions?active=1`);
  } catch {
    return json({ error: 'your running labs could not be checked just now' }, 502);
  }
  if (!res.ok) return json({ error: 'your running labs could not be checked just now' }, 502);
  let rows;
  try {
    rows = await res.json();
  } catch {
    return json({ error: 'your running labs could not be read just now' }, 502);
  }
  if (!Array.isArray(rows)) return json({ error: 'your running labs could not be read just now' }, 502);
  return json({
    sessions: rows
      .filter((r) => r && typeof r.id === 'string' && typeof r.lab_slug === 'string')
      .map((r) => ({ id: r.id, lab: r.lab_slug, state: typeof r.state === 'string' ? r.state : 'running' })),
  });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/* --------------------------------------------------------------- learning */

// The learning routes are thin: the bundle and the onboarding quiz are read
// with the service key and handed to the browser as they are; the quiz
// answers go the other way, and that is the one body this Worker rebuilds.

/** A lab slug as the API spells them. Anything else never reaches a path. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const ANSWER_SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const QUESTION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const CONCEPT_ID = /^[a-z]+\.[a-z0-9]+(-[a-z0-9]+)*$/;
/** Most answers one request may carry (the API's own cap). */
const MAX_ANSWERS = 60;
/** The largest answers body read, in bytes. Sixty answers are about 8 KB. */
const MAX_ANSWERS_BYTES = 16 * 1024;

/**
 * Checks a POST /api/learn/answers body and rebuilds it from the parts that
 * are allowed: { lab_slug?, lab_version?, answers: [{ question_id, concept,
 * correct, phase }] }. Returns the clean body or null. Nothing else is ever
 * copied across, so a stray key (a user id, say) cannot be forwarded by
 * accident, and this Worker adds none of its own: no subject, no address.
 */
function cleanAnswersBody(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = new Set(['lab_slug', 'lab_version', 'answers']);
  if (Object.keys(raw).some((k) => !allowed.has(k))) return null;
  const body = {};
  if (raw.lab_slug !== undefined) {
    if (typeof raw.lab_slug !== 'string' || !ANSWER_SLUG.test(raw.lab_slug)) return null;
    body.lab_slug = raw.lab_slug;
  }
  if (raw.lab_version !== undefined) {
    if (typeof raw.lab_version !== 'string' || !VERSION.test(raw.lab_version)) return null;
    body.lab_version = raw.lab_version;
  }
  if (!Array.isArray(raw.answers) || raw.answers.length < 1 || raw.answers.length > MAX_ANSWERS) return null;
  body.answers = [];
  for (const a of raw.answers) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
    if (Object.keys(a).some((k) => k !== 'question_id' && k !== 'concept' && k !== 'correct' && k !== 'phase')) return null;
    if (typeof a.question_id !== 'string' || !QUESTION_ID.test(a.question_id)) return null;
    if (typeof a.concept !== 'string' || a.concept.length > 80 || !CONCEPT_ID.test(a.concept)) return null;
    if (typeof a.correct !== 'boolean') return null;
    if (a.phase !== 'onboarding' && a.phase !== 'diagnostic') return null;
    body.answers.push({ question_id: a.question_id, concept: a.concept, correct: a.correct, phase: a.phase });
  }
  return body;
}

/** Reads a request body as text, refusing more than `max` bytes (by header first, then by what arrived). */
async function readCapped(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > max ? null : text;
}

/* ------------------------------------------------- skills, awards, path */

// The learner's profile, awards and personal path. Every call is for the cookie's subject: the browser never
// names a user, and nothing here reads a user id from the address or the body.

/** One `area:level` pair of the quiz result the browser holds (the console's own `ok`, not the API's `familiar`). */
const STARTING_PAIR = /^[a-z]{2,24}:(new|ok|strong)$/;
const MAX_STARTING_PAIRS = 12;

/** `gateway:ok,mcp:new` rebuilt from the pairs that fit, or '' (an unknown shape is dropped, never forwarded). */
function cleanStarting(raw) {
  if (typeof raw !== 'string' || raw.length > 400) return '';
  return raw
    .split(',')
    .filter((pair) => STARTING_PAIR.test(pair))
    .slice(0, MAX_STARTING_PAIRS)
    .join(',');
}

const PATH_AREA = /^[a-z]{2,24}$/;
const PATH_LEVELS = ['new', 'ok', 'familiar', 'strong'];
const GOAL_KINDS = ['role-ready', 'specific-skill', 'explore'];
const MAX_GOAL_TEXT = 200;
const MAX_INPUTS_BYTES = 4 * 1024;

/**
 * Checks a PUT /api/path-inputs body and rebuilds it: { areas, goal_text?, goal_kind?, hours_per_week }.
 * Returns { body } or { error } (plain words). Nothing but those four fields is copied across, so a user id
 * in the body goes nowhere. The goal text is the learner's own free text: it is tidied here and never logged.
 */
function cleanPathInputs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'path inputs must be an object' };
  const allowed = new Set(['areas', 'goal_text', 'goal_kind', 'hours_per_week']);
  if (Object.keys(raw).some((k) => !allowed.has(k))) return { error: 'path inputs have a field that is not allowed' };
  const body = {};
  if (!raw.areas || typeof raw.areas !== 'object' || Array.isArray(raw.areas)) return { error: 'areas must be an object' };
  body.areas = {};
  for (const [area, level] of Object.entries(raw.areas)) {
    if (!PATH_AREA.test(area) || !PATH_LEVELS.includes(level)) return { error: 'areas hold an area or a level that is not allowed' };
    body.areas[area] = level;
  }
  if (raw.goal_text !== undefined) {
    if (typeof raw.goal_text !== 'string') return { error: 'goal_text must be text' };
    const text = raw.goal_text.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
    if (text.length > MAX_GOAL_TEXT) return { error: 'goal_text is too long' };
    body.goal_text = text;
  }
  if (raw.goal_kind !== undefined) {
    if (!GOAL_KINDS.includes(raw.goal_kind)) return { error: 'goal_kind is not one of the allowed kinds' };
    body.goal_kind = raw.goal_kind;
  }
  if (!Number.isInteger(raw.hours_per_week) || raw.hours_per_week < 1 || raw.hours_per_week > 20) return { error: 'hours_per_week must be a whole number from 1 to 20' };
  body.hours_per_week = raw.hours_per_week;
  return { body };
}

/** A game id as learn/games.yaml spells them. */
const GAME_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** Most games one warm-up may report (a learn bundle carries at most six). */
const MAX_WARM_UP_GAMES = 12;
const MAX_WARM_UP_TRIES = 10_000;
/** The largest warm-up completion body read, in bytes. Six games are well under 1 KB. */
const MAX_WARM_UP_BYTES = 4 * 1024;

/**
 * Checks a POST /api/warmups/:slug/complete body and rebuilds it: { games: [{ id, solved, tries }], started_at? }.
 * Returns the clean body or null. Nothing else is copied across: the learner is the cookie's subject, never
 * something the body names.
 */
function cleanWarmUpBody(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.keys(raw).some((k) => k !== 'games' && k !== 'started_at')) return null;
  if (!Array.isArray(raw.games) || raw.games.length > MAX_WARM_UP_GAMES) return null;
  const body = { games: [] };
  for (const g of raw.games) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
    if (Object.keys(g).some((k) => k !== 'id' && k !== 'solved' && k !== 'tries')) return null;
    if (typeof g.id !== 'string' || !GAME_ID.test(g.id)) return null;
    if (typeof g.solved !== 'boolean') return null;
    if (!Number.isInteger(g.tries) || g.tries < 0 || g.tries > MAX_WARM_UP_TRIES) return null;
    body.games.push({ id: g.id, solved: g.solved, tries: g.tries });
  }
  if (raw.started_at !== undefined) {
    if (!Number.isInteger(raw.started_at) || raw.started_at <= 0) return null;
    body.started_at = raw.started_at;
  }
  return body;
}

/**
 * Asks the API for something about the signed-in learner and hands its answer on as it came (status and
 * body), so the console can say what went wrong in its own plain words (api.js plainError reads the status).
 * An API that cannot be reached at all is a 502 with a sentence, never a thrown error.
 */
async function relayForLearner(env, path, init) {
  let res;
  try {
    res = await callApi(env, path, init);
  } catch {
    return json({ error: 'Your progress could not be loaded right now. Please try again in a moment.' }, 502);
  }
  return relay(res);
}

const learnerPath = (subject, tail) => `/users/${encodeURIComponent(subject)}/${tail}`;

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
<meta name="return-to" content="__NEXT__">
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
  <p>Enter the password to open your labs.</p>
  <input id="pw" type="password" placeholder="Password" autocomplete="current-password" autofocus>
  <button type="submit">Sign in</button>
  <div class="err" id="err">__ERR__</div>
</form>
<script src="/login.js" defer></script>
</body></html>`;

/** A value safe inside a double-quoted HTML attribute. */
const attr = (value) => value.replace(/[&"'<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' })[c]);

/**
 * `next` is where the form sends the browser after a successful sign-in (it
 * reads it from <meta name="return-to">): a path of this console, already
 * validated by return-path.js, never a URL.
 */
const loginPage = (status = 200, message = '', extra = {}, next = '/') =>
  new Response(LOGIN_PAGE.replace('__NEXT__', () => attr(next)).replace('__ERR__', () => message), {
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
      return url.pathname.startsWith('/api/') ? json({ error: 'not signed in' }, 401) : loginPage(200, '', {}, returnPathFor(url));
    }

    // Who the console thinks you are: the cookie's subject, so the header
    // can say so, and `user_id`, the opaque id the console's addresses carry
    // (/u/<user_id>/labs/...). Nothing secret -- the browser already holds the cookie.
    // `can_admin` says whether the Admin switch is shown to this subject (see canAdmin above); `admin_url`
    // rides along only then, so a learner's answer carries no hint of the admin Worker.
    if (url.pathname === '/api/me' && request.method === 'GET') {
      const admin = canAdmin(subject, env);
      return json({ sub: subject, user_id: await userIdFor(subject), can_admin: admin, ...(admin ? { admin_url: adminUrl(env) } : {}) });
    }

    // The sessions this learner has live, to say whether an address names one of them:
    // `{ sessions: [{ id, lab, state }] }`. No token and no user: a session id is not a credential,
    // and the way into a session is still POST /api/start, which hands back its token.
    if (url.pathname === '/api/sessions/active' && request.method === 'GET') {
      return activeSessions(env, subject);
    }

    if (url.pathname === '/api/labs' && request.method === 'GET') {
      return labsWithProgress(env, subject);
    }

    if (url.pathname === '/api/start' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (typeof body.lab !== 'string' || !body.lab) return json({ error: 'lab is required' }, 400);
      return relay(
        await callApi(env, '/sessions/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lab: body.lab, user_id: subject, ...(canAdmin(subject, env) ? { bypass_tier: true } : {}) }),
        })
      );
    }

    // Warms a lab up (see POST /sessions/prepare in the API): called once by "Before you begin" when the
    // learner nears its last step. The answer carries no session id or token -- nothing in the browser
    // can remember it, so a lab that is only warm never shows as running and has no Rejoin card.
    if (url.pathname === '/api/prepare' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (typeof body.lab !== 'string' || !SLUG.test(body.lab)) return json({ error: 'lab is required' }, 400);
      const res = await callApi(env, '/sessions/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lab: body.lab, user_id: subject, ...(canAdmin(subject, env) ? { bypass_tier: true } : {}) }),
      });
      return res.ok ? json({ prepared: true }, 202) : relay(res);
    }

    // Drops the warm lab when the learner leaves without starting it. POST because `sendBeacon` can only
    // POST (a closing tab uses it); the lab is optional. The API cancels only a session that has not
    // begun, so a beacon that arrives after Start cannot end the running lab.
    if (url.pathname === '/api/prepare/cancel' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const lab = typeof body.lab === 'string' && SLUG.test(body.lab) ? body.lab : undefined;
      const res = await callApi(env, '/sessions/prepare/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: subject, ...(lab ? { lab } : {}) }),
      });
      return res.ok ? json({ ok: true }) : relay(res);
    }

    // The learning layer. The bundle and the quiz are the same for everyone,
    // so nothing about the subject is sent; a 404 (no_learn, no_onboarding)
    // passes through, which is how the console knows there is nothing to show.
    const learnMatch = url.pathname.match(/^\/api\/learn\/([^/]+)$/);
    if (learnMatch && learnMatch[1] !== 'answers' && request.method === 'GET') {
      let slug = '';
      try {
        slug = decodeURIComponent(learnMatch[1]);
      } catch {
        /* a malformed escape is not a slug */
      }
      if (!SLUG.test(slug)) return json({ error: 'not a lab slug' }, 400);
      return relay(await callApi(env, `/labs/${encodeURIComponent(slug)}/learn`));
    }

    // The owner's Answers tab: a lab's reference solution. The Worker itself decides who may have it (the same
    // list that decides who sees the Admin switch), so nothing the browser sends can open it; the API route behind
    // it takes the service key, which no learner holds.
    const answersMatch = url.pathname.match(/^\/api\/admin\/solution\/([^/]+)$/);
    if (answersMatch && request.method === 'GET') {
      if (!canAdmin(subject, env)) return json({ error: 'not available' }, 403);
      let slug = '';
      try {
        slug = decodeURIComponent(answersMatch[1]);
      } catch {
        /* a malformed escape is not a slug */
      }
      if (!SLUG.test(slug)) return json({ error: 'not a lab slug' }, 400);
      return relay(await callApi(env, `/labs/${encodeURIComponent(slug)}/solution`));
    }

    // A narration clip of a lab's comic. Same origin as the console so the page's <audio> carries the
    // cookie; this Worker reads it from the API with the service key. Strict names (a lab slug, and the
    // sixteen-hex clip file) are all that ever reach a path, and Range goes through so a clip can seek.
    const audioMatch = url.pathname.match(/^\/api\/audio\/([^/]+)\/([^/]+)$/);
    if (audioMatch && request.method === 'GET') {
      let slug = '';
      try {
        slug = decodeURIComponent(audioMatch[1]);
      } catch {
        /* a malformed escape is not a slug */
      }
      if (!SLUG.test(slug) || !CLIP_FILE.test(audioMatch[2])) return json({ error: 'not an audio clip' }, 400);
      const range = request.headers.get('range');
      return relayAudio(await callApi(env, `/labs/${encodeURIComponent(slug)}/audio/${audioMatch[2]}`, range ? { headers: { range } } : {}));
    }

    if (url.pathname === '/api/onboarding' && request.method === 'GET') {
      return relay(await callApi(env, '/learn/onboarding'));
    }

    if (url.pathname === '/api/learn/answers' && request.method === 'POST') {
      const text = await readCapped(request, MAX_ANSWERS_BYTES);
      if (text === null) return json({ error: 'answers body is too large' }, 413);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json({ error: 'answers must be JSON' }, 400);
      }
      const body = cleanAnswersBody(parsed);
      if (!body) return json({ error: 'answers body is not valid' }, 400);
      return relay(
        await callApi(env, '/learn/answers', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      );
    }

    // The learner's skills, XP, streak and awards. `starting` is the platform quiz result the browser holds
    // (the quiz lives in localStorage), rebuilt from the pairs that fit; the user is the cookie's subject.
    if (url.pathname === '/api/profile' && request.method === 'GET') {
      const query = new URLSearchParams();
      if (url.searchParams.get('compact') === '1') query.set('compact', '1');
      const starting = cleanStarting(url.searchParams.get('starting'));
      if (starting) query.set('starting', starting);
      const qs = query.toString();
      return relayForLearner(env, learnerPath(subject, `profile${qs ? `?${qs}` : ''}`));
    }

    if (url.pathname === '/api/awards' && request.method === 'GET') {
      return relayForLearner(env, learnerPath(subject, 'awards'));
    }

    // The personal path: GET reads (building it when the inputs, labs or plan changed), POST rebuilds,
    // and `?force=1` rebuilds even when nothing changed.
    if (url.pathname === '/api/path' && (request.method === 'GET' || request.method === 'POST')) {
      const force = request.method === 'POST' && url.searchParams.get('force') === '1';
      return relayForLearner(env, learnerPath(subject, `path${force ? '?force=1' : ''}`), { method: request.method });
    }

    if (url.pathname === '/api/path-inputs' && request.method === 'PUT') {
      const text = await readCapped(request, MAX_INPUTS_BYTES);
      if (text === null) return json({ error: 'path inputs are too large' }, 413);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json({ error: 'path inputs must be JSON' }, 400);
      }
      const { body, error } = cleanPathInputs(parsed);
      if (!body) return json({ error }, 400);
      return relayForLearner(env, learnerPath(subject, 'path-inputs'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    // A finished warm-up: the games the browser played, filed for the cookie's subject as a completed lab.
    const warmUpMatch = url.pathname.match(/^\/api\/warmups\/([^/]+)\/complete$/);
    if (warmUpMatch && request.method === 'POST') {
      let slug = '';
      try {
        slug = decodeURIComponent(warmUpMatch[1]);
      } catch {
        /* a malformed escape is not a slug */
      }
      if (!SLUG.test(slug)) return json({ error: 'not a lab slug' }, 400);
      const text = await readCapped(request, MAX_WARM_UP_BYTES);
      if (text === null) return json({ error: 'warm-up body is too large' }, 413);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json({ error: 'warm-up body must be JSON' }, 400);
      }
      const body = cleanWarmUpBody(parsed);
      if (!body) return json({ error: 'warm-up body is not valid' }, 400);
      return relayForLearner(env, learnerPath(subject, `warmups/${encodeURIComponent(slug)}/complete`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);

    return env.ASSETS.fetch(request);
}
