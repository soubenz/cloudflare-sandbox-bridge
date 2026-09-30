/**
 * Client for the Opalix sandbox API. The dashboard is a separate Worker, so
 * every call here is cross-origin and depends on the API's CORS allowlist
 * naming this origin.
 *
 * Two credentials, matching the API: a short-lived session token minted by
 * the start call, used for everything inside a session; and the service key,
 * which the dashboard only holds if an operator pastes one for pool actions.
 */
const DEFAULT_API = 'https://opalix-sandbox.soubenz94.workers.dev';

/**
 * The one API this console talks to. There used to be a localStorage
 * override and a footer button to set it — a dev-era escape hatch that let
 * anyone repoint a learner's console (and the session token it sends) at
 * some other host. There is exactly one real API, so it is not configurable.
 */
export function apiBase() {
  return DEFAULT_API;
}

/** The message keeps its `NNN: ` prefix (callers match on it); `status` saves them parsing it. */
function statusError(status, detail) {
  const err = new Error(`${status}: ${detail}`);
  err.status = status;
  return err;
}

/**
 * How the console recovers a session token the API no longer accepts.
 * Installed by app.js, which owns the session; api.js only knows to ask.
 * `refresh()` resolves a new token for the same session, or null;
 * `signedOut()` is told when even a freshly issued token was refused.
 */
let auth = { refresh: async () => null, signedOut: () => {} };
export function configureAuth(hooks) {
  auth = { ...auth, ...hooks };
}

/** One refresh at a time: several requests failing together share the rejoin. */
let refreshing = null;
function refreshToken() {
  refreshing ??= auth.refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function request(path, { method = 'GET', body, token, serviceKey, raw, recover = true, retried = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (serviceKey) headers.Authorization = `Bearer ${serviceKey}`;
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });

  if (!res.ok) {
    // The API's errors are {error:{code,message}}; surface the message, since
    // it is written to be read (e.g. "This user already has an active session").
    let detail = await res.text();
    try {
      detail = JSON.parse(detail).error?.message ?? detail;
    } catch {
      /* not JSON; use the raw body */
    }
    // A 401 on a session route is an expired or refused token, not a lab
    // that is gone. Rejoin once for a fresh one and replay the request; a
    // second 401 is real and falls through to the caller.
    if (res.status === 401 && token && recover) {
      if (!retried) {
        const fresh = await refreshToken().catch(() => null);
        if (fresh) return request(path, { method, body, token: fresh, serviceKey, raw, retried: true });
      } else {
        // Refused even with a token the API had just issued: the sign-in
        // itself is what has gone.
        auth.signedOut?.();
      }
    }
    throw statusError(res.status, detail);
  }
  if (res.status === 204) return undefined;
  const type = res.headers.get('content-type') ?? '';
  return type.includes('json') ? res.json() : res.text();
}

/**
 * A call to this console's own Worker rather than to the API.
 *
 * Same origin, so no CORS and no credential in the browser: the cookie goes
 * automatically and the Worker attaches the service key on the way out. A
 * 401 here means the sign-in expired, which is worth saying plainly rather
 * than surfacing as a parse error.
 */
async function sameOrigin(path, init = {}) {
  const res = await fetch(path, init);
  if (res.status === 401) throw statusError(401, 'signed out — reload to sign in again');
  if (!res.ok) {
    let detail = await res.text();
    try {
      detail = JSON.parse(detail).error?.message ?? JSON.parse(detail).error ?? detail;
    } catch {
      /* not JSON */
    }
    throw statusError(res.status, detail);
  }
  return res.status === 204 ? undefined : res.json();
}

const BUSY_RETRY_MS = 30_000;

export const api = {
  labs: () => sameOrigin('/api/labs'),

  /**
   * Starting a session goes through this console's own Worker, which holds
   * the service key. The browser never sees that key, and the Worker knows
   * who is signed in, so it supplies the user id rather than this page
   * guessing one.
   */
  startSession: async (lab, { retries = 0, onBusy } = {}) => {
    // 503 and 409 both mean "no slot for you right now" (the pool is
    // saturated, or a start raced another). Waiting is the right answer,
    // so wait — visibly — rather than surface it as a failure.
    for (let attempt = 0; ; attempt++) {
      try {
        return await sameOrigin('/api/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lab }),
        });
      } catch (err) {
        if ((err.status !== 503 && err.status !== 409) || attempt >= retries) throw err;
        onBusy?.(attempt + 1, retries, BUSY_RETRY_MS / 1000);
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      }
    }
  },

  /**
   * `recover: false` is for asking about a session remembered from an
   * earlier visit: a refused token there means "that session is gone", and
   * rejoining through /api/start would start a fresh container to find out.
   */
  status: (id, token, { recover = true } = {}) => request(`/sessions/${id}`, { token, recover }),
  end: (id, token, snapshot = false) =>
    request(`/sessions/${id}?snapshot=${snapshot ? 1 : 0}`, { method: 'DELETE', token }),
  restartService: (id, token, name) =>
    request(`/sessions/${id}/services/${encodeURIComponent(name)}/restart`, { method: 'POST', token }),
  touch: (id, token) => request(`/sessions/${id}/touch`, { method: 'POST', token }),
  resume: (id, token) => request(`/sessions/${id}/resume`, { method: 'POST', token }),
  snapshot: (id, token) => request(`/sessions/${id}/snapshot`, { method: 'POST', token }),
  runChecks: (id, token) => request(`/sessions/${id}/checks`, { method: 'POST', body: {}, token }),

  listFiles: (id, token, path = '/workspace') =>
    request(`/sessions/${id}/files?path=${encodeURIComponent(path)}`, { token }),
  readFile: (id, token, path) => request(`/sessions/${id}/files/${path}`, { token }),
  writeFile: (id, token, path, content) =>
    request(`/sessions/${id}/files/${path}`, { method: 'PUT', body: content, raw: true, token }),

  pools: (serviceKey) => request('/pools', { serviceKey }),
  primePool: (family, target, serviceKey) =>
    request(`/pools/${family}/prime`, { method: 'POST', body: { target }, serviceKey }),
  drainPool: (family, serviceKey) =>
    request(`/pools/${family}/drain`, { method: 'POST', serviceKey }),
};

/** EventSource cannot set headers, so browser-facing routes take ?token=. */
export function eventsUrl(id, token) {
  return `${apiBase()}/sessions/${id}/events?token=${encodeURIComponent(token)}`;
}

export function terminalUrl(id, token) {
  return `${apiBase().replace(/^http/, 'ws')}/sessions/${id}/terminal?token=${encodeURIComponent(token)}`;
}

export function serviceUrl(id, token, name) {
  return `${apiBase()}/sessions/${id}/services/${name}/?token=${encodeURIComponent(token)}`;
}
