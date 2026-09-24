import { api, apiBase, setApiBase, eventsUrl, serviceUrl } from './api.js';
import { attachTerminal } from './terminal.js';

const $ = (id) => document.getElementById(id);

const state = {
  session: null, // { id, token, lab, urls }
  terminal: null,
  events: null, // EventSource
  expiresAt: null,
  eventCount: 0,
  openFile: null,
  serviceKey: sessionStorage.getItem('opalix.serviceKey') || '',
};

// ---------------------------------------------------------------- launcher

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
      row.innerHTML = `
        <div class="lab-meta">
          <div class="lab-title"></div>
          <div class="lab-sub"></div>
        </div>
        <button class="btn">Start</button>`;
      row.querySelector('.lab-title').textContent = lab.title;
      row.querySelector('.lab-sub').textContent = `${lab.slug}@${lab.version} · ${lab.family} · ${lab.type}`;
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
    state.session = { id: started.id, token: started.token, lab: slug, urls: started.urls };
    enterSession();
  } catch (err) {
    $('launchError').textContent = err.message;
    $('launchError').hidden = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---------------------------------------------------------------- session

function enterSession() {
  $('launcher').hidden = true;
  $('ops').hidden = true;
  $('workspace').hidden = false;
  $('sessionBar').hidden = false;
  $('btnOps').setAttribute('aria-pressed', 'false');

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
  if (type === 'container.restarted') refreshFiles();
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

async function pollUntilRunning() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && state.session) {
    try {
      const status = await api.status(state.session.id, state.session.token);
      setStatePill(status.meta.state);
      if (status.meta.state === 'running') return onRunning(status);
      if (status.meta.state === 'ended') return onEnded(status.meta.end_reason);
    } catch {
      /* transient; the poll retries */
    }
    await sleep(1500);
  }
}

let runningHandled = false;
async function onRunning(status) {
  if (runningHandled) return;
  runningHandled = true;

  if (!state.terminal) {
    state.terminal = attachTerminal({
      container: $('term'),
      sessionId: state.session.id,
      token: state.session.token,
      onNotice: (text) => addEvent('warn', 'terminal', text),
    });
  }

  const meta = (status ?? (await api.status(state.session.id, state.session.token))).meta;
  state.expiresAt = meta.expires_at ?? null;
  startExpiryTimer();
  renderServiceTabs();
  refreshFiles();
}

function onEnded(reason) {
  setStatePill('ended');
  $('expiryTimer').textContent = reason ? `ended: ${reason}` : 'ended';
  for (const id of ['btnChecks', 'btnSnapshot', 'btnEnd']) $(id).disabled = true;
  state.terminal?.dispose();
  state.terminal = null;
  state.events?.close();
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

async function openFile(name) {
  try {
    const result = await api.readFile(state.session.id, state.session.token, name);
    state.openFile = name;
    $('editorPath').textContent = name;
    $('editorBody').value = result.content ?? '';
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

async function saveFile() {
  if (!state.openFile) return;
  $('btnSaveFile').disabled = true;
  $('editorStatus').textContent = 'saving…';
  try {
    await api.writeFile(state.session.id, state.session.token, state.openFile, $('editorBody').value);
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

  const map = { terminal: 'viewTerminal', editor: 'viewEditor', service: 'viewService' };
  $(map[view]).classList.add('view-active');
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
  const warm = pool.warm?.length ?? 0;
  const claimed = Object.keys(pool.claimed ?? {}).length;
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
  try {
    await api.end(state.session.id, state.session.token, false);
  } catch (err) {
    addEvent('bad', 'end', err.message);
  }
  onEnded('user');
});

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
loadLabs();

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
