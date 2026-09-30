/**
 * Opalix Ops: the admin panel's page.
 *
 * Seven tabs, each a screen that mounts the first time it is opened. Every
 * fetch goes through this origin's /api proxy (the Worker adds the service
 * key), and every fetch has a loading, an empty and an error state. Server
 * strings only ever become text nodes (see lib.js), never HTML.
 */
import { h, clear, svg, api, when, ago, usd, duration, percent, pill, statePill, stateView, table, confirmDialog, toast } from './lib.js';

/* ------------------------------------------------------------------ shared */

const DAY_MS = 86_400_000;

/** A screen's frame: title, a refresh button, and the region its state view owns. */
function frame(panel, title, { refresh, extra } = {}) {
  const body = h('div', { class: 'panel-body' });
  panel.append(
    h(
      'div',
      { class: 'panel-head' },
      h('h2', null, title),
      h('div', { class: 'panel-tools' }, extra ?? null, refresh ? h('button', { class: 'btn', type: 'button', onclick: refresh }, 'Refresh') : null)
    ),
    body
  );
  return body;
}

/**
 * A cursor-paged table: first page on load, "Load more" for the rest.
 * `query()` supplies the current filters; `reload()` starts again from the top.
 */
function pagedTable({ path, key, columns, caption, empty, unavailable, query = () => ({}), limit = 50 }) {
  const mount = h('div');
  const foot = h('div', { class: 'pager' });
  const root = h('div', null, mount, foot);
  let rows = [];
  let next;
  let ticket = 0;
  const view = stateView(mount, () => reload());

  const moreButton = h('button', { class: 'btn', type: 'button', onclick: () => load(false) }, 'Load more');

  function draw() {
    clear(foot);
    if (rows.length === 0) return view.empty(empty);
    view.content(table(columns, rows, { caption }));
    foot.append(h('span', { class: 'muted small' }, `${rows.length} loaded`));
    if (next !== undefined) foot.append(moreButton);
  }

  async function load(reset) {
    const mine = ++ticket;
    if (reset) {
      rows = [];
      next = undefined;
      clear(foot);
      view.loading();
    } else {
      moreButton.disabled = true;
    }
    try {
      const data = await api(path, { query: { ...query(), limit, before: reset ? undefined : next } });
      if (mine !== ticket) return;
      if (data.available === false) {
        rows = [];
        clear(foot);
        return view.empty(unavailable);
      }
      rows = rows.concat(data[key] ?? []);
      next = data.next;
      draw();
    } catch (err) {
      if (mine !== ticket) return;
      if (rows.length === 0) {
        clear(foot);
        view.error(err);
      } else {
        moreButton.disabled = false;
        toast(err.message, 'bad');
      }
    }
  }

  function reload() {
    return load(true);
  }
  return { root, reload };
}

const mono = (text, title) => h('span', { class: 'mono', title: title ?? null }, text);
const dash = '—';

/* ---------------------------------------------------------------- sessions */

const STATES = ['starting', 'running', 'recovering', 'resuming', 'ended'];

function sessionsScreen(panel) {
  let liveView;
  let hist;

  const liveMount = h('div');
  liveView = stateView(liveMount, () => loadLive());

  async function loadLive() {
    liveView.loading();
    try {
      const data = await api('/sessions');
      const rows = Array.isArray(data) ? data : [];
      if (rows.length === 0) return liveView.empty('No live sessions. Nothing is running for a learner right now.');
      liveView.content(
        table(
          [
            { label: 'User', cell: (r) => mono(r.user_id) },
            { label: 'Lab', cell: (r) => r.lab_slug },
            { label: 'State', cell: (r) => statePill(r.state) },
            { label: 'Started (UTC)', cell: (r) => h('span', { title: when(r.created_at) }, `${when(r.created_at)} `, h('span', { class: 'muted small' }, `(${ago(r.created_at)})`)) },
            { label: 'Session', cell: (r) => mono(r.id.slice(0, 10), r.id) },
            {
              label: 'Actions',
              class: 'col-actions',
              cell: (r) => h('button', { class: 'btn btn-danger btn-small', type: 'button', onclick: (e) => endSession(r, e.currentTarget) }, 'End'),
            },
          ],
          rows,
          { caption: 'Live sessions' }
        )
      );
    } catch (err) {
      liveView.error(err);
    }
  }

  async function endSession(row, button) {
    const ok = await confirmDialog({
      title: 'End this session?',
      body: `This ends ${row.user_id}'s ${row.lab_slug} session (${row.id.slice(0, 10)}). Their workspace is snapshotted first, then the container is released. It cannot be undone.`,
      confirmLabel: 'End session',
      danger: true,
    });
    if (!ok) return;
    button.disabled = true;
    try {
      await api(`/sessions/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      toast(`Ended ${row.lab_slug} session ${row.id.slice(0, 10)}.`);
      loadLive();
      hist.reload();
    } catch (err) {
      button.disabled = false;
      toast(`Could not end the session: ${err.message}`, 'bad');
    }
  }

  // History filters. Plain inputs read at load time, so a half-typed value never fires a request.
  const stateSelect = h('select', { id: 'f-state', class: 'input' }, h('option', { value: '' }, 'Any state'), STATES.map((s) => h('option', { value: s }, s)));
  const labInput = h('input', { id: 'f-lab', class: 'input', type: 'text', placeholder: 'lab slug', autocomplete: 'off', spellcheck: 'false' });
  const userInput = h('input', { id: 'f-user', class: 'input', type: 'text', placeholder: 'user id', autocomplete: 'off', spellcheck: 'false' });
  const filters = h(
    'form',
    {
      class: 'filters',
      onsubmit: (e) => {
        e.preventDefault();
        hist.reload();
      },
    },
    h('label', { for: 'f-state' }, 'State', stateSelect),
    h('label', { for: 'f-lab' }, 'Lab', labInput),
    h('label', { for: 'f-user' }, 'User', userInput),
    h('div', { class: 'filter-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Apply'), h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => {
        stateSelect.value = labInput.value = userInput.value = '';
        hist.reload();
      },
    }, 'Reset'))
  );

  hist = pagedTable({
    path: '/admin/sessions',
    key: 'sessions',
    caption: 'Session history',
    empty: 'No sessions match these filters.',
    query: () => ({ state: stateSelect.value, lab: labInput.value.trim(), user: userInput.value.trim() }),
    columns: [
      { label: 'Created (UTC)', cell: (r) => when(r.created_at) },
      { label: 'User', cell: (r) => mono(r.user_id) },
      { label: 'Lab', cell: (r) => h('span', null, r.lab_slug, ' ', h('span', { class: 'muted mono small' }, `v${r.lab_version}`)) },
      { label: 'State', cell: (r) => h('span', null, statePill(r.state), r.end_reason ? h('span', { class: 'muted small' }, ` ${r.end_reason}`) : null) },
      { label: 'Ran', class: 'num', cell: (r) => duration(r.running_s) },
      { label: 'Cost', class: 'num', cell: (r) => usd(r.cost_usd) },
      { label: 'LLM (self-reported)', class: 'num', cell: (r) => usd(r.llm_usd) },
      { label: 'Completed', cell: (r) => (r.completed_at ? pill('yes', 'good') : dash) },
      { label: 'Hints', class: 'num', cell: (r) => (r.hints_delivered ?? dash) },
    ],
  });

  const body = frame(panel, 'Sessions', {
    refresh: () => {
      loadLive();
      hist.reload();
    },
  });
  body.append(
    h('section', { class: 'block' }, h('h3', null, 'Live now'), liveMount),
    h('section', { class: 'block' }, h('h3', null, 'History'), filters, hist.root)
  );
  loadLive();
  hist.reload();

  return {
    /** Jumps here from another tab with a user filter set. */
    filterUser(user) {
      stateSelect.value = '';
      labInput.value = '';
      userInput.value = user;
      hist.reload();
    },
  };
}

/* ------------------------------------------------------------------- pools */

function poolsScreen(panel) {
  const mount = h('div');
  const view = stateView(mount, () => load());
  const body = frame(panel, 'Pools', { refresh: () => load() });
  body.append(
    h('p', { class: 'muted' }, 'Warm containers are started ahead of demand so a lab opens quickly. They cost money while they run, whether or not anyone claims them.'),
    mount
  );

  async function load() {
    view.loading();
    try {
      const pools = await api('/pools');
      const families = Object.entries(pools ?? {});
      if (families.length === 0) return view.empty('The API reported no pools.');
      view.content(h('div', { class: 'tiles' }, families.map(([family, stats]) => poolTile(family, stats))));
    } catch (err) {
      view.error(err);
    }
  }

  function poolTile(family, p) {
    const s = p.stats ?? {};
    const buttons = [];
    const act = async (verb, confirm) => {
      if (!(await confirmDialog(confirm))) return;
      buttons.forEach((b) => (b.disabled = true));
      try {
        await api(`/pools/${encodeURIComponent(family)}/${verb}`, { method: 'POST' });
        toast(`${verb === 'prime' ? 'Primed' : 'Drained'} the ${family} pool.`);
        load();
      } catch (err) {
        buttons.forEach((b) => (b.disabled = false));
        toast(`Could not ${verb} the ${family} pool: ${err.message}`, 'bad');
      }
    };
    const prime = h('button', {
      class: 'btn btn-primary',
      type: 'button',
      onclick: () =>
        act('prime', {
          title: `Prime the ${family} pool?`,
          body: `Starts warm containers until ${p.config?.target ?? 'the target number'} are ready. Each one is billed while it runs.`,
          confirmLabel: 'Prime',
        }),
    }, 'Prime');
    const drain = h('button', {
      class: 'btn btn-danger',
      type: 'button',
      onclick: () =>
        act('drain', {
          title: `Drain the ${family} pool?`,
          body: `Destroys all ${p.warm ?? 0} warm ${family} containers. Containers already claimed by a session are left alone. The pool refills toward its target unless the target is 0.`,
          confirmLabel: 'Drain',
          danger: true,
        }),
    }, 'Drain');
    buttons.push(prime, drain);

    const stat = (label, value, note) =>
      h('div', { class: 'stat' }, h('dt', null, label), h('dd', null, value, note ? h('span', { class: 'muted small' }, ` ${note}`) : null));

    return h(
      'article',
      { class: 'tile pool-tile', 'aria-label': `${family} pool` },
      h('header', { class: 'tile-head' }, h('h3', null, family), s.degraded ? pill('degraded', 'bad') : pill('healthy', 'good')),
      h(
        'dl',
        { class: 'stats' },
        stat('Warm', p.warm ?? 0, `of target ${p.config?.target ?? dash}`),
        stat('Claimed', p.claimed ?? 0, `of max ${p.max_instances ?? dash}`),
        stat('Available', p.available ?? dash, 'slots')
      ),
      h(
        'div',
        { class: s.last_start_error ? 'pool-error' : 'pool-error pool-error-none' },
        h('span', { class: 'label' }, 'Last error'),
        s.last_start_error
          ? h('span', null, s.last_start_error, ' ', h('span', { class: 'muted small' }, `(${ago(s.last_start_error_at)}${s.consecutive_start_failures ? `, ${s.consecutive_start_failures} in a row` : ''})`))
          : h('span', { class: 'muted' }, 'none recorded')
      ),
      h('div', { class: 'tile-actions' }, prime, drain)
    );
  }

  load();
}

/* --------------------------------------------------------------- catalogue */

function catalogueScreen(panel) {
  const mount = h('div');
  const view = stateView(mount, () => load());
  const filter = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Filter by title, slug or path',
    'aria-label': 'Filter labs',
    autocomplete: 'off',
    oninput: () => applyFilter(),
  });
  const body = frame(panel, 'Catalogue', { refresh: () => load(), extra: filter });
  body.append(mount);
  let rowsBySlug = [];

  async function load() {
    view.loading();
    try {
      const labs = [];
      let cursor;
      // The API pages at 200; a catalogue is a few dozen, and ten pages is a safety stop.
      for (let page = 0; page < 10; page++) {
        const data = await api('/labs', { query: { limit: 200, cursor } });
        if (Array.isArray(data)) {
          labs.push(...data);
          break;
        }
        labs.push(...(data.labs ?? []));
        cursor = data.next;
        if (!cursor) break;
      }
      if (labs.length === 0) return view.empty('No labs are published.');
      draw(labs);
    } catch (err) {
      view.error(err);
    }
  }

  function draw(labs) {
    rowsBySlug = [];
    const head = ['Lab', 'Path / module', 'Tier', 'Family', 'Current', 'Est. min', 'Actions'];
    const tbody = h('tbody');
    for (const lab of labs) {
      const versionCell = h('td', { 'data-label': 'Current' }, mono(lab.version ?? dash));
      const detail = h('td', { colspan: head.length, class: 'detail-cell' });
      const detailRow = h('tr', { class: 'detail-row', hidden: true }, detail);
      const toggle = h('button', { class: 'btn btn-small', type: 'button', 'aria-expanded': 'false' }, 'Versions');
      const main = h(
        'tr',
        { class: 'lab-row' },
        h('td', { 'data-label': 'Lab' }, h('div', { class: 'lab-title' }, lab.title ?? lab.slug), h('div', { class: 'mono muted small' }, lab.slug)),
        h('td', { 'data-label': 'Path / module' }, lab.path ? `${lab.path}${lab.module !== undefined ? ` · M${lab.module}` : ''}` : dash),
        h('td', { 'data-label': 'Tier' }, pill(lab.tier ?? 'pro', lab.tier === 'free' ? 'good' : 'muted')),
        h('td', { 'data-label': 'Family' }, lab.family ?? dash),
        versionCell,
        h('td', { class: 'num', 'data-label': 'Est. min' }, lab.estimated_minutes ?? dash),
        h('td', { class: 'col-actions', 'data-label': 'Actions' }, toggle)
      );
      let versionsView;
      const loadVersions = async () => {
        versionsView.loading('Loading versions…');
        try {
          const data = await api(`/labs/${encodeURIComponent(lab.slug)}/versions`);
          versionsView.content(versionsTable(lab, data, versionCell, loadVersions));
        } catch (err) {
          versionsView.error(err);
        }
      };
      versionsView = stateView(detail, loadVersions);
      toggle.addEventListener('click', () => {
        const open = detailRow.hidden;
        detailRow.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.textContent = open ? 'Hide' : 'Versions';
        if (open) loadVersions();
      });
      tbody.append(main, detailRow);
      rowsBySlug.push({ lab, rows: [main, detailRow] });
    }
    const wrap = h(
      'div',
      { class: 'table-wrap catalogue', tabindex: '0', role: 'region', 'aria-label': 'Lab catalogue' },
      h('table', { class: 'table' }, h('caption', { class: 'sr-only' }, 'Lab catalogue'), h('thead', null, h('tr', null, head.map((c) => h('th', { scope: 'col' }, c)))), tbody)
    );
    view.content(h('div', null, wrap, h('p', { class: 'muted small count', id: 'catCount' }, `${labs.length} labs`)));
    applyFilter();
  }

  function applyFilter() {
    const q = filter.value.trim().toLowerCase();
    let shown = 0;
    for (const { lab, rows } of rowsBySlug) {
      const hit = !q || `${lab.title} ${lab.slug} ${lab.path ?? ''}`.toLowerCase().includes(q);
      rows[0].hidden = !hit;
      if (!hit) rows[1].hidden = true;
      if (hit) shown++;
    }
    const count = document.getElementById('catCount');
    if (count) count.textContent = q ? `${shown} of ${rowsBySlug.length} labs` : `${rowsBySlug.length} labs`;
  }

  function versionsTable(lab, data, versionCell, reloadVersions) {
    const versions = data.versions ?? [];
    if (versions.length === 0) return h('p', { class: 'muted' }, 'No versions are stored for this lab.');
    const promote = async (v, button) => {
      const ok = await confirmDialog({
        title: `Promote ${lab.slug} ${v.version}?`,
        body: `New sessions of this lab will start on ${v.version} instead of ${data.current ?? 'the current version'}. Sessions already running keep the version they started with. Promote ${data.current ?? 'the old version'} again to undo it.`,
        confirmLabel: `Promote ${v.version}`,
      });
      if (!ok) return;
      button.disabled = true;
      try {
        const res = await api(`/labs/${encodeURIComponent(lab.slug)}/promote`, { method: 'POST', body: { version: v.version } });
        toast(`${lab.slug} now serves ${res.current}.`);
        clear(versionCell).append(mono(res.current));
        reloadVersions();
      } catch (err) {
        button.disabled = false;
        toast(`Could not promote: ${err.message}`, 'bad');
      }
    };
    return h(
      'div',
      { class: 'versions' },
      table(
        [
          {
            label: 'Version',
            cell: (v) => h('span', { class: 'ver' }, mono(v.version), v.current ? pill('current', 'good') : null, v.previous ? pill('previous', 'warn') : null),
          },
          { label: 'Title', cell: (v) => v.title ?? h('span', { class: 'muted' }, v.error ?? dash) },
          { label: 'Est. min', class: 'num', cell: (v) => v.estimated_minutes ?? dash },
          { label: 'Published (UTC)', cell: (v) => when(v.published_at) },
          {
            label: 'Actions',
            class: 'col-actions',
            cell: (v) =>
              v.current
                ? h('span', { class: 'muted small' }, 'serving')
                : h('button', { class: 'btn btn-small', type: 'button', onclick: (e) => promote(v, e.currentTarget) }, 'Promote'),
          },
        ],
        versions,
        { caption: `Versions of ${lab.slug}` }
      )
    );
  }

  load();
}

/* ----------------------------------------------------------- usage & cost */

const RANGES = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

function usageScreen(panel) {
  let days = 30;
  const mount = h('div');
  const view = stateView(mount, () => load());
  const seg = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': 'Time range' },
    RANGES.map((r) =>
      h('button', {
        class: 'seg',
        type: 'button',
        'aria-pressed': String(r.days === days),
        dataset: { days: String(r.days) },
        onclick: (e) => {
          days = r.days;
          seg.querySelectorAll('.seg').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
          load();
        },
      }, r.label)
    )
  );
  const body = frame(panel, 'Usage & cost', { refresh: () => load(), extra: seg });
  body.append(mount);
  let redraw = null;
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => redraw?.(), 150);
  });

  async function load() {
    redraw = null;
    view.loading();
    try {
      const data = await api('/admin/usage/summary', { query: { from: Date.now() - days * DAY_MS } });
      if (!data.totals?.sessions) return view.empty(`No sessions were created in the last ${days} days.`);
      draw(data);
    } catch (err) {
      view.error(err);
    }
  }

  function tile(label, value, note, modifier) {
    return h('div', { class: `tile stat-tile${modifier ? ` ${modifier}` : ''}` }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), note ? h('div', { class: 'tile-note' }, note) : null);
  }

  function draw(data) {
    const t = data.totals;
    const c = data.completion;
    const tiles = h(
      'div',
      { class: 'tiles tiles-stats' },
      tile('Sessions', String(t.sessions), `${when(data.from).slice(0, 10)} to ${when(data.to).slice(0, 10)} (UTC)`),
      tile('Running time', duration(t.running_s), 'summed over ended sessions'),
      tile('Container cost', usd(t.cost_usd), 'estimated from container time'),
      tile('LLM cost', usd(t.llm_usd), 'self-reported, not billing-reconciled', 'tile-caveat'),
      tile('Completion', c.rate === null ? dash : percent(c.rate), `${c.completed} of ${c.ended} ended sessions passed every check`)
    );

    const chartMount = h('div', { class: 'chart' });
    const paint = () => {
      clear(chartMount).append(costChart(data.by_day ?? [], data.from, data.to, chartMount.clientWidth || 640));
    };
    redraw = paint;

    view.content(
      h(
        'div',
        null,
        tiles,
        h('section', { class: 'block' }, h('h3', null, 'Container cost by day (UTC)'), chartMount),
        h(
          'section',
          { class: 'block' },
          h('h3', null, 'By lab', h('span', { class: 'muted small heading-note' }, ' top 20 by cost')),
          (data.by_lab ?? []).length
            ? table(
                [
                  { label: 'Lab', cell: (r) => r.lab_slug },
                  { label: 'Sessions', class: 'num', cell: (r) => r.sessions },
                  { label: 'Running time', class: 'num', cell: (r) => duration(r.running_s) },
                  { label: 'Container cost', class: 'num', cell: (r) => usd(r.cost_usd) },
                  { label: 'LLM (self-reported)', class: 'num', cell: (r) => usd(r.llm_usd) },
                  { label: 'Completed', class: 'num', cell: (r) => r.completed },
                ],
                data.by_lab,
                { caption: 'Usage by lab' }
              )
            : h('p', { class: 'muted' }, 'No lab has any usage in this window.')
        )
      )
    );
    paint();
  }

  load();
}

/** UTC calendar days from `from` to `to` inclusive, each with its cost (zero where the API had no row). */
function fillDays(byDay, from, to) {
  const known = new Map(byDay.map((d) => [d.day, d]));
  const days = [];
  const start = Math.floor(from / DAY_MS) * DAY_MS;
  for (let t = start; t <= to && days.length < 366; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    days.push({ day, cost_usd: known.get(day)?.cost_usd ?? 0, sessions: known.get(day)?.sessions ?? 0 });
  }
  return days;
}

/** 1, 2 or 5 times a power of ten at or above `max`: a y axis that ends on a round number. */
function niceMax(max) {
  if (!(max > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= max) ?? max;
}

const axisMoney = (v) => `$${Number(v.toPrecision(2))}`;

/** A plain SVG bar chart, sized to its container so the text stays readable at phone width. */
function costChart(byDay, from, to, width) {
  const days = fillDays(byDay, from, to);
  const W = Math.max(280, Math.floor(width));
  const H = 220;
  const m = { top: 12, right: 8, bottom: 26, left: 48 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const max = niceMax(Math.max(0, ...days.map((d) => d.cost_usd)));
  const y = (v) => m.top + plotH - (v / max) * plotH;
  const step = plotW / days.length;
  const barW = Math.max(1, step * 0.72);
  const total = days.reduce((a, d) => a + d.cost_usd, 0);
  const peak = days.reduce((a, d) => (d.cost_usd > a.cost_usd ? d : a), days[0]);

  const root = svg('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    role: 'img',
    'aria-label': `Bar chart of container cost per day over ${days.length} days: ${usd(total)} in total, highest on ${peak.day} at ${usd(peak.cost_usd)}.`,
  });
  for (const v of [0, max / 2, max]) {
    root.append(
      svg('line', { class: v === 0 ? 'axis' : 'grid', x1: m.left, x2: W - m.right, y1: y(v), y2: y(v) }),
      svg('text', { class: 'tick', x: m.left - 6, y: y(v) + 4, 'text-anchor': 'end' }, axisMoney(v))
    );
  }
  days.forEach((d, i) => {
    const x = m.left + i * step + (step - barW) / 2;
    const bar = svg('rect', { class: 'bar', x, y: y(d.cost_usd), width: barW, height: Math.max(0, m.top + plotH - y(d.cost_usd)), rx: barW > 6 ? 2 : 0 });
    bar.append(svg('title', null, `${d.day}: ${usd(d.cost_usd)}, ${d.sessions} session${d.sessions === 1 ? '' : 's'}`));
    root.append(bar);
  });
  // Label about every 70px, so the axis never crowds at phone width.
  const every = Math.max(1, Math.ceil(70 / step));
  days.forEach((d, i) => {
    if (i % every !== 0) return;
    root.append(svg('text', { class: 'tick', x: m.left + i * step + step / 2, y: H - 8, 'text-anchor': 'middle' }, d.day.slice(5)));
  });
  return root;
}

/* -------------------------------------------------------------- users etc. */

function usersScreen(panel, ctx) {
  const list = pagedTable({
    path: '/admin/users',
    key: 'users',
    caption: 'Users',
    empty: 'No user has started a session yet.',
    columns: [
      { label: 'User', cell: (r) => mono(r.user_id) },
      { label: 'Plan', cell: (r) => (r.plan ? pill(r.plan, r.plan === 'free' ? 'muted' : 'good') : dash) },
      { label: 'Sessions', class: 'num', cell: (r) => r.sessions },
      { label: 'Completed', class: 'num', cell: (r) => r.completed },
      { label: 'Last session (UTC)', cell: (r) => when(r.last_session_at) },
      { label: 'Cost', class: 'num', cell: (r) => usd(r.cost_usd) },
      {
        label: 'Actions',
        class: 'col-actions',
        cell: (r) => h('button', { class: 'btn btn-small', type: 'button', onclick: () => ctx.showSessionsFor(r.user_id) }, 'Sessions'),
      },
    ],
  });
  frame(panel, 'Users', { refresh: () => list.reload() }).append(
    h('p', { class: 'muted' }, 'Every distinct user id that has started a session. There are no accounts yet, so this is activity, not identity.'),
    list.root
  );
  list.reload();
}

function waitlistScreen(panel) {
  const list = pagedTable({
    path: '/admin/waitlist',
    key: 'rows',
    caption: 'Waitlist',
    empty: 'Nobody has joined the waitlist yet.',
    unavailable: 'The waitlist table is not in this database yet (migration 0004 has not been applied).',
    columns: [
      { label: 'Email', cell: (r) => mono(r.email) },
      { label: 'Plan', cell: (r) => pill(r.plan, r.plan === 'team' ? 'good' : 'muted') },
      { label: 'Role', cell: (r) => r.role ?? dash },
      { label: 'Country', cell: (r) => r.country ?? dash },
      { label: 'Source', cell: (r) => r.source ?? dash },
      { label: 'Joined (UTC)', cell: (r) => when(r.created_at) },
      { label: 'Updated (UTC)', cell: (r) => (r.updated_at && r.updated_at !== r.created_at ? when(r.updated_at) : dash) },
    ],
  });
  frame(panel, 'Waitlist', { refresh: () => list.reload() }).append(list.root);
  list.reload();
}

function feedbackScreen(panel) {
  const list = pagedTable({
    path: '/admin/feedback',
    key: 'rows',
    caption: 'Feedback',
    empty: 'No feedback yet.',
    unavailable: 'The feedback tables are not in this database yet (migrations 0006 and 0007 have not been applied).',
    columns: [
      { label: 'Source', cell: (r) => pill(r.source, r.source === 'lab' ? 'good' : 'muted') },
      { label: 'Rating', class: 'num', cell: (r) => (r.rating ? `${r.rating}/5` : dash) },
      { label: 'Message', class: 'wrap', cell: (r) => r.message ?? h('span', { class: 'muted' }, 'no message') },
      {
        label: 'From',
        cell: (r) =>
          r.source === 'lab'
            ? h('span', null, r.lab_slug ?? dash, ' ', h('span', { class: 'muted mono small' }, r.user_id ?? ''))
            : h('span', null, [r.email, r.country, r.origin].filter(Boolean).join(' · ') || dash),
      },
      { label: 'When (UTC)', cell: (r) => when(r.created_at) },
    ],
  });
  frame(panel, 'Feedback', { refresh: () => list.reload() }).append(list.root);
  list.reload();
}

/* -------------------------------------------------------------------- shell */

const TABS = [
  { id: 'sessions', label: 'Sessions', screen: sessionsScreen },
  { id: 'pools', label: 'Pools', screen: poolsScreen },
  { id: 'catalogue', label: 'Catalogue', screen: catalogueScreen },
  { id: 'usage', label: 'Usage & cost', screen: usageScreen },
  { id: 'users', label: 'Users', screen: usersScreen },
  { id: 'waitlist', label: 'Waitlist', screen: waitlistScreen },
  { id: 'feedback', label: 'Feedback', screen: feedbackScreen },
];

function startShell() {
  const tabs = document.getElementById('tabs');
  const main = document.getElementById('main');
  const mounted = new Map();
  const ctx = {
    showSessionsFor(user) {
      select('sessions');
      mounted.get('sessions')?.filterUser?.(user);
    },
  };

  const buttons = TABS.map((t) =>
    h('button', {
      class: 'tab',
      type: 'button',
      role: 'tab',
      id: `tab-${t.id}`,
      'aria-controls': `panel-${t.id}`,
      'aria-selected': 'false',
      tabindex: '-1',
      onclick: () => select(t.id),
      onkeydown: (e) => {
        const i = TABS.findIndex((x) => x.id === t.id);
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        const target = TABS[(to + TABS.length) % TABS.length];
        select(target.id);
        document.getElementById(`tab-${target.id}`).focus();
      },
    }, t.label)
  );
  const panels = TABS.map((t) => h('section', { class: 'panel', role: 'tabpanel', id: `panel-${t.id}`, 'aria-labelledby': `tab-${t.id}`, hidden: true }));
  tabs.append(...buttons);
  main.append(...panels);

  function select(id, { updateHash = true } = {}) {
    const tab = TABS.find((t) => t.id === id) ?? TABS[0];
    TABS.forEach((t, i) => {
      const on = t.id === tab.id;
      buttons[i].setAttribute('aria-selected', String(on));
      buttons[i].tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
    });
    const index = TABS.indexOf(tab);
    if (!mounted.has(tab.id)) mounted.set(tab.id, tab.screen(panels[index], ctx) ?? {});
    if (updateHash && location.hash !== `#${tab.id}`) history.replaceState(null, '', `#${tab.id}`);
    buttons[index].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  window.addEventListener('hashchange', () => select(location.hash.slice(1), { updateHash: false }));
  select(location.hash.slice(1) || 'sessions');
}

/* -------------------------------------------------------------------- theme */

const THEMES = ['system', 'light', 'dark'];
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' };

function startTheme() {
  const button = document.getElementById('btnTheme');
  const icon = document.getElementById('themeIcon');
  let current = document.documentElement.getAttribute('data-theme') ?? 'system';
  const apply = () => {
    if (current === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', current);
    icon.textContent = THEME_ICON[current];
    const nextTheme = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    button.setAttribute('aria-label', `Theme: ${current}. Switch to ${nextTheme}.`);
  };
  button.addEventListener('click', () => {
    current = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    try {
      if (current === 'system') localStorage.removeItem('opalixTheme');
      else localStorage.setItem('opalixTheme', current);
    } catch {
      /* blocked storage: the choice lasts until reload */
    }
    apply();
  });
  apply();
}

document.getElementById('btnSignOut').addEventListener('click', async () => {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    location.reload();
  }
});

startTheme();
startShell();
