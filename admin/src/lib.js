/**
 * Small helpers for the admin panel: a DOM builder, the /api client,
 * formatters, the confirm dialog and toasts.
 *
 * Nothing here ever assigns HTML. Server strings (lab titles, user ids,
 * feedback text, error messages) reach the page only as text nodes, so a
 * message that contains markup is shown as markup, not run.
 */

/* --------------------------------------------------------------------- dom */

/**
 * h('button', { class: 'btn', onclick: fn, title: 'x' }, 'Label', otherNode)
 * Props: `class`, `dataset`, `on<event>` handlers, `hidden`/`disabled` and
 * friends as properties, anything else as an attribute. Children may be
 * strings or numbers (text), nodes, arrays, or null/false (skipped).
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'hidden' || key === 'disabled' || key === 'open' || key === 'checked') el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.append(child);
    else el.append(document.createTextNode(String(child)));
  }
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Like h(), for SVG elements. Attributes only; text goes in as text nodes. */
export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

/* --------------------------------------------------------------------- api */

export class ApiFailure extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The API's errors are {error:{code,message}}; the panel's own are {error:'text'}. Either way, something readable. */
function messageOf(status, text) {
  try {
    const body = JSON.parse(text);
    if (typeof body.error === 'string') return { message: body.error };
    if (body.error?.message) return { message: body.error.message, code: body.error.code };
  } catch {
    /* not JSON */
  }
  return { message: text.slice(0, 200) || `HTTP ${status}` };
}

/**
 * Calls the API through this Worker's /api proxy. Resolves the parsed JSON
 * (or null for an empty body) and throws ApiFailure otherwise. A 401 here
 * always means the cookie expired -- the Worker maps the API's own 401 to a
 * 502 -- so the page reloads into the login form rather than showing an error.
 */
export async function api(path, { method = 'GET', body, query } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = `/api${path}${qs.size ? `?${qs}` : ''}`;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiFailure(0, 'Could not reach the panel. Check your connection and retry.');
  }
  if (res.status === 401) {
    location.reload();
    throw new ApiFailure(401, 'Signed out');
  }
  const text = await res.text();
  if (!res.ok) {
    const { message, code } = messageOf(res.status, text);
    throw new ApiFailure(res.status, message, code);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiFailure(res.status, 'The API returned something that is not JSON.');
  }
}

/* -------------------------------------------------------------- formatters */

const pad = (n) => String(n).padStart(2, '0');

/** `2026-09-01 14:05` in UTC, or an em dash for a missing time. Column headers say (UTC). */
export function when(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
  const d = new Date(Number(ms));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `3m ago`, `2h ago`, `5d ago`. */
export function ago(ms, now = Date.now()) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
  const s = Math.max(0, Math.round((now - Number(ms)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Dollars: four decimals under $1 (a session costs cents), two above. */
export function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return `$${v.toFixed(Math.abs(v) < 1 ? 4 : 2)}`;
}

/** Seconds as `1h 05m`, `4m 10s`, `35s`. */
export function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '—';
  const s = Math.round(Number(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export const percent = (n) => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`);

/* ----------------------------------------------------------------- widgets */

const STATE_TONE = { running: 'good', starting: 'warn', resuming: 'warn', recovering: 'warn', created: 'warn', ended: 'muted' };

/** A status pill. Tone is text plus colour, never colour alone. */
export function pill(text, tone = 'muted') {
  return h('span', { class: `pill pill-${tone}` }, text);
}
export const statePill = (state) => pill(state ?? '—', STATE_TONE[state] ?? 'muted');

/**
 * The loading / empty / error / content states every screen shares. `mount`
 * is the element it owns; `retry` is what the error state's button calls.
 */
export function stateView(mount, retry) {
  const show = (node) => {
    clear(mount);
    mount.append(node);
  };
  return {
    loading(label = 'Loading…') {
      show(h('div', { class: 'state state-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label));
    },
    empty(message) {
      show(h('div', { class: 'state state-empty' }, message));
    },
    error(err) {
      show(
        h(
          'div',
          { class: 'state state-error', role: 'alert' },
          h('p', null, err instanceof Error ? err.message : String(err)),
          retry ? h('button', { class: 'btn', type: 'button', onclick: retry }, 'Retry') : null
        )
      );
    },
    content(node) {
      show(node);
    },
  };
}

/**
 * A table inside a container that scrolls sideways on a narrow screen instead of the page doing so.
 * A column may give `head` (a node, such as a sort button) in place of its text label, and `sort`
 * (`ascending` | `descending`) for aria-sort; `label` still names the cell on a phone.
 */
export function table(columns, rows, { caption } = {}) {
  return h(
    'div',
    { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': caption ?? 'Table' },
    h(
      'table',
      { class: 'table' },
      caption ? h('caption', { class: 'sr-only' }, caption) : null,
      h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col', class: c.class, 'aria-sort': c.sort }, c.head ?? c.label)))),
      h(
        'tbody',
        null,
        rows.map((row) =>
          h(
            'tr',
            null,
            columns.map((c) => {
              const cell = c.cell(row);
              return h('td', { class: c.class, 'data-label': c.label }, cell);
            })
          )
        )
      )
    )
  );
}

/* ------------------------------------------------------- dialog and toasts */

/**
 * A styled confirm. Resolves true only on the confirm button; Escape, the
 * backdrop and Cancel all resolve false. One dialog element, reused.
 */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  const dialog = document.getElementById('confirm');
  const yes = document.getElementById('confirmYes');
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmBody').textContent = body;
  yes.textContent = confirmLabel;
  yes.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

  return new Promise((resolve) => {
    let answer = false;
    const done = () => {
      yes.removeEventListener('click', onYes);
      document.getElementById('confirmNo').removeEventListener('click', onNo);
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('click', onBackdrop);
      resolve(answer);
    };
    const onYes = () => {
      answer = true;
      dialog.close();
    };
    const onNo = () => dialog.close();
    const onClose = () => done();
    // A click on the dialog element itself (not its card) is a click on the backdrop.
    const onBackdrop = (e) => {
      if (e.target === dialog) dialog.close();
    };
    yes.addEventListener('click', onYes);
    document.getElementById('confirmNo').addEventListener('click', onNo);
    dialog.addEventListener('close', onClose);
    dialog.addEventListener('click', onBackdrop);
    dialog.showModal();
    document.getElementById('confirmNo').focus();
  });
}

/** A short-lived message in the live region. Errors stay until dismissed by the next one. */
export function toast(message, tone = 'good') {
  const region = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${tone}` }, message);
  region.append(el);
  while (region.children.length > 3) region.firstElementChild.remove();
  if (tone !== 'bad') setTimeout(() => el.remove(), 5000);
}
