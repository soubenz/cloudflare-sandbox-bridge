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

async function request(path, { method = 'GET', body, token, serviceKey, raw } = {}) {
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
    throw new Error(`${res.status}: ${detail}`);
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
  if (res.status === 401) throw new Error('401: signed out — reload to sign in again');
  if (!res.ok) {
    let detail = await res.text();
    try {
      detail = JSON.parse(detail).error?.message ?? JSON.parse(detail).error ?? detail;
    } catch {
      /* not JSON */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.status === 204 ? undefined : res.json();
}

export const api = {
  labs: () => sameOrigin('/api/labs'),

  /**
   * Starting a session goes through this console's own Worker, which holds
   * the service key. The browser never sees that key, and the Worker knows
   * who is signed in, so it supplies the user id rather than this page
   * guessing one.
   */
  startSession: (lab) =>
    sameOrigin('/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lab }) }),

  status: (id, token) => request(`/sessions/${id}`, { token }),
  end: (id, token, snapshot = false) =>
    request(`/sessions/${id}?snapshot=${snapshot ? 1 : 0}`, { method: 'DELETE', token }),
  restartService: (id, token, name) =>
    request(`/sessions/${id}/services/${encodeURIComponent(name)}/restart`, { method: 'POST', token }),
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
