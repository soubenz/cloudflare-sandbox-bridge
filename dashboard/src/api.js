/**
 * Client for the Opalix sandbox API. The dashboard is a separate Worker, so
 * every call here is cross-origin and depends on the API's CORS allowlist
 * naming this origin.
 *
 * Two credentials, matching the API: a short-lived session token minted by
 * the start call, used for everything inside a session; and the service key,
 * which the dashboard only holds if an operator pastes one for pool actions.
 */
const API_KEY_STORAGE = 'opalix.apiBase';
const DEFAULT_API = 'https://opalix-sandbox.soubenz94.workers.dev';

export function apiBase() {
  return localStorage.getItem(API_KEY_STORAGE) || DEFAULT_API;
}

export function setApiBase(url) {
  localStorage.setItem(API_KEY_STORAGE, url.replace(/\/$/, ''));
}

const CLIENT_ID_STORAGE = 'opalix.clientId';

/**
 * A stable id for this browser, so the API can hand back the session we
 * already have instead of starting another container.
 *
 * The dev start route used to identify a caller by IP address. Any proxy or
 * mobile network rotates that, and when it did the rejoin missed and a
 * second container started — four leaked in one afternoon. This survives
 * the address changing.
 *
 * It is self-issued, so it is identity and not authorisation: the API still
 * caps how many live sessions one address may hold. Falls back to a
 * per-page value when storage is unavailable (private mode, blocked
 * cookies), which is no worse than the behaviour it replaces.
 */
let memoryClientId = null;
export function clientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_STORAGE);
    if (!id) {
      id = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem(CLIENT_ID_STORAGE, id);
    }
    return id;
  } catch {
    memoryClientId ??= crypto.randomUUID().replace(/-/g, '');
    return memoryClientId;
  }
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

export const api = {
  labs: () => request('/labs'),

  /**
   * The dev-open start route: no key. Identified by this browser's client
   * id so a reload rejoins rather than starting a second container; the
   * API caps how many live sessions one address may hold.
   */
  startSession: (lab) => request('/dev/sessions', { method: 'POST', body: { lab, client_id: clientId() } }),

  status: (id, token) => request(`/sessions/${id}`, { token }),
  end: (id, token, snapshot = false) =>
    request(`/sessions/${id}?snapshot=${snapshot ? 1 : 0}`, { method: 'DELETE', token }),
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
