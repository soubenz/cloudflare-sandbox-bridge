import { api, apiBase, setApiBase, eventsUrl, serviceUrl } from './api.js';
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
  serviceKey: sessionStorage.getItem('opalix.serviceKey') || '',
};

// ---------------------------------------------------------------- launcher

/** The catalogue, kept so a running session can show its lab's context. */
const labsBySlug = new Map();

async function loadLabs() {
  try {
    const labs = await api.labs();
    $('labList').innerHTML = '';
    if (!labs.length) {
      $('labList').innerHTML = '<p class="muted">No labs published.</p>';
      return;
    }
    for (const lab of labs) {
      const row = document.createElement('div');
      row.className = 'lab';
      // The slug is the lab's identity. It is rendered inside .lab-sub as
      // prose, where "hello" is also a substring of "gateway-hello", so
      // carry it as an attribute too: that is what lets anything selecting
      // a row — a test, a deep link — name one lab rather than a family of
      // labs whose names happen to overlap.
      row.dataset.slug = lab.slug;
      row.innerHTML = `
        <div class="lab-meta">
          <div class="lab-title"></div>
          <p class="lab-summary"></p>
          <ul class="lab-objectives"></ul>
          <div class="lab-sub"></div>
        </div>
        <button class="btn">Start</button>`;
      row.querySelector('.lab-title').textContent = lab.title;

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
      objectives.hidden = !(lab.objectives ?? []).length;

      const facts = [`${lab.slug}@${lab.version}`, lab.family, lab.type];
      if (lab.difficulty) facts.push(lab.difficulty);
      if (lab.timeout_minutes) facts.push(`${lab.timeout_minutes} min`);
      row.querySelector('.lab-sub').textContent = facts.join(' · ');
      labsBySlug.set(lab.slug, lab);
      row.querySelector('button').addEventListener('click', () => startSession(lab.slug));
      $('labList').append(row);
    }
  } catch (err) {
    $('labList').innerHTML = `<p class="error"></p>`;
    $('labList').querySelector('p').textContent = `Could not load labs — ${err.message}`;
  }
}

async function startSession(slug) {
  $('launchError').hidden = true;
  const buttons = document.querySelectorAll('.lab button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const started = await api.startSession(slug);
    state.lab = labsBySlug.get(slug) ?? null;
    state.session = { id: started.id, token: started.token, lab: slug, urls: started.urls };
    rememberSession(state.session);
    enterSession();
  } catch (err) {
    $('launchError').textContent = err.message;
    $('launchError').hidden = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---------------------------------------------------------------- session

function enterSession() {
  // Per-session, not per-page: without resetting these, starting a second
  // lab without a reload leaves the old session's panels on screen and
  // never attaches a terminal to the new one.
  runningHandled = false;
  state.expiresAt = null;
  state.openFile = null;
  $('eventList').innerHTML = '';
  $('checksPanel').innerHTML = '<p class="muted small">Not run yet.</p>';
  $('hintsPanel').innerHTML = '<p class="muted small">Hints unlock on a timer.</p>';
  $('fileList').innerHTML = '';
  $('serviceTabs').innerHTML = '';
  $('noticeList').innerHTML = '';
  $('noticeEmpty').hidden = false;
  $('editorPath').textContent = 'No file open';
  $('btnSaveFile').disabled = true;
  $('briefBody').innerHTML = '<p class="muted">Loading the brief…</p>';
  // The task, not an empty terminal: a learner arriving at a lab should be
  // looking at what they have been asked to do.
  showView('brief');
  showBoot('Claiming a container…');

  $('launcher').hidden = true;
  $('workspace').hidden = false;
  $('sessionBar').hidden = false;
  // Deliberately does not touch the operator panel: resuming is async, and
  // forcing it closed here slammed it shut under anyone who opened it
  // while the console was still booting.

  $('sessionLab').textContent = state.session.lab;
  $('sessionId').textContent = state.session.id;
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
    if (data?.cost?.usd != null) $('sessionId').title = `≈ $${Number(data.cost.usd).toFixed(4)} so far`;
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
 * The learner's side of the event stream.
 *
 * The raw log is operations telemetry — state transitions, check progress,
 * metrics, cost — and reading it is not part of doing a lab. But some of
 * what arrives on the same stream *is* the lab: a pressure event is the
 * thing the learner is supposed to react to, and a hint is content they
 * were promised. Those are shown here as prose, with the event type and
 * timestamp left in the operator view where they belong.
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
async function pollUntilRunning() {
  if (polling) return;
  polling = true;
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && state.session) {
      try {
        const status = await api.status(state.session.id, state.session.token);
        setStatePill(status.meta.state);
        if (status.meta.state === 'running') return await onRunning(status);
        if (status.meta.state === 'ended') return onEnded(status.meta.end_reason);
      } catch {
        /* transient; the poll retries */
      }
      await sleep(1500);
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

  const meta = (status ?? (await api.status(state.session.id, state.session.token))).meta;
  state.expiresAt = meta.expires_at ?? null;
  startExpiryTimer();
  renderServiceTabs();
  refreshFiles();
  loadBrief();
  bootStep('terminal');
  hideBoot();
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
      state.lab = labsBySlug.get(state.session.lab) ?? null;
    } catch {
      /* the brief is still worth showing without them */
    }
  }
  try {
    const { content } = await api.readFile(state.session.id, state.session.token, 'brief.md');
    body.innerHTML = objectivesHtml() + renderMarkdown(content);
  } catch {
    body.innerHTML =
      '<p class="muted">This lab ships no <code>brief.md</code>, so there is nothing to show here. ' +
      'Check the workspace files and the hints panel.</p>';
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
  for (const raw of fenced.split('\n')) {
    const line = raw.trimEnd();
    const placeholder = line.match(/^\u0000(\d+)\u0000$/);
    if (placeholder) {
      if (list) { html.push(`</${list}>`); list = null; }
      if (inTable) { html.push('</table>'); inTable = false; }
      html.push(blocks[Number(placeholder[1])]);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      if (list) { html.push(`</${list}>`); list = null; }
      if (inTable) { html.push('</table>'); inTable = false; }
      const level = Math.min(heading[1].length + 1, 5);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    // Tables: a `| a | b |` row, optionally preceded by a `|---|---|` rule.
    // Briefs use them for "what is running where", which resists prose.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (list) { html.push(`</${list}>`); list = null; }
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
      const want = bullet ? 'ul' : 'ol';
      if (list && list !== want) { html.push(`</${list}>`); list = null; }
      if (!list) { html.push(`<${want}>`); list = want; }
      html.push(`<li>${inline((bullet ?? numbered)[1])}</li>`);
      continue;
    }
    if (list) { html.push(`</${list}>`); list = null; }
    if (line.trim()) html.push(`<p>${inline(line)}</p>`);
  }
  if (list) html.push(`</${list}>`);
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
  $('bootError').hidden = true;
  $('bootDetail').textContent = detail;
  for (const li of $('bootSteps').children) li.removeAttribute('data-done');
  $('bootModal').hidden = false;
}

function bootStep(step, detail) {
  if ($('bootModal').hidden) return;
  const li = $('bootSteps').querySelector(`[data-step="${step}"]`);
  if (li) li.setAttribute('data-done', '1');
  if (detail) $('bootDetail').textContent = detail;
}

function bootFailed(message) {
  if ($('bootModal').hidden) return;
  $('bootError').textContent = message;
  $('bootError').hidden = false;
  $('bootDetail').textContent = 'The lab did not start.';
}

function hideBoot() {
  $('bootModal').hidden = true;
}

function onEnded(reason) {
  setStatePill('ended');
  $('expiryTimer').textContent = reason ? `ended: ${reason}` : 'ended';
  for (const id of ['btnChecks', 'btnSnapshot', 'btnEnd']) $(id).disabled = true;
  state.terminal?.dispose();
  state.terminal = null;
  state.events?.close();
  $('btnBackToLabs').hidden = false;
}

/** An ended session leaves a dead workspace on screen; this is the way out. */
function backToLabs() {
  forgetSession();
  state.session = null;
  state.terminal?.dispose();
  state.terminal = null;
  state.events?.close();
  $('btnBackToLabs').hidden = true;
  $('sessionBar').hidden = true;
  $('workspace').hidden = true;
  $('ops').hidden = true;
  $('btnOps').setAttribute('aria-pressed', 'false');
  $('launcher').hidden = false;
  $('expiryTimer').textContent = '';
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

function startExpiryTimer() {
  const tick = () => {
    if (!state.expiresAt) return;
    const left = state.expiresAt - Date.now();
    const el = $('expiryTimer');
    if (left <= 0) {
      el.textContent = 'expired';
      return;
    }
    const mins = Math.floor(left / 60_000);
    const secs = Math.floor((left % 60_000) / 1000);
    el.textContent = `${mins}:${String(secs).padStart(2, '0')} left`;
    el.dataset.urgent = left < 5 * 60_000 ? '1' : '0';
  };
  tick();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------- checks

async function refreshChecks() {
  try {
    const status = await api.status(state.session.id, state.session.token);
    renderChecks(status.checks);
  } catch {
    /* the event that triggered this will come again */
  }
}

function renderChecks(run) {
  const panel = $('checksPanel');
  if (!run?.results?.length) {
    panel.innerHTML = '<p class="muted small">Not run yet.</p>';
    return;
  }
  panel.innerHTML = '';
  for (const r of run.results) {
    const row = document.createElement('div');
    row.className = `check ${r.pass ? 'check-pass' : 'check-fail'}`;
    row.innerHTML = `<span class="check-mark"></span><span class="check-msg"></span>`;
    // Icon plus text, never colour alone.
    row.querySelector('.check-mark').textContent = r.pass ? '✓' : '✗';
    row.querySelector('.check-msg').textContent = `${r.name} — ${r.message}`;
    panel.append(row);
  }
}

function renderHint(data) {
  const panel = $('hintsPanel');
  if (panel.querySelector('.muted')) panel.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'hint';
  box.textContent = data.text;
  panel.append(box);
}

// ---------------------------------------------------------------- files

async function refreshFiles() {
  if (!state.session) return;
  const list = $('fileList');
  if (!list.children.length) list.innerHTML = '<li class="muted">loading…</li>';
  try {
    const result = await api.listFiles(state.session.id, state.session.token);
    const entries = normalizeFiles(result);
    const list = $('fileList');
    list.innerHTML = '';
    for (const entry of entries) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="name"></span><span class="size"></span>`;
      li.querySelector('.name').textContent = `${entry.isDirectory ? '▸' : ' '} ${entry.name}`;
      li.querySelector('.size').textContent = entry.isDirectory ? '' : formatSize(entry.size);
      if (!entry.isDirectory) li.addEventListener('click', () => openFile(entry.name));
      list.append(li);
    }
    if (!entries.length) list.innerHTML = '<li class="muted">empty</li>';
  } catch (err) {
    $('fileList').innerHTML = '<li class="error"></li>';
    $('fileList').querySelector('li').textContent = err.message;
  }
}

/** The API returns the SDK's listing shape; tolerate either a bare array or {files:[…]}. */
function normalizeFiles(result) {
  const raw = Array.isArray(result) ? result : (result?.files ?? []);
  return raw
    .map((f) => ({
      name: (f.name ?? f.path ?? '').replace(/^\/workspace\//, ''),
      size: f.size ?? 0,
      isDirectory: Boolean(f.isDirectory ?? f.is_directory ?? f.type === 'directory'),
    }))
    .filter((f) => f.name && !f.name.includes('/'))
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
        $('editorStatus').textContent = 'unsaved';
      },
    });
    $('editorEmpty').hidden = true;
  } catch (err) {
    $('editorStatus').textContent = `editor failed to load: ${err.message}`;
  }
  return state.editor;
}

async function openFile(name) {
  try {
    const result = await api.readFile(state.session.id, state.session.token, name);
    const editor = await ensureEditor();
    state.openFile = name;
    $('editorPath').textContent = name;
    await editor?.load(result.content ?? '', name);
    $('btnSaveFile').disabled = false;
    $('editorStatus').textContent = '';
    showView('editor');
    for (const li of $('fileList').children) {
      li.setAttribute('aria-selected', String(li.textContent.trim().startsWith(name)));
    }
  } catch (err) {
    $('editorStatus').textContent = err.message;
  }
}

/**
 * Creates an empty file in /workspace and opens it. Without this the
 * console could only edit files a lab already shipped — and the first
 * fixture lab's whole task is to produce a file that does not exist yet,
 * so the lab was unsolvable from the browser.
 */
async function newFile() {
  const name = prompt('New file in /workspace');
  if (!name) return;

  const clean = name.trim().replace(/^\/+/, '');
  if (!clean || clean.includes('..')) {
    showFileError('Give a name inside /workspace, without "..".');
    return;
  }

  try {
    await api.writeFile(state.session.id, state.session.token, clean, '');
    await refreshFiles();
    await openFile(clean);
  } catch (err) {
    showFileError(err.message);
  }
}

function showFileError(message) {
  const el = $('fileError');
  el.textContent = message;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 6000);
}

async function saveFile() {
  if (!state.openFile) return;
  $('btnSaveFile').disabled = true;
  $('editorStatus').textContent = 'saving…';
  try {
    await api.writeFile(state.session.id, state.session.token, state.openFile, state.editor?.value() ?? '');
    $('editorStatus').textContent = 'saved';
    refreshFiles();
  } catch (err) {
    $('editorStatus').textContent = err.message;
  } finally {
    $('btnSaveFile').disabled = false;
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
  for (const name of Object.keys(services)) {
    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.textContent = name;
    tab.addEventListener('click', () => {
      // The proxy takes ?token= on the first hit and redirects to a cookie,
      // so the iframe is pointed at the tokenised URL each time it opens.
      $('serviceFrame').src = serviceUrl(state.session.id, state.session.token, name);
      showView('service', tab);
    });
    host.append(tab);
  }
}

function showView(view, tabEl) {
  for (const el of document.querySelectorAll('.view')) el.classList.remove('view-active');
  for (const el of document.querySelectorAll('.tab')) el.classList.remove('tab-active');

  // Every tab's `data-view` must have an entry here. Adding the Brief tab
  // without one made `$(undefined)` null and threw on `.classList`, which
  // enterSession swallowed into the launcher's error line — so no lab could
  // be started at all. Fail loudly instead of dereferencing null.
  const map = { brief: 'viewBrief', terminal: 'viewTerminal', editor: 'viewEditor', service: 'viewService' };
  const target = map[view] && $(map[view]);
  if (!target) throw new Error(`showView: no view registered for "${view}"`);
  target.classList.add('view-active');
  (tabEl ?? document.querySelector(`.tab[data-view="${view}"]`))?.classList.add('tab-active');
  if (view === 'terminal') state.terminal?.refit();
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
  } catch (err) {
    host.innerHTML = '<p class="error"></p>';
    host.querySelector('p').textContent = err.message;
  }
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

$('btnChecks').addEventListener('click', async () => {
  $('btnChecks').disabled = true;
  try {
    renderChecks(await api.runChecks(state.session.id, state.session.token));
  } catch (err) {
    addEvent('bad', 'checks', err.message);
  } finally {
    $('btnChecks').disabled = false;
  }
});

$('btnSnapshot').addEventListener('click', async () => {
  try {
    await api.snapshot(state.session.id, state.session.token);
  } catch (err) {
    addEvent('bad', 'snapshot', err.message);
  }
});

$('btnEnd').addEventListener('click', async () => {
  if (!confirm('End this session? The container is destroyed.')) return;
  const btn = $('btnEnd');
  btn.disabled = true;
  try {
    await api.end(state.session.id, state.session.token, false);
  } catch (err) {
    // Say so, but still go home: the container is gone or was never there,
    // and leaving a dead workspace on screen helps nobody.
    addEvent('bad', 'end', err.message);
    addNotice('bad', 'Could not end cleanly', err.message);
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
  refreshPools();
});

$('btnRefreshFiles').addEventListener('click', refreshFiles);
$('btnNewFile').addEventListener('click', newFile);
$('btnReconnectTerm').addEventListener('click', reconnectTerminal);
$('btnSaveFile').addEventListener('click', saveFile);

for (const tab of document.querySelectorAll('.tab[data-view]')) {
  tab.addEventListener('click', () => showView(tab.dataset.view, tab));
}

$('btnChangeApi').addEventListener('click', () => {
  const next = prompt('Sandbox API base URL', apiBase());
  if (next) {
    setApiBase(next);
    location.reload();
  }
});

$('apiLabel').textContent = apiBase();
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
