/**
 * Admin mode: a developer's VIEW of the console, for the owner. Everything admin-only lives in this file and in
 * public/admin-mode.css, so the rest of the console carries a handful of one-line hooks and nothing else.
 *
 * What it is NOT: power. It is a client-side view mode. It never changes what the API or the graders accept (they
 * are gated by the service key and per-session tokens, and a session is already startable by slug), so a learner
 * who got the switch would see a few more buttons and nothing more. The one thing the server decides is who is
 * SHOWN the switch: `GET /api/me` answers `can_admin` (the Worker's CONSOLE_ADMIN_SUBJECTS list). Without
 * `can_admin: true` nothing here is built, and a stored "on" is ignored and removed.
 *
 * When on (kept in localStorage `opalixAdminMode`):
 *   - the nav bar shows a persistent "Admin mode on" pill, and an "Admin panel" link to the admin Worker;
 *   - a lab or path step that is locked for a learner (a prerequisite, or the paid plan) can be started, and says so;
 *   - the screens before a lab have "Admin: skip to Start";
 *   - the session screen has a collapsible Admin strip: ids and state to copy, and the live event log.
 * No session token is ever shown or copied: the strip is built from named fields, and events are scrubbed.
 *
 * Learner-copy rules still apply to everything a learner sees. The switch is invisible to a learner, so the
 * words here may be technical; they are listed in test/unit/learner-copy.allow.json for that reason.
 */
import { icon, svgIcon } from './icons.js';

/** A shield, the pill's picture (the words beside it carry the meaning). */
const SHIELD = '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>';

export const ADMIN_KEY = 'opalixAdminMode';
export const STRIP_KEY = 'opalixAdminStrip';
export const LOCK_NOTE = 'Locked for learners — open anyway (admin)';
export const DEFAULT_ADMIN_URL = 'https://opalix-admin.soubenz94.workers.dev';
/** How many events the log keeps (the newest). */
export const MAX_EVENTS = 200;

// ------------------------------------------------------------------ pure helpers

/**
 * What a stored flag and the server's word make of admin mode. The server wins: without `canAdmin === true`
 * admin mode is off and whatever was stored is to be removed (`clear`), even when the flag says on.
 */
export function resolveAdmin({ canAdmin, stored }) {
  const has = stored !== null && stored !== undefined;
  if (canAdmin !== true) return { on: false, clear: has };
  return { on: stored === '1', clear: false };
}

/** The admin Worker's address, only when it is an https origin (or localhost); else the default. */
export function adminHref(value) {
  try {
    const url = new URL(value);
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol === 'https:' || local) return url.origin;
  } catch {
    /* unset or malformed */
  }
  return DEFAULT_ADMIN_URL;
}

const SECRET_KEY = /token|secret|authorization|password|cookie|credential|api[_-]?key|bearer/i;
/** `payload.signature`, the shape of a session token (or of the console's cookie). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}$/;

function redactString(text, secrets) {
  let out = text;
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('[hidden]');
  out = out.replace(/([?&](?:token|access_token|key|secret)=)[^&\s"']+/gi, '$1[hidden]');
  if (TOKEN_SHAPE.test(out)) return '[hidden]';
  return out.length > 240 ? `${out.slice(0, 240)}…` : out;
}

/**
 * A copy of an event's data that is safe to show: anything named like a credential is hidden (numbers and flags
 * stay: `tokens_in: 120` is a count, not a secret), any string that holds one of `secrets` (the session token) or
 * has the shape of a token is hidden, and size is bounded.
 */
export function redact(value, secrets = [], depth = 0) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, secrets, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 30)) {
    out[k] = SECRET_KEY.test(k) && typeof v !== 'number' && typeof v !== 'boolean' ? '[hidden]' : redact(v, secrets, depth + 1);
  }
  return out;
}

const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

/** One line of the event log: `12:00:01  check.result  {"name":"..."}`. Built from redacted data only. */
export function eventLine(entry) {
  let body = '';
  try {
    body = entry.data === undefined ? '' : JSON.stringify(entry.data);
  } catch {
    body = '';
  }
  if (body.length > 300) body = `${body.slice(0, 300)}…`;
  return { time: clock(entry.at), type: entry.type, body };
}

/**
 * The rows of the strip, from NAMED fields only: whatever else the caller holds (a token, say) is never read, so
 * it cannot reach the page or the clipboard. `copy` is what the row's button copies ('' disables it).
 */
export function sessionRows(info = {}) {
  const lab = info.lab ? (info.version ? `${info.lab}@${info.version}` : String(info.lab)) : '';
  const expires = Number.isFinite(info.expiresAt) && info.expiresAt > 0 ? new Date(info.expiresAt).toISOString() : '';
  const rows = [
    ['session', 'Session id', info.id],
    ['user', 'User id', info.userId],
    ['lab', 'Lab and version', lab],
    ['state', 'State', info.state],
    ['expires', 'Expires at', expires],
  ];
  return rows.map(([key, label, value]) => ({ key, label, value: value ? String(value) : '—', copy: value ? String(value) : '' }));
}

// ------------------------------------------------------------------ the state

const browserStorage = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
};

/**
 * Whether admin mode is allowed and on. `storage` is injectable for tests; every read and write is in a
 * try/catch, so blocked storage only means the choice does not stick.
 */
export function createAdminState({ storage = browserStorage } = {}) {
  let allowed = false;
  let on = false;
  let href = DEFAULT_ADMIN_URL;
  const listeners = new Set();
  const read = () => {
    try {
      return storage.getItem(ADMIN_KEY);
    } catch {
      return null;
    }
  };
  const write = (value) => {
    try {
      if (value) storage.setItem(ADMIN_KEY, '1');
      else storage.removeItem(ADMIN_KEY);
    } catch {
      /* private mode: fine for this tab */
    }
  };
  const notify = (changed) => {
    for (const fn of [...listeners]) fn({ can: allowed, on: allowed && on, changed });
  };
  return {
    /** Called with what `GET /api/me` said. Anything but `canAdmin === true` turns it off and clears the stored flag. */
    configure({ canAdmin, adminUrl } = {}) {
      const before = allowed && on;
      const resolved = resolveAdmin({ canAdmin, stored: read() });
      allowed = canAdmin === true;
      on = resolved.on;
      href = adminHref(adminUrl);
      if (resolved.clear) write(false);
      notify(before !== (allowed && on));
    },
    can: () => allowed,
    isOn: () => allowed && on,
    href: () => href,
    /** The switch. Does nothing when not allowed. */
    set(next) {
      if (!allowed) return false;
      const before = on;
      on = Boolean(next);
      write(on);
      notify(before !== on);
      return true;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const admin = createAdminState();

// ------------------------------------------------------------------ hooks the console calls

/** Is admin mode on (and allowed)? The one question the rest of the console asks. */
export const isAdminOn = () => admin.isOn();

/**
 * The lock line of a lab's status, for a lab that is locked for learners. The button is left startable by the
 * caller (it has no aria-disabled), and its title says why a learner could not.
 */
export function openLock(status, button, need) {
  const lock = document.createElement('span');
  lock.className = 'lab-lock admin-lock';
  lock.append(icon('lock', 14), document.createTextNode(LOCK_NOTE));
  status.append(lock);
  button.title = `${LOCK_NOTE}. A learner needs ${need} first.`;
}

/**
 * A path step that is locked (by the paid plan) becomes startable, and its reason says it is locked for learners.
 * `deps` is the page's own (`labKnown`, `onStart`), so this starts a lab exactly as a learner's Start does.
 * No-op for a learner, and for a step that is not locked.
 */
export function adminOpenStep(li, step, deps = {}) {
  if (!admin.isOn() || step.status !== 'locked' || !deps.labKnown?.(step.slug)) return;
  const act = li.querySelector('.step-act');
  if (!act) return;
  const reason = act.querySelector('.step-lock');
  if (reason) reason.textContent = LOCK_NOTE;
  let button = act.querySelector('button.lab-start[aria-disabled="true"]');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    act.append(button);
  }
  button.removeAttribute('aria-disabled');
  button.className = 'btn btn-ghost lab-start admin-open';
  button.textContent = 'Start';
  button.dataset.slug = step.slug;
  button.title = LOCK_NOTE;
  button.addEventListener('click', () => deps.onStart?.(step.slug, li));
}

// ------------------------------------------------------------------ the console's wiring

let host = { getSession: () => ({}), getSecrets: () => [], onChange: () => {} };
const events = [];
let eventsFor = null;
let tick = 0;
let observer = null;
let renderLog = 0;
let lastRows = '';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** A new session starts a new log. */
function syncSession() {
  const id = host.getSession()?.id ?? null;
  if (id !== eventsFor) {
    eventsFor = id;
    events.length = 0;
  }
}

/** Keeps a live event for the log. Only an admin ever keeps anything; the data is scrubbed on the way in. */
export function recordEvent(type, data) {
  if (!admin.can()) return;
  syncSession();
  let secrets = [];
  try {
    secrets = host.getSecrets() ?? [];
  } catch {
    /* nothing to scrub with: the shape rule still applies */
  }
  events.push({ at: Date.now(), type: String(type), data: redact(data, secrets) });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  if (admin.isOn() && !renderLog) renderLog = requestAnimationFrame(() => ((renderLog = 0), drawLog()));
}

/** Copies text; true when it was copied. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall back below */
  }
  try {
    const area = el('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// --- the nav bar

function ensureNav() {
  if ($('adminSwitch')) return;
  const sw = el('button', 'admin-switch admin-nav-item');
  sw.type = 'button';
  sw.id = 'adminSwitch';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', 'false');
  sw.title = 'Admin mode: a developer view of this console';
  const track = el('span', 'admin-track');
  track.setAttribute('aria-hidden', 'true');
  track.append(el('span', 'admin-track-word'), el('span', 'admin-thumb'));
  sw.append(el('span', 'admin-switch-label', 'Admin'), track);
  sw.addEventListener('click', () => admin.set(!admin.isOn()));
  const account = $('navAccount');
  account?.insertBefore(sw, $('btnTheme'));
}

function syncNav(on) {
  const sw = $('adminSwitch');
  if (!sw) return;
  sw.setAttribute('aria-checked', String(on));
  sw.querySelector('.admin-track-word').textContent = on ? 'On' : 'Off';

  if (!on) {
    $('adminPill')?.remove();
    $('adminPanelLink')?.remove();
    return;
  }
  if (!$('adminPill')) {
    const pill = el('span', 'admin-pill');
    pill.id = 'adminPill';
    pill.setAttribute('role', 'status');
    pill.append(svgIcon(SHIELD, 14), el('span', '', 'Admin mode on'));
    const actions = document.querySelector('.nav-actions');
    actions?.prepend(pill);
  }
  let link = $('adminPanelLink');
  if (!link) {
    link = el('a', 'admin-link admin-nav-item', 'Admin panel');
    link.id = 'adminPanelLink';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.title = 'Opens the admin Worker in a new tab (its own address and password)';
    $('adminSwitch').after(link);
  }
  link.href = admin.href();
}

// --- the strip under the dock

function ensureStrip() {
  if ($('adminStrip')) return;
  const strip = el('details', 'admin-strip');
  strip.id = 'adminStrip';
  try {
    strip.open = localStorage.getItem(STRIP_KEY) === '1';
  } catch {
    /* closed */
  }
  strip.addEventListener('toggle', () => {
    try {
      localStorage.setItem(STRIP_KEY, strip.open ? '1' : '0');
    } catch {
      /* fine */
    }
  });
  strip.append(el('summary', 'admin-strip-title', 'Admin'));
  const body = el('div', 'admin-strip-body');
  const rows = el('dl', 'admin-rows');
  rows.id = 'adminRows';
  const note = el('p', 'admin-note', 'The session token is never shown or copied here.');
  const live = el('p', 'sr-only');
  live.id = 'adminCopyLive';
  live.setAttribute('role', 'status');
  const logTitle = el('h3', 'admin-log-title', 'Live events');
  logTitle.id = 'adminLogTitle';
  const log = el('ol', 'admin-log');
  log.id = 'adminLog';
  log.setAttribute('role', 'log');
  log.setAttribute('aria-labelledby', 'adminLogTitle');
  log.tabIndex = 0;
  body.append(rows, note, live, logTitle, log);
  strip.append(body);
  const dock = $('dock');
  if (dock) dock.after(strip);
  else $('workspace')?.append(strip);
  lastRows = '';
  drawRows();
  drawLog();
}

function drawRows() {
  const rows = $('adminRows');
  if (!rows) return;
  const data = sessionRows(host.getSession());
  const sig = JSON.stringify(data);
  // Only rebuilt when something changed, so a focused Copy button is not torn out from under the keyboard.
  if (sig === lastRows) return;
  lastRows = sig;
  rows.replaceChildren(
    ...data.map((row) => {
      const wrap = el('div', 'admin-row');
      const value = el('dd', 'admin-value');
      value.append(el('code', '', row.value));
      const dt = el('dt', '', row.label);
      const button = el('button', 'btn btn-quiet btn-sm admin-copy', 'Copy');
      button.type = 'button';
      button.disabled = !row.copy;
      button.setAttribute('aria-label', `Copy ${row.label.toLowerCase()}`);
      button.addEventListener('click', async () => {
        const ok = await copyText(row.copy);
        button.textContent = ok ? 'Copied' : 'Not copied';
        const live = $('adminCopyLive');
        if (live) live.textContent = ok ? `${row.label} copied` : `${row.label} could not be copied`;
        setTimeout(() => {
          button.textContent = 'Copy';
        }, 1600);
      });
      value.append(button);
      wrap.append(dt, value);
      return wrap;
    })
  );
}

function drawLog() {
  const log = $('adminLog');
  if (!log) return;
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  const items = events.map((entry) => {
    const line = eventLine(entry);
    const li = el('li', 'admin-event');
    li.append(el('time', 'admin-event-time', line.time), el('b', 'admin-event-type', line.type));
    if (line.body) li.append(el('code', 'admin-event-body', line.body));
    return li;
  });
  if (!items.length) {
    const none = el('li', 'admin-event admin-event-none', 'No events yet.');
    items.push(none);
  }
  log.replaceChildren(...items);
  if (stick) log.scrollTop = log.scrollHeight;
}

function refresh() {
  syncSession();
  drawRows();
}

// --- "Admin: skip to Start" on the screens before a lab

/** Puts the shortcut after "Skip all, just start the lab" on whichever step is showing; it presses that button. */
function injectSkip() {
  const learnHost = $('learnHost');
  if (!learnHost) return;
  const skip = learnHost.querySelector('#btnSkipAll');
  const mine = learnHost.querySelector('.admin-skip');
  if (!skip) return void mine?.remove();
  if (mine && mine.previousElementSibling === skip) return;
  mine?.remove();
  const button = el('button', 'btn btn-ghost admin-skip', 'Admin: skip to Start');
  button.type = 'button';
  button.addEventListener('click', () => skip.click());
  skip.after(button);
}

function watchLearnHost(on) {
  observer?.disconnect();
  observer = null;
  const learnHost = $('learnHost');
  if (!learnHost) return;
  if (!on) {
    for (const b of learnHost.querySelectorAll('.admin-skip')) b.remove();
    return;
  }
  observer = new MutationObserver(injectSkip);
  observer.observe(learnHost, { childList: true, subtree: true });
  injectSkip();
}

// --- everything at once

function sync() {
  const can = admin.can();
  const on = admin.isOn();
  const root = document.documentElement;
  if (on) root.setAttribute('data-admin-mode', 'on');
  else root.removeAttribute('data-admin-mode');

  if (!can) {
    for (const id of ['adminSwitch', 'adminPill', 'adminPanelLink']) $(id)?.remove();
  } else {
    ensureNav();
    syncNav(on);
  }

  clearInterval(tick);
  tick = 0;
  if (on) {
    ensureStrip();
    tick = setInterval(refresh, 1500);
  } else {
    $('adminStrip')?.remove();
    lastRows = '';
  }
  watchLearnHost(on);
}

/**
 * Wires admin mode to the console. Call once, early; nothing is drawn until `configure` says the signed-in
 * subject may use it.
 *   getSession() -> { id, userId, lab, version, state, expiresAt }   named fields only (never the token)
 *   getSecrets() -> strings to scrub from the event log (the session token)
 *   onChange(on) -> the view mode flipped: redraw what depends on it
 */
function init(options = {}) {
  host = { ...host, ...options };
  admin.subscribe(({ changed, on }) => {
    sync();
    if (changed) host.onChange?.(on);
  });
}

export const adminMode = {
  init,
  /** From `GET /api/me`: `{ canAdmin, adminUrl }`. */
  configure: (me) => admin.configure(me),
  isOn: isAdminOn,
  can: () => admin.can(),
  openLock,
  recordEvent,
};
