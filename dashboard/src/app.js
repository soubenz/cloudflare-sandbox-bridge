import { api, apiBase, eventsUrl, serviceUrl } from './api.js';
import { attachTerminal } from './terminal.js';

const $ = (id) => document.getElementById(id);

/**
 * The session is kept in localStorage so a reload, a closed tab or a
 * crashed browser comes back to the lab already running rather than to the
 * picker. Without it the only route back was starting again and hoping the
 * API recognised the caller, which it identifies by address — not stable
 * behind a proxy, and not stable at all for two people behind one NAT.
 */
const SESSION_STORAGE = 'opalix.session';

function rememberSession(session) {
  try {
    localStorage.setItem(SESSION_STORAGE, JSON.stringify(session));
  } catch {
    // Private mode or blocked storage: the console still works for this tab.
  }
}

function forgetSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE);
  } catch {
    /* nothing to clean up */
  }
}

function rememberedSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const state = {
  session: null, // { id, token, lab, urls }
  terminal: null,
  events: null, // EventSource
  expiresAt: null,
  eventCount: 0,
  openFile: null,
  editor: null,
  /** The open file has edits that have not been written back. */
  dirty: false,
  /** Counts edits, so a save knows whether more arrived while it was writing. */
  edits: 0,
  /** Directories expanded in the workspace list, by path relative to /workspace. */
  expanded: new Set(),
  /** The service whose UI is loaded in the iframe, so revisiting it does not reload it. */
  service: null,
  checksRunning: false,
  timer: 0,
  /** Operator mode: a service key the API accepted, in this tab. */
  admin: false,
  serviceKey: sessionStorage.getItem('opalix.serviceKey') || '',
};

// ------------------------------------------------------------------ toast

/**
 * Feedback for something the learner just did — a snapshot, a file that
 * would not save — where there is no panel of its own to say it in. It is
 * deliberately not a feed: lab events (pressure, hints) are never routed
 * here, only the result of a click.
 */
let toastTimer = 0;
function toast(message, tone = 'info') {
  const el = $('toast');
  $('toastText').textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), tone === 'bad' ? 10_000 : 5000);
}

// ---------------------------------------------------------------- launcher

/** The catalogue, kept so a running session can show its lab's context. */
const labsBySlug = new Map();

const DIFFICULTY_LEVEL = { intro: 1, core: 2, advanced: 3 };

/**
 * A launch error is shown inside the card that failed, so it has to be
 * moved back out before the list is rebuilt, or rebuilding it would take
 * the only #launchError element with it.
 */
function parkLaunchError() {
  const error = $('launchError');
  error.hidden = true;
  $('launcher').append(error);
}

function showLabSkeleton() {
  const list = $('labList');
  parkLaunchError();
  list.setAttribute('aria-busy', 'true');
  list.innerHTML =
    '<div class="lab-skeleton" aria-hidden="true"></div>'.repeat(3) + '<p class="sr-only">Loading labs…</p>';
}

async function loadLabs() {
  const list = $('labList');
  parkLaunchError();
  $('labCount').textContent = '';
  if (!list.querySelector('.lab-skeleton')) showLabSkeleton();
  try {
    const labs = await api.labs();
    list.innerHTML = '';
    if (!labs.length) {
      list.innerHTML =
        '<div class="empty-state"><p>No labs are published yet.</p><p class="muted small">Publish one with <code>opalix labs publish</code>, then reload.</p></div>';
      return;
    }
    $('labCount').textContent = `${labs.length} available`;
    for (const lab of labs) list.append(labCard(lab));
  } catch (err) {
    list.innerHTML = `
      <div class="empty-state">
        <p class="error"></p>
        <button class="btn" id="btnRetryLabs">Try again</button>
      </div>`;
    list.querySelector('.error').textContent = `Could not load labs — ${err.message}`;
    list.querySelector('#btnRetryLabs').addEventListener('click', () => {
      showLabSkeleton();
      loadLabs();
    });
  } finally {
    list.removeAttribute('aria-busy');
  }
}

function labCard(lab) {
  const row = document.createElement('article');
  row.className = 'lab';
  // The slug is the lab's identity. It is rendered inside .lab-sub as
  // prose, where "hello" is also a substring of "gateway-hello", so
  // carry it as an attribute too: that is what lets anything selecting
  // a row — a test, a deep link — name one lab rather than a family of
  // labs whose names happen to overlap.
  row.dataset.slug = lab.slug;
  const titleId = `lab-title-${lab.slug}`;
  row.setAttribute('aria-labelledby', titleId);
  row.innerHTML = `
    <div class="lab-meta">
      <h2 class="lab-title"></h2>
      <div class="lab-sub"></div>
      <p class="lab-summary"></p>
      <div class="lab-objectives-wrap">
        <p class="lab-objectives-label">You will practise</p>
        <ul class="lab-objectives"></ul>
      </div>
    </div>
    <button class="btn btn-primary lab-start">Start</button>`;
  const title = row.querySelector('.lab-title');
  title.id = titleId;
  title.textContent = lab.title;

  // Enough to choose a lab without spending a container to find out what
  // it is. The title alone never carried that — "Hello, sandbox" says
  // nothing about what you would actually do.
  const summary = row.querySelector('.lab-summary');
  summary.textContent = lab.summary ?? '';
  summary.hidden = !lab.summary;

  const objectives = row.querySelector('.lab-objectives');
  for (const objective of lab.objectives ?? []) {
    const li = document.createElement('li');
    li.textContent = objective;
    objectives.append(li);
  }
  row.querySelector('.lab-objectives-wrap').hidden = !(lab.objectives ?? []).length;

  // One fact per chip, but the row's text stays the plain
  // "slug@version · family · type · difficulty · N min" line that support
  // and the browser suite read: the separators are real text, only hidden
  // visually, so nothing that reads .lab-sub sees a different string.
  const facts = [
    ['id', `${lab.slug}@${lab.version}`],
    ['family', lab.family],
    ['type', lab.type],
  ];
  if (lab.difficulty) facts.push(['difficulty', lab.difficulty]);
  if (lab.timeout_minutes) facts.push(['time', `${lab.timeout_minutes} min`]);
  const sub = row.querySelector('.lab-sub');
  facts.forEach(([kind, text], i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ' · ';
      sep.setAttribute('aria-hidden', 'true');
      sub.append(sep);
    }
    const chip = document.createElement('span');
    chip.className = `chip chip-${kind}`;
    if (kind === 'difficulty') chip.dataset.level = String(DIFFICULTY_LEVEL[text] ?? 0);
    if (kind === 'time') chip.title = 'Hard time limit for the session';
    chip.textContent = text;
    sub.append(chip);
  });

  labsBySlug.set(lab.slug, lab);
  row.querySelector('button').addEventListener('click', () => startSession(lab.slug, row));
  return row;
}

async function startSession(slug, card) {
  const error = $('launchError');
  error.hidden = true;
  const buttons = document.querySelectorAll('.lab button');
  buttons.forEach((b) => (b.disabled = true));
  const button = card?.querySelector('button');
  if (button) {
    button.textContent = 'Starting…';
    button.setAttribute('aria-busy', 'true');
  }
  try {
    const started = await api.startSession(slug);
    state.lab = labsBySlug.get(slug) ?? null;
    state.session = { id: started.id, token: started.token, lab: slug, urls: started.urls };
    rememberSession(state.session);
    enterSession();
    // The start route hands back whatever session is already live rather
    // than refusing, which may be a different lab from the one clicked.
    // Say so; the header will show the real lab once the status arrives.
    if (started.rejoined) toast('You already had a lab running, so you are back in it. End it to start another.');
  } catch (err) {
    // Next to the card that was clicked, not at the foot of a long list
    // where it scrolled out of sight and the click looked like it did nothing.
    error.textContent = `Could not start this lab — ${err.message}`;
    (card ?? $('launcher')).append(error);
    error.hidden = false;
    error.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    if (button) {
      button.textContent = 'Start';
      button.removeAttribute('aria-busy');
    }
  }
}

// ---------------------------------------------------------------- session

function enterSession() {
  // Per-session, not per-page: without resetting these, starting a second
  // lab without a reload leaves the old session's panels on screen and
  // never attaches a terminal to the new one.
  runningHandled = false;
  state.expiresAt = null;
  stopExpiryTimer();
  state.openFile = null;
  state.dirty = false;
  state.expanded.clear();
  state.service = null;
  state.checksRunning = false;
  $('eventList').innerHTML = '';
  $('checksPanel').innerHTML = '<p class="muted small">Not run yet. Run checks to grade your work so far.</p>';
  $('checksSummary').textContent = '';
  delete $('checksSummary').dataset.tone;
  $('hintsPanel').innerHTML = '<p class="muted small">Hints unlock on a timer as the lab goes on.</p>';
  $('fileList').innerHTML = '';
  $('serviceTabs').innerHTML = '';
  $('serviceLabel').hidden = true;
  $('serviceFrame').removeAttribute('src');
  $('noticeList').innerHTML = '';
  $('noticeEmpty').hidden = false;
  $('editorPath').textContent = 'No file open';
  delete $('editorPath').dataset.dirty;
  $('editorStatus').textContent = '';
  $('btnSaveFile').disabled = true;
  $('endedBanner').hidden = true;
  $('termStatus').hidden = true;
  $('btnReconnectTerm').hidden = false;
  $('btnNewFile').disabled = false;
  $('expiryTimer').textContent = '';
  $('briefBody').innerHTML = '<p class="muted">Loading the brief…</p>';
  // The task, not an empty terminal: a learner arriving at a lab should be
  // looking at what they have been asked to do.
  showView('brief');
  showBoot('Claiming a container…');

  $('launcher').hidden = true;
  $('workspace').hidden = false;
  $('sessionBar').hidden = false;
  $('sessionActions').hidden = false;
  $('btnBackToLabs').hidden = true;
  // Deliberately does not touch the operator panel: resuming is async, and
  // forcing it closed here slammed it shut under anyone who opened it
  // while the console was still booting.

  setSessionLab(state.session.lab);
  $('sessionId').textContent = state.session.id;
  $('sessionId').title = `Session ${state.session.id}`;
  for (const id of ['btnChecks', 'btnSnapshot', 'btnEnd']) $(id).disabled = false;

  openEventStream();
  pollUntilRunning();
}

function openEventStream() {
  state.events?.close();
  const es = new EventSource(eventsUrl(state.session.id, state.session.token));
  state.events = es;

  // The API emits named events, so each type is subscribed individually
  // rather than read off a generic `message` handler.
  const types = [
    ['session.state', 'info'],
    ['session.expiring', 'warn'],
    ['session.idle_warning', 'warn'],
    ['service.health', 'info'],
    ['container.restarted', 'warn'],
    ['pressure', 'warn'],
    ['hint', 'warn'],
    ['check.started', 'info'],
    ['check.result', 'info'],
    ['check.finished', 'info'],
    ['snapshot.created', 'good'],
    ['cost', 'info'],
    ['llm.call', 'info'],
    ['alert', 'bad'],
  ];
  for (const [type, tone] of types) {
    es.addEventListener(type, (ev) => handleEvent(type, tone, parse(ev.data)));
  }
  // `metrics` fires every 30s; it updates the header rather than the log,
  // which would otherwise drown everything else.
  es.addEventListener('metrics', (ev) => {
    const data = parse(ev.data);
    // The API sends `cost_usd`; `cost.usd` is the older shape.
    const usd = data?.cost_usd ?? data?.cost?.usd;
    if (usd != null) $('sessionId').title = `Session ${state.session?.id ?? ''} · ≈ $${Number(usd).toFixed(4)} so far`;
  });
  es.onerror = () => addEvent('warn', 'stream', 'Event stream dropped; the browser will retry.');
}

function handleEvent(type, tone, data) {
  addEvent(tone, type, summarize(type, data));
  noticeFor(type, tone, data);
  bootProgress(type, data);

  if (type === 'session.state') {
    setStatePill(data.state);
    if (data.state === 'running') {
      onRunning();
    } else if (data.state === 'ended') {
      onEnded(data.reason);
    }
  }
  if (type === 'hint') renderHint(data);
  if (type === 'check.finished' || type === 'check.result') refreshChecks();
  if (type === 'container.restarted') onContainerRestarted();
}

/**
 * A replaced container is a new machine, and the API tells us so before it
 * has finished making it one: `container.restarted` is emitted first, and
 * only then does the session restore a snapshot or re-hydrate the lab
 * files, relaunch the services and reset the terminal, ending with
 * `session.state: running`.
 *
 * Refreshing the file list on `container.restarted` therefore listed a
 * workspace that was about to be wiped and rewritten, and `runningHandled`
 * then swallowed the `running` that followed — so the console showed an
 * empty workspace and a dead terminal for the rest of the session, with a
 * Reconnect button as the only way out. Re-arm instead, and let the
 * running handshake run again once the container is actually ready.
 */
function onContainerRestarted() {
  runningHandled = false;
  // The relay dropped the old terminal with the container it belonged to,
  // so this socket is gone whether or not it has noticed yet.
  state.terminal?.dispose();
  state.terminal = null;
  setTerminalStatus('closed', 'the container was replaced; reconnecting');
  pollUntilRunning();
}

function summarize(type, data) {
  if (!data) return '';
  switch (type) {
    case 'session.state':
      return data.reason ? `${data.state} (${data.reason})` : data.state;
    case 'service.health':
      return `${data.service}: ${data.health}`;
    case 'pressure':
      return `${data.title} — ${data.message}`;
    case 'hint':
      return data.text;
    case 'check.started':
      return `${data.total} check${data.total === 1 ? '' : 's'} running`;
    case 'check.result':
      return `${data.name}: ${data.pass ? 'pass' : 'fail'}`;
    case 'check.finished':
      return `${data.passed}/${data.total} passed`;
    case 'alert':
      return `${data.kind}${data.error ? `: ${data.error}` : ''}`;
    case 'cost':
      return `$${Number(data.usd ?? 0).toFixed(4)}`;
    default:
      return JSON.stringify(data).slice(0, 160);
  }
}

/**
 * The curated side of the event stream, for the "Lab activity" pane.
 *
 * The raw log is operations telemetry — state transitions, check progress,
 * metrics, cost. This is the part of the same stream that is about the lab
 * itself — pressure events, hints, warnings — as prose rather than rows.
 * The pane is operator-only (see setAdmin); a learner gets hints in the
 * Hints panel and nothing from this list.
 */
const LEARNER_NOTICES = {
  pressure: (d) => [d.title, d.message],
  hint: (d) => ['Hint', d.text],
  'session.expiring': (d) => ['Session ending soon', `About ${Math.round((d?.in_ms ?? 300000) / 60000)} minutes left.`],
  'session.idle_warning': () => ['Still there?', 'This session ends soon if nothing happens.'],
  'container.restarted': () => ['Container replaced', 'Your lab is being rebuilt; the terminal will reconnect.'],
  alert: (d) => ['Something went wrong', d.message ?? d.error ?? d.kind],
};

function noticeFor(type, tone, data) {
  // A service going unhealthy is the whole point of a break-fix lab, so it
  // is lab content. A service going healthy again is the reassurance that
  // matches it. Anything else about services is noise.
  if (type === 'service.health' && data?.health) {
    const bad = data.health !== 'healthy';
    return addNotice(bad ? 'bad' : 'good', `${data.service} is ${data.health}`, '');
  }
  const build = LEARNER_NOTICES[type];
  if (!build) return;
  const [title, detail] = build(data ?? {});
  addNotice(tone, title, detail);
}

function addNotice(tone, title, detail) {
  const li = document.createElement('li');
  li.className = `ev-${tone}`;
  li.innerHTML = `<span class="when"></span><span class="detail"><strong class="notice-title"></strong> <span class="notice-body"></span></span>`;
  li.querySelector('.when').textContent = new Date().toLocaleTimeString([], { hour12: false });
  li.querySelector('.notice-title').textContent = title;
  li.querySelector('.notice-body').textContent = detail ?? '';
  const list = $('noticeList');
  list.prepend(li);
  while (list.children.length > 100) list.lastElementChild.remove();
  $('noticeEmpty').hidden = true;
}

function addEvent(tone, what, detail) {
  const li = document.createElement('li');
  li.className = `ev-${tone}`;
  li.innerHTML = `<span class="when"></span><span class="what"></span><span class="detail"></span>`;
  li.querySelector('.when').textContent = new Date().toLocaleTimeString([], { hour12: false });
  li.querySelector('.what').textContent = what;
  li.querySelector('.detail').textContent = detail ?? '';
  const list = $('eventList');
  list.prepend(li);
  while (list.children.length > 300) list.lastElementChild.remove();
  $('eventCount').textContent = `${++state.eventCount}`;
}

// A restart can start a second poll while the first is still sleeping, and
// two loops racing the same session is how a terminal gets attached twice.
let polling = false;
const BOOT_DEADLINE_MS = 120_000;
async function pollUntilRunning() {
  if (polling) return;
  polling = true;
  const session = state.session;
  let lastError = null;
  let refused = false;
  try {
    const deadline = Date.now() + BOOT_DEADLINE_MS;
    while (Date.now() < deadline && state.session === session) {
      try {
        const status = await api.status(session.id, session.token);
        lastError = null;
        setStatePill(status.meta.state);
        if (status.meta.lab_slug) setSessionLab(status.meta.lab_slug);
        if (status.meta.state === 'running') return await onRunning(status);
        if (status.meta.state === 'ended') return onEnded(status.meta.end_reason);
      } catch (err) {
        // Usually transient, so the poll retries — but remember it, so a
        // start that never arrives can say what was actually going wrong.
        lastError = err;
        // A token the API refuses will not start working by asking again.
        if (/^(401|404):/.test(err.message)) {
          refused = true;
          break;
        }
      }
      await sleep(1500);
    }
    // The loop used to just stop here, leaving the boot modal spinning over
    // a console nobody could reach until they reloaded.
    if (state.session === session && !runningHandled) {
      bootFailed(
        refused
          ? `This session is no longer available (${lastError.message}). It may have ended or expired.`
          : lastError
            ? `The lab is not answering: ${lastError.message}`
            : 'The lab still is not running after two minutes. It may yet come up, or it may be stuck.',
        { canRetry: !refused }
      );
    }
  } finally {
    polling = false;
  }
}

let runningHandled = false;
async function onRunning(status) {
  if (runningHandled) return;
  runningHandled = true;

  bootStep('services', 'Attaching the terminal…');
  if (!state.terminal) {
    state.terminal = attachTerminal({
      container: $('term'),
      sessionId: state.session.id,
      token: state.session.token,
      onNotice: (text) => addEvent('warn', 'terminal', text),
      onStatus: setTerminalStatus,
    });
  }

  if (!status) {
    try {
      status = await api.status(state.session.id, state.session.token);
    } catch {
      status = { meta: {} };
    }
  }
  const meta = status.meta ?? {};
  if (meta.lab_slug) setSessionLab(meta.lab_slug);
  // A resumed session already has results; showing "Not run yet" over
  // them sent learners to re-run a check that takes minutes.
  if (status.checks && !state.checksRunning) renderChecks(status.checks);
  state.expiresAt = meta.expires_at ?? null;
  startExpiryTimer();
  renderServiceTabs();
  refreshFiles();
  loadBrief();
  bootStep('terminal');
  hideBoot();
}

/** The header's lab: its title where the catalogue has one, and always its slug. */
function setSessionLab(slug) {
  if (state.session && state.session.lab !== slug) {
    state.session.lab = slug;
    rememberSession(state.session);
  }
  const lab = labsBySlug.get(slug) ?? null;
  if (state.lab?.slug !== slug) state.lab = lab;
  $('sessionLab').textContent = slug;
  $('sessionTitle').textContent = lab?.title ?? '';
  $('sessionTitle').title = lab?.title ?? '';
}

/**
 * The lab's brief, which is the only place the learner is told what the
 * task is. It ships inside workspace.tgz and lands at /workspace/brief.md,
 * so it is read the same way as any other workspace file rather than
 * needing a route of its own.
 */
async function loadBrief() {
  const body = $('briefBody');
  // A resumed session never passed through the launcher, so the catalogue
  // has not been loaded and the lab's objectives would silently vanish on
  // exactly the path a learner uses most — coming back to their work.
  if (!state.lab && state.session) {
    try {
      const labs = await api.labs();
      for (const lab of labs) labsBySlug.set(lab.slug, lab);
      setSessionLab(state.session.lab);
    } catch {
      /* the brief is still worth showing without them */
    }
  }
  try {
    const { content } = await api.readFile(state.session.id, state.session.token, 'brief.md');
    body.innerHTML = objectivesHtml() + renderMarkdown(content);
  } catch (err) {
    // A missing brief and a brief that failed to load are different
    // problems; only the second is worth retrying.
    const missing = /^404:/.test(err.message);
    body.innerHTML = missing
      ? objectivesHtml() +
        '<p class="muted">This lab ships no <code>brief.md</code>, so there is nothing more to show here. ' +
        'Check the workspace files and the hints panel.</p>'
      : '<div class="empty-state"><p class="error"></p><button class="btn" id="btnRetryBrief">Try again</button></div>';
    if (!missing) {
      body.querySelector('.error').textContent = `Could not load the brief — ${err.message}`;
      body.querySelector('#btnRetryBrief').addEventListener('click', () => {
        body.innerHTML = '<p class="muted">Loading the brief…</p>';
        loadBrief();
      });
    }
  }
}

/** The lab's stated objectives, above its brief. Empty when it declares none. */
function objectivesHtml() {
  const objectives = state.lab?.objectives ?? [];
  if (!objectives.length) return '';
  const items = objectives
    .map((o) => `<li>${o.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])}</li>`)
    .join('');
  return `<section class="objectives"><h3>What you will practise</h3><ul>${items}</ul></section>`;
}

/**
 * Enough Markdown for a lab brief, and no more. Everything is escaped
 * first and only a fixed set of constructs is then re-introduced, so lab
 * content — which comes from a bundle, not from us — cannot inject markup
 * into the console.
 */
export function renderMarkdown(src) {
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const blocks = [];
  // Fenced code first, so nothing inside a fence is treated as markup.
  const fenced = esc(src).replace(/```[\w-]*\n([\s\S]*?)```/g, (_m, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const inline = (t) =>
    t
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const html = [];
  let list = null;
  let inTable = false;
  let firstRow = false;
  // Briefs are hard-wrapped at ~78 columns, and a paragraph is every line up
  // to the next blank one. Emitting a <p> per source line split every
  // sentence of every brief into its own spaced-out paragraph.
  let para = [];
  // A list item's text, held open so an indented wrapped line joins it.
  let item = null;
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushItem = () => {
    if (item !== null) html.push(`<li>${inline(item)}</li>`);
    item = null;
  };
  const closeList = () => {
    flushItem();
    if (list) { html.push(`</${list}>`); list = null; }
  };
  for (const raw of fenced.split('\n')) {
    const line = raw.trimEnd();
    const placeholder = line.match(/^\u0000(\d+)\u0000$/);
    if (placeholder) {
      flushPara();
      closeList();
      if (inTable) { html.push('</table>'); inTable = false; }
      html.push(blocks[Number(placeholder[1])]);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      if (inTable) { html.push('</table>'); inTable = false; }
      const level = Math.min(heading[1].length + 1, 5);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    // Tables: a `| a | b |` row, optionally preceded by a `|---|---|` rule.
    // Briefs use them for "what is running where", which resists prose.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      closeList();
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // the alignment rule
      if (!inTable) { html.push('<table>'); inTable = true; firstRow = true; }
      const tag = firstRow ? 'th' : 'td';
      html.push(`<tr>${cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`);
      firstRow = false;
      continue;
    }
    if (inTable) { html.push('</table>'); inTable = false; }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      flushItem();
      const want = bullet ? 'ul' : 'ol';
      if (list && list !== want) closeList();
      if (!list) { html.push(`<${want}>`); list = want; }
      item = (bullet ?? numbered)[1];
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    // An indented line straight after a list item is that item wrapping.
    if (item !== null && /^\s+\S/.test(line)) {
      item += ` ${line.trim()}`;
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  if (inTable) html.push('</table>');
  return html.join('\n');
}

/**
 * The start sequence already announces itself on the event stream, so the
 * modal follows those rather than inventing its own timeline — what it
 * shows is what the session is actually doing.
 */
function bootProgress(type, data) {
  if (type === 'session.state' && data?.state === 'starting') bootStep('container', 'Unpacking the workspace…');
  if (type === 'service.health') bootStep('workspace', `Starting ${data?.service ?? 'services'}…`);
  if (type === 'session.state' && data?.state === 'running') {
    bootStep('workspace');
    bootStep('services', 'Attaching the terminal…');
  }
  if (type === 'alert' && data?.kind?.startsWith?.('start')) bootFailed(data.message ?? data.kind);
  if (type === 'session.state' && data?.state === 'ended') bootFailed(`Session ended: ${data.reason ?? 'unknown'}`);
}

// ------------------------------------------------------------- boot modal

/**
 * A start claims a container, unpacks the workspace, launches every service
 * and waits on each healthcheck — measured at 2.5s warm and up to 30s cold.
 * Without this the console just sat there looking broken.
 */
function showBoot(detail) {
  $('bootModal').classList.remove('modal-failed');
  $('bootTitle').textContent = 'Starting your lab';
  $('bootError').hidden = true;
  $('bootActions').hidden = true;
  $('bootHint').hidden = false;
  $('bootDetail').textContent = detail;
  for (const li of $('bootSteps').children) li.removeAttribute('data-done');
  $('bootModal').hidden = false;
}

function bootStep(step, detail) {
  // A late progress event must not paper over a failure already shown.
  if ($('bootModal').hidden || $('bootModal').classList.contains('modal-failed')) return;
  const li = $('bootSteps').querySelector(`[data-step="${step}"]`);
  if (li) li.setAttribute('data-done', '1');
  if (detail) $('bootDetail').textContent = detail;
}

/**
 * A start that fails used to report it and then keep the modal up with its
 * spinner turning, over a console with no way out but a reload — which, on
 * a remembered session, put you straight back in the same modal. Stop the
 * spinner, say so, and offer the two things a learner can actually do.
 */
function bootFailed(message, { canRetry = false } = {}) {
  if ($('bootModal').hidden) return;
  // A failed start reports itself twice — the alert that says why, then
  // `session.state: ended` — and the first is the one worth reading.
  if ($('bootModal').classList.contains('modal-failed')) return;
  $('bootModal').classList.add('modal-failed');
  $('bootTitle').textContent = 'The lab did not start';
  $('bootError').textContent = message;
  $('bootError').hidden = false;
  $('bootHint').hidden = true;
  $('bootDetail').textContent = canRetry
    ? 'You can keep waiting, or go back and start it again.'
    : 'Go back to the labs and start it again.';
  $('btnBootRetry').hidden = !canRetry;
  $('bootActions').hidden = false;
  (canRetry ? $('btnBootRetry') : $('btnBootLabs')).focus();
}

function hideBoot() {
  $('bootModal').hidden = true;
}

/** Why a session ended, in words a learner can act on. */
const END_REASONS = {
  user: 'You ended this session.',
  idle: 'It ended because nothing happened in it for a while.',
  expired: 'It reached its time limit.',
  error: 'It stopped because of an error on our side.',
  evicted: 'Its container was reclaimed.',
};

function onEnded(reason) {
  setStatePill('ended');
  stopExpiryTimer();
  $('expiryTimer').textContent = reason ? `ended: ${reason}` : 'ended';
  delete $('expiryTimer').dataset.urgent;
  for (const id of ['btnChecks', 'btnSnapshot', 'btnEnd']) $(id).disabled = true;
  state.terminal?.dispose();
  state.terminal = null;
  state.events?.close();
  $('btnBackToLabs').hidden = false;
  $('sessionActions').hidden = true;
  // Said where the learner is looking, since the header pill alone is easy
  // to miss and the activity feed is not theirs to read.
  $('endedText').textContent =
    `This session has ended. ${END_REASONS[reason] ?? ''} Its container is gone, so the terminal and files ` +
    'are no longer available — go back to the labs to start again.';
  $('endedBanner').hidden = false;
  $('termStatusText').textContent = 'The session has ended, so there is no terminal to reconnect to.';
  $('btnReconnectTerm').hidden = true;
  $('termStatus').hidden = false;
  $('btnSaveFile').disabled = true;
  $('btnNewFile').disabled = true;
}

/** An ended session leaves a dead workspace on screen; this is the way out. */
function backToLabs() {
  forgetSession();
  state.session = null;
  state.dirty = false;
  state.terminal?.dispose();
  state.terminal = null;
  state.events?.close();
  stopExpiryTimer();
  hideBoot();
  $('btnBackToLabs').hidden = true;
  $('sessionBar').hidden = true;
  $('sessionActions').hidden = true;
  $('workspace').hidden = true;
  $('ops').hidden = true;
  $('btnOps').setAttribute('aria-pressed', 'false');
  $('launcher').hidden = false;
  $('expiryTimer').textContent = '';
  $('btnNewFile').disabled = false;
  loadLabs();
}

/** Shows why the terminal is blank, instead of leaving a black rectangle. */
function setTerminalStatus(status, detail) {
  const panel = $('termStatus');
  if (status === 'open') {
    panel.hidden = true;
    return;
  }
  $('termStatusText').textContent = detail ? `Terminal disconnected — ${detail}.` : 'Terminal disconnected.';
  $('btnReconnectTerm').hidden = false;
  panel.hidden = false;
}

function reconnectTerminal() {
  state.terminal?.dispose();
  state.terminal = null;
  $('termStatus').hidden = true;
  if (state.session) {
    state.terminal = attachTerminal({
      container: $('term'),
      sessionId: state.session.id,
      token: state.session.token,
      onNotice: (text) => addEvent('warn', 'terminal', text),
      onStatus: setTerminalStatus,
    });
  }
}

function setStatePill(value) {
  const pill = $('statePill');
  pill.textContent = value;
  pill.dataset.state = value;
}

/**
 * One interval per session. This used to start a fresh one every time the
 * session reached running — after each container restart, too — and never
 * stop any of them, so an ended session's header went on counting down
 * over the "ended" it had just been told to show.
 */
function startExpiryTimer() {
  stopExpiryTimer();
  const tick = () => {
    if (!state.expiresAt) return;
    const left = state.expiresAt - Date.now();
    const el = $('expiryTimer');
    if (left <= 0) {
      el.textContent = 'expired';
      el.dataset.urgent = '2';
      return;
    }
    const mins = Math.floor(left / 60_000);
    const secs = Math.floor((left % 60_000) / 1000);
    el.textContent = `${mins}:${String(secs).padStart(2, '0')} left`;
    el.dataset.urgent = left < 60_000 ? '2' : left < 5 * 60_000 ? '1' : '0';
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

function stopExpiryTimer() {
  clearInterval(state.timer);
  state.timer = 0;
}

// ---------------------------------------------------------------- checks

async function refreshChecks() {
  // A run the learner started renders its own result when it returns;
  // the per-check events arriving meanwhile would otherwise replace the
  // "running" state with the previous run's results.
  if (state.checksRunning || !state.session) return;
  try {
    const status = await api.status(state.session.id, state.session.token);
    renderChecks(status.checks);
  } catch {
    /* the event that triggered this will come again */
  }
}

/**
 * Checks can take minutes (a Real-mode lab runs its agent once per check),
 * and the only sign one was running used to be a greyed-out button. Say
 * so in the panel where the results will land.
 */
async function runChecks() {
  const button = $('btnChecks');
  const panel = $('checksPanel');
  state.checksRunning = true;
  button.disabled = true;
  button.textContent = 'Running…';
  button.setAttribute('aria-busy', 'true');
  const previous = panel.querySelector('.check') ? panel.innerHTML : '';
  panel.innerHTML = `
    <div class="inline-status">
      <span class="spinner spinner-sm" aria-hidden="true"></span>
      <span class="small">Running checks — this can take a few minutes.</span>
    </div>`;
  $('checksSummary').textContent = '';
  try {
    const run = await api.runChecks(state.session.id, state.session.token);
    state.checksRunning = false;
    renderChecks(run);
  } catch (err) {
    state.checksRunning = false;
    addEvent('bad', 'checks', err.message);
    // Where the learner is looking, rather than only in the operator log.
    panel.innerHTML = `${previous}<p class="notice notice-bad small" role="alert"></p>`;
    panel.querySelector('.notice').textContent = `The checks could not run — ${err.message}`;
  } finally {
    state.checksRunning = false;
    button.textContent = 'Run checks';
    button.removeAttribute('aria-busy');
    button.disabled = !state.session || $('statePill').dataset.state === 'ended';
  }
}

function renderChecks(run) {
  const panel = $('checksPanel');
  const summary = $('checksSummary');
  if (!run?.results?.length) {
    panel.innerHTML = '<p class="muted small">Not run yet. Run checks to grade your work so far.</p>';
    summary.textContent = '';
    delete summary.dataset.tone;
    return;
  }
  const passed = run.results.filter((r) => r.pass).length;
  const total = run.results.length;
  summary.textContent = `${passed}/${total} passing`;
  summary.dataset.tone = passed === total ? 'good' : passed ? 'warn' : 'bad';

  panel.innerHTML = '';
  for (const r of run.results) {
    const row = document.createElement('div');
    row.className = `check ${r.pass ? 'check-pass' : 'check-fail'}`;
    row.innerHTML = `<span class="check-mark" aria-hidden="true"></span><span class="check-msg"><span class="sr-only"></span><strong class="check-name"></strong> <span class="check-detail"></span></span>`;
    // Icon plus text, never colour alone.
    row.querySelector('.check-mark').textContent = r.pass ? '✓' : '✗';
    row.querySelector('.sr-only').textContent = r.pass ? 'Passed: ' : 'Failed: ';
    row.querySelector('.check-name').textContent = r.name;
    row.querySelector('.check-detail').textContent = `— ${r.timed_out ? '(timed out) ' : ''}${r.message}`;
    panel.append(row);
  }
  if (run.finished_at) {
    const when = document.createElement('p');
    when.className = 'muted small check-when';
    when.textContent = `Last run ${new Date(run.finished_at).toLocaleTimeString([], { hour12: false })}`;
    panel.append(when);
  }
}

function renderHint(data) {
  const panel = $('hintsPanel');
  if (panel.querySelector('.muted')) panel.innerHTML = '';
  // A replayed stream sends the same hint again; show each one once.
  const key = String(data.index ?? data.text);
  if (panel.querySelector(`[data-hint="${CSS.escape(key)}"]`)) return;
  const box = document.createElement('div');
  box.className = 'hint';
  box.dataset.hint = key;
  const label = document.createElement('div');
  label.className = 'hint-label';
  label.textContent = data.index != null ? `Hint ${Number(data.index) + 1}` : 'Hint';
  const text = document.createElement('div');
  text.textContent = data.text;
  box.append(label, text);
  panel.append(box);
}

// ---------------------------------------------------------------- files

/**
 * The workspace as a flat list with expandable directories.
 *
 * Directories used to be listed with a ▸ and do nothing when clicked, so
 * anything a lab kept in a subdirectory — which is most of the code in
 * most labs (agent/, services/) — could not be opened in the editor at
 * all. Each expanded directory is listed on demand and shown indented
 * under its parent; the list stays one level of <li> so a row is still
 * one file.
 */
async function refreshFiles() {
  if (!state.session) return;
  const list = $('fileList');
  const button = $('btnRefreshFiles');
  if (!list.children.length) list.innerHTML = '<li class="muted">loading…</li>';
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  try {
    const rows = await listTree('');
    list.innerHTML = '';
    for (const row of rows) list.append(fileRow(row));
    if (!rows.length) list.innerHTML = '<li class="muted">empty</li>';
  } catch (err) {
    list.innerHTML = '<li class="error"></li>';
    list.querySelector('li').textContent = `Could not list files — ${err.message}`;
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

/** Lists `dir` and, depth first, every expanded directory beneath it. */
async function listTree(dir, depth = 0) {
  const path = dir ? `/workspace/${dir}` : '/workspace';
  const entries = normalizeFiles(await api.listFiles(state.session.id, state.session.token, path));
  const rows = [];
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    const open = entry.isDirectory && state.expanded.has(rel);
    rows.push({ ...entry, path: rel, depth, open });
    if (open) {
      try {
        rows.push(...(await listTree(rel, depth + 1)));
      } catch {
        // A directory that vanished (or cannot be read) folds back up
        // rather than failing the whole list.
        state.expanded.delete(rel);
        rows[rows.length - 1].open = false;
      }
    }
  }
  return rows;
}

function fileRow(entry) {
  const li = document.createElement('li');
  li.dataset.path = entry.path;
  li.style.setProperty('--depth', entry.depth);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `file${entry.isDirectory ? ' file-dir' : ''}`;
  button.innerHTML = `<span class="twisty" aria-hidden="true"></span><span class="name"></span><span class="size"></span>`;
  button.querySelector('.twisty').textContent = entry.isDirectory ? (entry.open ? '▾' : '▸') : '';
  button.querySelector('.name').textContent = entry.name;
  button.querySelector('.size').textContent = entry.isDirectory ? '' : formatSize(entry.size);
  if (entry.isDirectory) {
    button.setAttribute('aria-expanded', String(entry.open));
    button.title = `/workspace/${entry.path}/`;
    button.addEventListener('click', () => toggleDir(entry.path));
  } else {
    button.title = `/workspace/${entry.path}`;
    button.addEventListener('click', () => openFile(entry.path));
    if (entry.path === state.openFile) li.setAttribute('aria-selected', 'true');
  }
  li.append(button);
  return li;
}

function toggleDir(path) {
  if (state.expanded.has(path)) {
    // Collapsing forgets the subtree too, so re-expanding shows one level.
    for (const p of [...state.expanded]) if (p === path || p.startsWith(`${path}/`)) state.expanded.delete(p);
  } else {
    state.expanded.add(path);
  }
  return refreshFiles().then(() => {
    $('fileList').querySelector(`li[data-path="${CSS.escape(path)}"] button`)?.focus();
  });
}

/** The API returns the SDK's listing shape; tolerate either a bare array or {files:[…]}. */
function normalizeFiles(result) {
  const raw = Array.isArray(result) ? result : (result?.files ?? []);
  return raw
    .map((f) => ({
      name: (f.name ?? f.path ?? '').replace(/^.*\//, ''),
      size: f.size ?? 0,
      isDirectory: Boolean(f.isDirectory ?? f.is_directory ?? f.type === 'directory'),
    }))
    .filter((f) => f.name)
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

/** Created on first use: a session that never opens a file loads no editor. */
async function ensureEditor() {
  if (state.editor) return state.editor;
  try {
    // Imported here, not at the top: CodeMirror is the single largest
    // thing the console can load, and a session that never opens a file
    // has no use for it.
    const { createEditor } = await import('./editor.js');
    state.editor = await createEditor($('editorMount'), {
      onChange: () => {
        state.edits++;
        setDirty(true);
      },
      onSave: saveFile,
    });
    $('editorEmpty').hidden = true;
  } catch (err) {
    setEditorStatus(`The editor failed to load — ${err.message}`, 'bad');
  }
  return state.editor;
}

function setEditorStatus(text, tone) {
  const el = $('editorStatus');
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

function setDirty(dirty) {
  state.dirty = dirty;
  if (dirty) {
    $('editorPath').dataset.dirty = '1';
    setEditorStatus('unsaved', 'warn');
  } else {
    delete $('editorPath').dataset.dirty;
  }
}

async function openFile(name) {
  if (state.dirty && state.openFile && name !== state.openFile) {
    // Opening another file replaces the buffer, and unsaved edits went
    // with it without a word — under a timer, that is lost work.
    if (!confirm(`${state.openFile} has unsaved changes. Discard them and open ${name}?`)) return;
  }
  // Switch first and say what is happening: a slow read used to leave the
  // click looking ignored, and an error landed on a view nobody was on.
  showView('editor');
  setEditorStatus(`Opening ${name}…`);
  try {
    const result = await api.readFile(state.session.id, state.session.token, name);
    const editor = await ensureEditor();
    if (!editor) return;
    state.openFile = name;
    $('editorPath').textContent = name;
    $('editorPath').title = `/workspace/${name}`;
    await editor.load(result.content ?? '', name);
    setDirty(false);
    $('btnSaveFile').disabled = false;
    setEditorStatus('');
    for (const li of $('fileList').children) {
      if (li.dataset.path !== undefined) li.setAttribute('aria-selected', String(li.dataset.path === name));
    }
    if ($('viewEditor').classList.contains('view-active')) editor.focus();
  } catch (err) {
    setEditorStatus(`Could not open ${name} — ${err.message}`, 'bad');
  }
}

/**
 * Creates an empty file in /workspace and opens it. Without this the
 * console could only edit files a lab already shipped — and the first
 * fixture lab's whole task is to produce a file that does not exist yet,
 * so the lab was unsolvable from the browser.
 */
async function newFile() {
  const name = prompt('New file — a path inside /workspace, e.g. notes.txt or agent/fix.py');
  if (!name) return;

  const clean = name.trim().replace(/^\/+/, '');
  if (!clean || clean.includes('..')) {
    showFileError('Give a name inside /workspace, without "..".');
    return;
  }

  try {
    await api.writeFile(state.session.id, state.session.token, clean, '');
    // A file made inside a folder should be visible once it exists.
    const parts = clean.split('/').slice(0, -1);
    parts.forEach((_, i) => state.expanded.add(parts.slice(0, i + 1).join('/')));
    await refreshFiles();
    await openFile(clean);
  } catch (err) {
    showFileError(`Could not create ${clean} — ${err.message}`);
  }
}

let fileErrorTimer = 0;
function showFileError(message) {
  const el = $('fileError');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(fileErrorTimer);
  fileErrorTimer = setTimeout(() => (el.hidden = true), 8000);
}

let saving = false;
async function saveFile() {
  if (!state.openFile || saving || !state.session) return;
  saving = true;
  const name = state.openFile;
  $('btnSaveFile').disabled = true;
  setEditorStatus('saving…');
  try {
    const edits = state.edits;
    await api.writeFile(state.session.id, state.session.token, name, state.editor?.value() ?? '');
    // Typing while the write was in flight made new edits that were not
    // part of it, so those are still unsaved.
    if (state.openFile === name && state.edits === edits) {
      setDirty(false);
      setEditorStatus('saved', 'good');
    }
    refreshFiles();
  } catch (err) {
    // Still dirty: the edit exists only in this tab.
    setEditorStatus(`Not saved — ${err.message}`, 'bad');
  } finally {
    saving = false;
    $('btnSaveFile').disabled = !state.session || $('statePill').dataset.state === 'ended';
  }
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} K`;
  return `${(bytes / 1024 / 1024).toFixed(1)} M`;
}

// ---------------------------------------------------------------- services

function renderServiceTabs() {
  const host = $('serviceTabs');
  host.innerHTML = '';
  const services = state.session.urls?.services ?? {};
  const names = Object.keys(services);
  $('serviceLabel').hidden = !names.length;
  for (const name of names) {
    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', 'viewService');
    tab.title = `Open the ${name} service`;
    tab.textContent = name;
    tab.addEventListener('click', () => openService(name, tab));
    host.append(tab);
  }
}

/**
 * Points the iframe at a service — only when it is not already showing
 * that one. Re-pointing it on every tab click reloaded the service's UI
 * each time the learner came back from the terminal, and threw away
 * wherever they had navigated to inside it.
 */
function openService(name, tab, { reload = false } = {}) {
  const frame = $('serviceFrame');
  // The proxy takes ?token= on the first hit and redirects to a cookie,
  // so the iframe is pointed at the tokenised URL when it (re)loads.
  const url = serviceUrl(state.session.id, state.session.token, name);
  $('serviceName').textContent = name;
  $('serviceOpen').href = url;
  if (reload || state.service !== name || !frame.getAttribute('src')) {
    state.service = name;
    $('serviceLoadingText').textContent = `Loading ${name}…`;
    $('serviceLoading').hidden = false;
    $('serviceStatus').textContent = '';
    frame.src = url;
  }
  showView('service', tab);
}

function showView(view, tabEl) {
  for (const el of document.querySelectorAll('.view')) el.classList.remove('view-active');
  for (const el of document.querySelectorAll('.tab')) {
    el.classList.remove('tab-active');
    el.setAttribute('aria-selected', 'false');
  }

  // Every tab's `data-view` must have an entry here. Adding the Brief tab
  // without one made `$(undefined)` null and threw on `.classList`, which
  // enterSession swallowed into the launcher's error line — so no lab could
  // be started at all. Fail loudly instead of dereferencing null.
  const map = { brief: 'viewBrief', terminal: 'viewTerminal', editor: 'viewEditor', service: 'viewService' };
  const target = map[view] && $(map[view]);
  if (!target) throw new Error(`showView: no view registered for "${view}"`);
  target.classList.add('view-active');
  const tab = tabEl ?? document.querySelector(`.tab[data-view="${view}"]`);
  tab?.classList.add('tab-active');
  tab?.setAttribute('aria-selected', 'true');
  if (view === 'terminal') {
    state.terminal?.refit();
    // Switching to the terminal is switching to typing in it.
    state.terminal?.focus();
  }
}

// ---------------------------------------------------------------- operator

async function refreshPools() {
  const host = $('poolTiles');
  try {
    const pools = await api.pools(state.serviceKey || undefined);
    host.innerHTML = '';
    for (const [family, pool] of Object.entries(pools)) {
      host.append(poolTile(family, pool));
    }
    // GET /pools answers only to the service key, so a 200 here is proof
    // the key in this tab is real — which is what operator mode means.
    setAdmin(Boolean(state.serviceKey));
  } catch (err) {
    host.innerHTML = '<p class="error"></p>';
    host.querySelector('p').textContent = err.message;
    if (/^401:/.test(err.message)) setAdmin(false);
  }
}

/**
 * Operator mode, which is the only thing that shows the lab activity pane.
 *
 * That pane is the learner-facing half of the event stream — pressure
 * events, hints, warnings — and it is not for a learner to watch: it is
 * shown only once a service key the API accepts has been pasted into the
 * Operator panel in this tab. There is no second switch; the key the
 * operator panel already asked for is the switch. Note this hides the
 * pane, it does not withhold the events: they still reach the browser on
 * the session's own stream.
 */
function setAdmin(on) {
  state.admin = on;
  $('activityPane').hidden = !on;
  $('workspace').classList.toggle('has-activity', on);
  $('btnOps').classList.toggle('btn-admin', on);
  $('btnOps').title = on ? 'Operator mode is on in this tab' : '';
  // The raw event stream is everything the curated activity pane is, plus
  // the telemetry a learner has no use for -- gating one and not the other
  // would mean clicking Operator (which needs no key at all) shows more
  // than the key-gated pane does. Same switch, same condition.
  $('eventStreamBlock').hidden = !on;
  $('eventStreamLocked').hidden = on;
}

function poolTile(family, pool) {
  // GET /pools reports warm and claimed as counts, not collections.
  const warm = pool.warm ?? 0;
  const claimed = pool.claimed ?? 0;
  const stats = pool.stats ?? {};
  const hitRate = stats.claims ? Math.round((stats.warm_hits / stats.claims) * 100) : null;

  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.innerHTML = `
    <div class="tile-label"></div>
    <div class="tile-value"></div>
    <div class="tile-sub"></div>
    <div class="tile-actions">
      <button class="btn btn-tiny" data-act="prime">Prime +1</button>
      <button class="btn btn-tiny" data-act="drain">Drain</button>
    </div>`;
  tile.querySelector('.tile-label').textContent = `${family} pool`;
  tile.querySelector('.tile-value').textContent = `${warm} warm`;
  tile.querySelector('.tile-sub').textContent =
    `${claimed} claimed · target ${pool.config?.target ?? '?'}` +
    (hitRate === null ? '' : ` · ${hitRate}% warm hits of ${stats.claims}`);

  tile.querySelector('[data-act="prime"]').addEventListener('click', async () => {
    await withKey(() => api.primePool(family, (pool.config?.target ?? 0) + 1, state.serviceKey));
  });
  tile.querySelector('[data-act="drain"]').addEventListener('click', async () => {
    await withKey(() => api.drainPool(family, state.serviceKey));
  });
  return tile;
}

async function withKey(fn) {
  if (!state.serviceKey) {
    $('opsKeyStatus').textContent = 'Prime and drain need the service key.';
    return;
  }
  try {
    await fn();
    $('opsKeyStatus').textContent = 'done';
    refreshPools();
  } catch (err) {
    $('opsKeyStatus').textContent = err.message;
  }
}

// ---------------------------------------------------------------- wiring

$('btnChecks').addEventListener('click', runChecks);

// A snapshot used to report nothing to the learner either way: success was
// silent and failure went only to the operator's log.
$('btnSnapshot').addEventListener('click', async () => {
  const button = $('btnSnapshot');
  button.disabled = true;
  button.textContent = 'Saving…';
  button.setAttribute('aria-busy', 'true');
  try {
    await api.snapshot(state.session.id, state.session.token);
    toast(`Snapshot saved at ${new Date().toLocaleTimeString([], { hour12: false })}.`, 'good');
  } catch (err) {
    addEvent('bad', 'snapshot', err.message);
    toast(`Snapshot failed — ${err.message}`, 'bad');
  } finally {
    button.textContent = 'Snapshot';
    button.removeAttribute('aria-busy');
    button.disabled = !state.session || $('statePill').dataset.state === 'ended';
  }
});

$('btnEnd').addEventListener('click', async () => {
  const unsaved = state.dirty && state.openFile ? ` Your unsaved changes to ${state.openFile} will be lost.` : '';
  if (!confirm(`End this session? The container is destroyed.${unsaved}`)) return;
  const btn = $('btnEnd');
  btn.disabled = true;
  btn.textContent = 'Ending…';
  try {
    await api.end(state.session.id, state.session.token, false);
  } catch (err) {
    // Say so, but still go home: the container is gone or was never there,
    // and leaving a dead workspace on screen helps nobody.
    addEvent('bad', 'end', err.message);
    addNotice('bad', 'Could not end cleanly', err.message);
    toast(`The session may not have ended cleanly — ${err.message}`, 'bad');
  } finally {
    btn.textContent = 'End session';
  }
  // Ending is a deliberate act with an obvious next step, so take it —
  // rather than parking the learner in a dead workspace behind one more
  // button. A session that ends *on its own* (idle, expiry, error) still
  // stops here and explains itself, because being teleported away from
  // your work without being told why is worse than an extra click.
  onEnded('user');
  backToLabs();
});

$('btnBackToLabs').addEventListener('click', backToLabs);

$('btnOps').addEventListener('click', () => {
  const showing = $('ops').hidden;
  $('ops').hidden = !showing;
  $('btnOps').setAttribute('aria-pressed', String(showing));
  $('workspace').hidden = showing || !state.session;
  $('launcher').hidden = showing || Boolean(state.session);
  if (showing) refreshPools();
});

$('btnSaveKey').addEventListener('click', () => {
  state.serviceKey = $('opsKey').value.trim();
  sessionStorage.setItem('opalix.serviceKey', state.serviceKey);
  $('opsKeyStatus').textContent = state.serviceKey ? 'key set for this tab' : 'cleared';
  if (!state.serviceKey) setAdmin(false);
  refreshPools();
});

$('btnRefreshFiles').addEventListener('click', refreshFiles);
$('btnNewFile').addEventListener('click', newFile);
$('btnReconnectTerm').addEventListener('click', reconnectTerminal);
$('btnSaveFile').addEventListener('click', saveFile);

for (const tab of document.querySelectorAll('.tab[data-view]')) {
  tab.addEventListener('click', () => {
    showView(tab.dataset.view, tab);
    if (tab.dataset.view === 'editor' && state.openFile) state.editor?.focus();
  });
}

// Boot modal ways out.
$('btnBootLabs').addEventListener('click', backToLabs);
$('btnBootRetry').addEventListener('click', () => {
  showBoot('Still waiting for the lab to come up…');
  $('bootSteps').querySelector('[data-step="container"]')?.setAttribute('data-done', '1');
  pollUntilRunning();
});

// Service view.
$('serviceFrame').addEventListener('load', () => {
  $('serviceLoading').hidden = true;
});
$('btnServiceReload').addEventListener('click', () => {
  if (state.service) openService(state.service, $('serviceTabs').querySelector('.tab-active') ?? undefined, { reload: true });
});

$('btnToastClose').addEventListener('click', () => ($('toast').hidden = true));

// The browser's own "leave site?" prompt, only while there is something to lose.
window.addEventListener('beforeunload', (event) => {
  if (state.dirty && state.session) event.preventDefault();
});

$('saveShortcut').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S';
$('apiLabel').textContent = apiBase();
// A key pasted earlier in this tab turns operator mode back on after a
// reload, once the API has confirmed it still accepts it.
if (state.serviceKey) refreshPools();
resumeOrShowLabs();

/**
 * On load, try the session this browser was last in. A session that has
 * ended (or whose token has expired) falls back to the picker rather than
 * leaving a dead workspace on screen.
 */
async function resumeOrShowLabs() {
  try {
    const saved = rememberedSession();
    if (!saved?.id || !saved?.token) return await loadLabs();

    const status = await api.status(saved.id, saved.token);
    if (status.meta.state === 'ended') {
      forgetSession();
      return await loadLabs();
    }
    state.session = saved;
    enterSession();
  } catch {
    forgetSession();
    await loadLabs();
  } finally {
    // Says the console has finished deciding between resuming a session
    // and showing the picker. Anything that races that decision — a test,
    // or a person clicking straight away — can wait for it.
    document.body.dataset.booted = '1';
  }
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
