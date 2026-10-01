import { api, apiBase, configureAuth, eventsUrl, serviceUrl, serviceBaseUrl } from './api.js';
import { attachTerminal } from './terminal.js';
import { diffLines, collapseContext } from './diff.js';
import {
  buildLauncherModel,
  heroLede,
  labStatus,
  locateLab,
  moduleMetaLine,
  moduleViews,
  passedSlugs,
  summaryLine,
} from './launcher-model.js';
import { isPhoneLike, readDevice } from './device.js';
import { icon, spriteIcon, uiIcon } from './icons.js';
import { createMasteryStore, normalizeLearn, normalizeOnboarding, onboardingFinished, suggestStart } from './learn-model.js';
import { runOnboarding } from './onboarding.js';
import { runBeforeYouBegin } from './before-you-begin.js';
import { buildLessonsTab, buildStoryTab, hasLessons, hasStory } from './learn-tab.js';
import { mountQuestionsForm } from './questions-form.js';
import { SAFE_FILE } from './answers-file.js';
import {
  GUIDE_TABS,
  answerDots,
  checkDots,
  defaultGuideOpen,
  dockAction,
  dockKind,
  dockProgressText,
  guideTabsFor,
  hintCountdown,
  railLabel,
  roveIndex,
  tabBadge,
  windowTitle,
} from './session-layout.js';
// The presentation copy of every path and module: title, intro, skills, icon
// and accent. The public /labs page reads the same file.
import pathMeta from '../../packages/catalogue/paths.json';

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
  /** The service whose "not answering" card is showing, so a tab click retries it. */
  serviceDown: null,
  /** Bumped per openService, so a slow cookie/pre-flight for an earlier click cannot overwrite a later one. */
  serviceOpenSeq: 0,
  /**
   * The browser did not accept the service cookie (or the API predates the
   * route), so the iframe was pointed at a `?token=` URL. Set once, no toast;
   * mirrored as `data-cookie-fallback` on #servicePanel.
   */
  serviceCookieFallback: false,
  checksRunning: false,
  /** `status().manifest_summary`, so a run can be judged against every check the lab has. */
  summary: null,
  /** `status().checks_history`, oldest first. */
  history: [],
  /** `status().hints`, and a signature of it so an unchanged poll does not rebuild the list. */
  hints: null,
  hintSig: '',
  hintTimer: 0,
  /** `status().solution` when the lab has one (else null), and the file the comparison is showing. */
  solution: null,
  /** `meta.started_at` (server clock), and `server_time - Date.now()` at the last status. */
  startedAt: null,
  clockSkew: 0,
  /** The result card has been shown for this session; a later passing run must not show it again. */
  resultShown: false,
  /** What the card says, kept for "Copy summary". */
  result: null,
  timer: 0,
  /** Highest event seq handled, so a stream reopened by hand does not replay what was already shown. */
  lastSeq: 0,
  /** Consecutive EventSource errors since it last opened. */
  streamErrors: 0,
  /** setTimeout id of the status poll used while the stream is down. */
  streamPoll: 0,
  /** First service reported unhealthy during boot, to name it if the boot fails. */
  bootUnhealthy: null,
  /** Wall-clock end of the idle countdown, and its interval. */
  idleDeadline: 0,
  idleTimer: 0,
  /** setInterval id of the resume card's "m:ss left". */
  resumeTimer: 0,
  /** The service whose page is loaded in the frame (`service` is the one selected). */
  loadedService: null,
  /** The workspace view showing ('terminal', 'editor' or 'service'). */
  view: 'editor',
  /** The latest run's results, for the dock's dots. */
  lastResults: null,
  /** The session has been taken to where its lab starts (a service's page, for an explore lab). */
  landed: false,
};

// ------------------------------------------------------------------ toast

/**
 * Feedback for something the learner just did — a snapshot, a file that
 * would not save — where there is no panel of its own to say it in. It is
 * deliberately not a feed: lab events (pressure, hints) are never routed
 * here, only the result of a click.
 */
let toastTimer = 0;
function toast(message, tone = 'info', ms) {
  const el = $('toast');
  $('toastText').textContent = message;
  el.dataset.tone = tone;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms ?? (tone === 'bad' ? 10_000 : 5000));
}

// ---------------------------------------------------------------- storage

/** localStorage for per-browser conveniences; blocked storage just means they do not stick. */
function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: fine for this tab */
  }
}

/** What this browser knows about the learner's learning (learn-model.js); never sent anywhere. */
const mastery = createMasteryStore();

// ---------------------------------------------------------------- launcher

/** The catalogue, kept so a running session can show its lab's context. */
const labsBySlug = new Map();

const DIFFICULTY_LEVEL = { intro: 1, core: 2, advanced: 3 };
const DIFFICULTIES = ['intro', 'core', 'advanced'];
const STATUS_FILTERS = [
  ['todo', 'Not started'],
  ['done', 'Done'],
];

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
  $('labFilters').hidden = true;
  $('pathNav').hidden = true;
  if (!list.querySelector('.lab-skeleton')) showLabSkeleton();
  try {
    const labs = await api.labs();
    list.innerHTML = '';
    if (!labs.length) {
      list.innerHTML =
        '<div class="empty-state"><p>No labs are published yet.</p><p class="muted small">Publish one with <code>opalix labs publish</code>, then reload.</p></div>';
      return;
    }
    // Every lab is known before any card is drawn: a card names its
    // prerequisite by title, and that lab may sit in a later group.
    for (const lab of labs) labsBySlug.set(lab.slug, lab);
    renderLauncher(buildLauncherModel(labs, pathMeta, { passed: passedSlugs(labs) }));
    renderFilters(labs);
    applyFilters();
  } catch (err) {
    if (/^401:/.test(err.message)) {
      // The console cookie is gone (expired, or signed out in another tab).
      list.innerHTML = `
        <div class="empty-state" id="signedOut">
          <p>You are signed out.</p>
          <p class="muted small">Sign in again to see the labs. A lab you left running is still there — sign in and you will be taken back to it.</p>
          <button class="btn btn-primary" id="btnSignIn">Sign in</button>
        </div>`;
      list.querySelector('#btnSignIn').addEventListener('click', () => location.reload());
      return;
    }
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
    renderResumeCard();
  }
}

// ------------------------------------------------ paths, modules and lab rows

/*
 * What is drawn comes from buildLauncherModel (launcher-model.js): the labs
 * grouped by path and module, with every total. Text from the catalogue and
 * from packages/catalogue/paths.json always goes in through textContent.
 */

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function progressBar(done, total, label) {
  const bar = node('div', 'progress');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', label);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(total));
  bar.setAttribute('aria-valuenow', String(done));
  const fill = document.createElement('span');
  fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  bar.append(fill);
  return bar;
}

/** An id-safe form of a slug from the catalogue. */
const safeId = (slug) => String(slug).replace(/[^a-z0-9_-]+/gi, '-');

/** The model the launcher is drawn from, kept so the resume card can say where its lab sits. */
let launcherModel = null;
/** Modules the learner opened from a condensed card, by path and number, for this page load. */
const openedModules = new Set();
/** The slug of the lab that is still running (verified by renderResumeCard), so its row says Rejoin. */
let runningSlug = null;

function renderLauncher(model) {
  launcherModel = model;
  const list = $('labList');
  list.innerHTML = '';
  // Where the platform quiz says to begin: the first module card whose area
  // is new to this learner. Nothing is suggested before the quiz is taken.
  const cards = model.paths.flatMap((p) => (p.cards ? p.modules.map((m) => ({ path: p.slug, number: m.number })) : []));
  const suggested = suggestStart(cards, mastery.get());
  for (const path of model.paths) list.append(pathSection(path, suggested));
  $('heroLede').textContent = heroLede(model.paths.filter((p) => !p.other).length);
  renderPathNav(model);
}

/**
 * One path: a band with its icon, title, intro and totals, then its modules
 * as cards, or (a single-module path) its labs straight underneath. The
 * heading is a direct child of the section, and every part of the band is a
 * grid item of it.
 */
function pathSection(path, suggested = null) {
  const id = path.other ? 'path-other' : `path-${safeId(path.slug)}`;
  const section = node('section', 'lab-group path');
  section.id = id;
  section.dataset.path = path.slug;
  section.dataset.accent = path.accent;
  section.setAttribute('aria-labelledby', `${id}-title`);

  const tile = node('span', 'tile path-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(icon(path.icon || 'grid', 32));

  const head = node('h2', 'group-head');
  head.id = `${id}-title`;
  head.tabIndex = -1;
  head.append(node('span', 'group-title', path.title));

  const stats = node('div', 'path-stats');
  // "31 labs" leads in bold; the rest of the line is the same text as before.
  const [first, ...rest] = summaryLine(path.totals).split(' · ');
  const summary = node('p', 'path-summary');
  summary.append(node('b', '', first), document.createTextNode(rest.length ? ` · ${rest.join(' · ')}` : ''));
  stats.append(summary, progressBar(path.totals.done, path.totals.labs, `Labs done in ${path.title}`));

  section.append(tile, head);
  if (path.intro) section.append(node('p', 'path-intro', path.intro));
  section.append(stats);

  const body = node('div', 'path-body');
  if (path.cards) {
    const modules = node('div', 'modules');
    const views = moduleViews(path, {
      suggested,
      running: runningSlug,
      open: [...openedModules].filter((k) => k.startsWith(`${path.slug}#`)).map((k) => Number(k.split('#')[1])),
    });
    for (const module of path.modules) modules.append(moduleCard(path, module, id, suggested, views.get(module.number) === 'mini'));
    body.append(modules);
  } else {
    // No module card, so no h3 of its own: an invisible one keeps h2 -> h3 -> h4 unbroken.
    body.append(node('h3', 'sr-only', path.other ? 'Labs' : `Labs in ${path.title}`));
    body.append(labRows(path.modules[0].labs, 'lab-rows lab-rows-flat'));
  }
  section.append(body);
  return section;
}

function moduleCard(path, module, pathId, suggested = null, collapsed = false) {
  const id = `${pathId}-module-${module.number}`;
  const card = node('section', 'module');
  card.id = id;
  card.dataset.module = String(module.number);
  card.dataset.accent = module.accent;
  if (module.optional) card.dataset.optional = '1';
  if (collapsed) card.dataset.collapsed = '1';
  card.setAttribute('aria-labelledby', `${id}-title`);

  const info = node('div', 'module-info');
  // The big, faint number behind the panel (decoration; the eyebrow says it in words).
  if (module.known && Number.isFinite(module.number)) {
    const big = node('span', 'module-bignum', String(module.number).padStart(2, '0'));
    big.setAttribute('aria-hidden', 'true');
    info.append(big);
  }
  const tile = node('span', 'tile module-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(icon(module.icon || 'grid', 24));
  info.append(tile);

  const eyebrow = node('p', 'module-eyebrow');
  if (module.known) eyebrow.append(node('span', 'module-num', module.eyebrow));
  if (module.optional) eyebrow.append(node('span', 'badge badge-optional', 'Optional'));
  if (suggested && suggested.path === path.slug && suggested.number === module.number) {
    eyebrow.append(node('span', 'badge badge-suggested', 'Suggested start'));
  }
  if (eyebrow.childElementCount) info.append(eyebrow);

  const title = node('h3', 'module-title', module.title);
  title.id = `${id}-title`;
  title.tabIndex = -1;
  info.append(title);

  if (module.intro) info.append(node('p', 'module-intro', module.intro));
  if (module.skills.length) {
    const skills = node('div', 'module-skills');
    const label = node('p', 'skills-label', 'You will learn to');
    const items = node('ul', 'skill-list');
    for (const skill of module.skills) items.append(node('li', '', skill));
    skills.append(label, items);
    info.append(skills);
  }

  const { totals } = module;
  info.append(node('p', 'module-meta', moduleMetaLine(totals)));
  info.append(progressBar(totals.done, totals.labs, `Labs done in ${module.title}`));
  info.append(node('p', 'module-progress', `${totals.done} of ${totals.labs} done`));

  card.append(info, labRows(module.labs, 'lab-rows'));

  // The condensed face: the same module as a card that opens in place. It is a
  // button, so the keyboard reaches it, and opening moves focus to the title.
  const mini = node('button', 'module-mini');
  mini.type = 'button';
  mini.setAttribute('aria-expanded', 'false');
  mini.setAttribute('aria-controls', id);
  const miniTile = node('span', 'tile');
  miniTile.setAttribute('aria-hidden', 'true');
  miniTile.append(icon(module.icon || 'grid', 22));
  const text = node('span', 'module-mini-text');
  text.append(
    node('span', 'module-mini-eyebrow', `${module.eyebrow}${module.optional ? ' · optional' : ''}`),
    node('span', 'module-mini-title', module.title),
    node('span', 'module-mini-meta', moduleMetaLine(totals))
  );
  mini.append(miniTile, text);
  mini.addEventListener('click', () => {
    openedModules.add(`${path.slug}#${module.number}`);
    delete card.dataset.collapsed;
    title.focus({ preventScroll: true });
  });
  card.append(mini);
  return card;
}

function labRows(entries, className) {
  const rows = node('div', className);
  for (const entry of entries) rows.append(labCard(entry));
  return rows;
}

/** best_score is a 0-1 fraction of the weighted points. */
const percent = (score) => Math.round((Number(score) <= 1 ? Number(score) * 100 : Number(score)) || 0);

function labCard({ lab, index, done, locked, lockedBy, lockedByTitle }) {
  const row = document.createElement('article');
  row.className = `lab${done ? ' lab-done' : ''}${locked ? ' lab-locked' : ''}`;
  // The slug is the lab's identity. It is rendered inside .lab-sub as
  // prose, where "hello" is also a substring of "gateway-hello", so
  // carry it as an attribute too: that is what lets anything selecting
  // a row — a test, a deep link — name one lab rather than a family of
  // labs whose names happen to overlap.
  row.dataset.slug = lab.slug;
  const titleId = `lab-title-${lab.slug}`;
  row.setAttribute('aria-labelledby', titleId);
  row.innerHTML = `
    <span class="lab-num" aria-hidden="true"></span>
    <div class="lab-meta">
      <h4 class="lab-title"></h4>
      <div class="lab-sub"></div>
    </div>
    <div class="lab-act">
      <div class="lab-status"></div>
      <button class="btn lab-start">Start</button>
    </div>
    <details class="lab-more">
      <summary>About this lab</summary>
      <p class="lab-summary"></p>
      <div class="lab-objectives-wrap">
        <p class="lab-objectives-label">You will practise</p>
        <ul class="lab-objectives"></ul>
      </div>
    </details>`;
  row.querySelector('.lab-num').textContent = String(index);
  const title = row.querySelector('.lab-title');
  title.id = titleId;
  title.textContent = lab.title;

  // Enough to choose a lab without spending a container to find out what
  // it is — "Hello, sandbox" says nothing about what you would actually do —
  // one click away so the row itself stays a single line of facts.
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
  row.querySelector('.lab-more').hidden = !lab.summary && !(lab.objectives ?? []).length;

  // One fact per chip, but the row's text stays the plain
  // "slug@version · family · type · difficulty · N min" line that support
  // and the browser suite read: the separators are real text, only hidden
  // visually, so nothing that reads .lab-sub sees a different string. The
  // chips are shown in a different order (type first) by CSS `order`.
  const facts = [
    ['id', `${lab.slug}@${lab.version}`],
    ['family', lab.family],
    ['type', lab.type],
  ];
  if (lab.difficulty) facts.push(['difficulty', lab.difficulty]);
  // The expected time and the kill timer are different promises: say both
  // when the manifest gives both.
  if (lab.estimated_minutes) {
    facts.push(['time', `~${lab.estimated_minutes} min`, lab.timeout_minutes ? ` · ${lab.timeout_minutes} min limit` : '']);
  } else if (lab.timeout_minutes) {
    facts.push(['time', `${lab.timeout_minutes} min`]);
  }
  if (lab.tier === 'free') facts.push(['tier', 'Free']);
  const sub = row.querySelector('.lab-sub');
  facts.forEach(([kind, text, limit], i) => {
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
    if (kind === 'time') {
      chip.title = lab.estimated_minutes
        ? `Expected about ${lab.estimated_minutes} min to finish${lab.timeout_minutes ? `; the session ends after ${lab.timeout_minutes} min` : ''}`
        : 'Hard time limit for the session';
    }
    chip.textContent = text;
    if (limit) chip.append(node('span', 'chip-limit', limit));
    sub.append(chip);
  });

  // Where this person stands: done with the best score, locked until a
  // named lab passes, in progress, or not started.
  const status = row.querySelector('.lab-status');
  const button = row.querySelector('.lab-start');
  if (done) {
    status.append(node('span', 'chip chip-done', `Done · best ${percent(lab.progress.best_score)}%`));
  } else if (locked) {
    const need = lockedByTitle ?? lockedBy;
    const lock = node('span', 'lab-lock');
    lock.append(icon('lock', 14), document.createTextNode(`Locked until ${need} passes`));
    status.append(lock);
    // aria-disabled rather than disabled: it stays focusable, so its title
    // (the reason) is reachable, and a click is simply ignored.
    button.setAttribute('aria-disabled', 'true');
    button.title = `Locked until ${need} passes. Pass every check of that lab to unlock this one.`;
  } else if (lab.progress?.attempts > 0) {
    const best = Number.isFinite(Number(lab.progress.best_score)) && lab.progress.best_score !== null;
    status.append(node('span', 'lab-state', best ? `In progress · best ${percent(lab.progress.best_score)}%` : 'In progress'));
  } else {
    status.append(node('span', 'lab-state', 'Not started'));
  }
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    beginLab(lab, row);
  });
  styleStartButton(row);
  if (lab.slug === runningSlug) applyRunning(row, true);
  return row;
}

/**
 * What the row's button says and how it looks: Start (the dark one), Open again
 * for a lab already passed, Rejoin for the lab that is running, and a quiet
 * Locked while a prerequisite stands in the way.
 */
function styleStartButton(row) {
  const button = row.querySelector('.lab-start');
  const running = row.classList.contains('lab-running');
  const locked = row.classList.contains('lab-locked');
  const done = row.classList.contains('lab-done');
  button.textContent = locked ? 'Locked' : running ? 'Rejoin' : done ? 'Open again' : 'Start';
  button.className = `btn lab-start ${locked ? 'btn-ghost' : running ? 'btn-accent' : done ? 'btn-ghost' : 'btn-strong'}`;
}

/** Marks a row as the lab that is running (or clears it), keeping the status line and the button in step. */
function applyRunning(row, on) {
  row.classList.toggle('lab-running', on);
  const status = row.querySelector('.lab-status');
  const badge = status.querySelector('.badge-running');
  if (on && !badge) status.prepend(node('span', 'badge badge-running', 'Running'));
  if (!on && badge) badge.remove();
  styleStartButton(row);
}

/** The launcher learns which lab is running once the resume card has asked the API. */
function setRunningLab(slug) {
  runningSlug = slug;
  for (const row of $('labList').querySelectorAll('.lab')) applyRunning(row, row.dataset.slug === slug && !row.classList.contains('lab-locked'));
  // The module holding it opens, if the path had condensed it.
  const row = slug ? $('labList').querySelector(`.lab[data-slug="${CSS.escape(slug)}"]`) : null;
  const module = row?.closest('.module');
  if (module?.dataset.collapsed) delete module.dataset.collapsed;
}

// ------------------------------------------------------------ path navigator

/**
 * The strip of pills above the filters: one per path, with its lab count.
 * A pill scrolls to its path and moves focus to the heading; the pill of the
 * path in view is marked aria-current. They are real links (#path-…), so
 * they work by keyboard and without this code.
 */
function renderPathNav(model) {
  const nav = $('pathNav');
  const items = $('pathNavList');
  items.innerHTML = '';
  pathPin = null;
  // One group needs no signpost.
  nav.hidden = model.paths.length < 2;
  for (const path of model.paths) {
    const id = path.other ? 'path-other' : `path-${safeId(path.slug)}`;
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${id}`;
    link.className = 'path-pill';
    link.dataset.path = path.slug;
    link.dataset.accent = path.accent;
    const glyph = node('span', 'pill-icon');
    glyph.append(icon(path.icon || 'grid', 14));
    // "6 labs" in words on a wide screen; the unit is dropped on a phone (styles.css).
    const meta = node('span', 'pill-meta');
    meta.append(node('span', 'pill-count', String(path.totals.labs)), document.createTextNode(' '), node('span', 'pill-unit', path.totals.labs === 1 ? 'lab' : 'labs'));
    link.append(glyph, node('span', 'pill-title', path.title), meta);
    link.addEventListener('click', (event) => {
      event.preventDefault();
      goToPath(id);
    });
    li.append(link);
    items.append(li);
  }
  updatePathNav();
}

/** After a click the clicked pill stays marked until the page has settled and then moves again. */
let pathPin = null;

function goToPath(id) {
  const section = document.getElementById(id);
  if (!section || section.hidden) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  pathPin = { id, settled: false, timer: setTimeout(() => pathPin && (pathPin.settled = true), 300) };
  section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  section.querySelector('.group-head').focus({ preventScroll: true });
  markActivePath();
}

/** Filters change which paths and how many labs are shown; the pills follow. */
function updatePathNav() {
  const pills = [...$('pathNavList').querySelectorAll('.path-pill')];
  let visible = 0;
  for (const link of pills) {
    const section = document.getElementById(link.getAttribute('href').slice(1));
    const shown = section ? section.querySelectorAll('.lab:not([hidden])').length : 0;
    link.parentElement.hidden = !section || section.hidden;
    if (!link.parentElement.hidden) visible++;
    link.querySelector('.pill-count').textContent = String(shown);
    link.querySelector('.pill-unit').textContent = shown === 1 ? 'lab' : 'labs';
  }
  // One group needs no signpost, and neither does a list with nothing in it.
  $('pathNav').hidden = pills.length < 2 || visible === 0;
  markActivePath();
}

function markActivePath() {
  const nav = $('pathNav');
  if (nav.hidden) return;
  const sections = [...$('labList').querySelectorAll('.lab-group')].filter((s) => !s.hidden);
  if (!sections.length) return;
  let active = sections[0];
  if (pathPin && sections.some((s) => s.id === pathPin.id)) {
    active = sections.find((s) => s.id === pathPin.id);
  } else {
    // The last path whose top has passed just under the navigator.
    const line = nav.getBoundingClientRect().bottom + 24;
    for (const section of sections) if (section.getBoundingClientRect().top <= line) active = section;
    // A short last path can never reach the line; the end of the page is it.
    const launcher = $('launcher');
    const scroller = launcher.scrollHeight > launcher.clientHeight + 1 ? launcher : document.scrollingElement;
    const scrolled = scroller.scrollTop > 0;
    if (scrolled && Math.ceil(scroller.scrollTop + scroller.clientHeight) >= scroller.scrollHeight - 2) {
      active = sections[sections.length - 1];
    }
  }
  const list = $('pathNavList');
  for (const link of list.querySelectorAll('.path-pill')) {
    if (link.getAttribute('href') !== `#${active.id}`) {
      link.removeAttribute('aria-current');
      continue;
    }
    if (link.getAttribute('aria-current') === 'true') continue;
    link.setAttribute('aria-current', 'true');
    // The strip scrolls sideways on a narrow screen: keep the current pill in it.
    const strip = list.getBoundingClientRect();
    const pill = link.getBoundingClientRect();
    if (pill.left < strip.left) list.scrollLeft += pill.left - strip.left - 8;
    else if (pill.right > strip.right) list.scrollLeft += pill.right - strip.right + 8;
  }
}

let activeFrame = 0;
function onLauncherScroll() {
  // Any scroll after the page has settled on a clicked pill is the reader's own.
  if (pathPin) {
    if (pathPin.settled) pathPin = null;
    else {
      clearTimeout(pathPin.timer);
      pathPin.timer = setTimeout(() => pathPin && (pathPin.settled = true), 150);
    }
  }
  if (activeFrame) return;
  activeFrame = requestAnimationFrame(() => {
    activeFrame = 0;
    markActivePath();
  });
}
// The reader's own input ends a clicked pill's hold at once, wherever it scrolls.
const releasePathPin = () => {
  pathPin = null;
};
for (const target of [$('launcher'), window]) {
  target.addEventListener('wheel', releasePathPin, { passive: true });
  target.addEventListener('touchmove', releasePathPin, { passive: true });
}
window.addEventListener('keydown', (event) => {
  if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) releasePathPin();
});
// The launcher scrolls itself on a desktop and the page scrolls on a phone.
$('launcher').addEventListener('scroll', onLauncherScroll, { passive: true });
window.addEventListener('scroll', onLauncherScroll, { passive: true });
window.addEventListener('resize', onLauncherScroll);

// ------------------------------------------------------------ filters

const FILTERS_KEY = 'opalixFilters';
const filters = { q: '', difficulty: new Set(), family: new Set(), status: new Set() };

function restoreFilters() {
  try {
    const saved = JSON.parse(lsGet(FILTERS_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return;
    filters.q = typeof saved.q === 'string' ? saved.q : '';
    for (const key of ['difficulty', 'family', 'status']) {
      filters[key] = new Set(Array.isArray(saved[key]) ? saved[key].filter((v) => typeof v === 'string') : []);
    }
  } catch {
    /* unreadable saved filters are no filters */
  }
}
restoreFilters();

function saveFilters() {
  lsSet(
    FILTERS_KEY,
    JSON.stringify({
      q: filters.q,
      difficulty: [...filters.difficulty],
      family: [...filters.family],
      status: [...filters.status],
    })
  );
}

const filtersActive = () =>
  Boolean(filters.q.trim()) || filters.difficulty.size > 0 || filters.family.size > 0 || filters.status.size > 0;

/** Search box and one row of toggle chips per facet; the chips are real buttons with aria-pressed. */
function renderFilters(labs) {
  const host = $('filterChips');
  host.innerHTML = '';
  const families = [...new Set(labs.map((lab) => lab.family).filter(Boolean))].sort();
  // A saved family that has since left the catalogue would hide everything.
  filters.family = new Set([...filters.family].filter((f) => families.includes(f)));
  const facets = [
    ['difficulty', 'Difficulty', DIFFICULTIES.map((d) => [d, d])],
    ['family', 'Family', families.map((f) => [f, f])],
    ['status', 'Status', STATUS_FILTERS],
  ];
  for (const [key, label, options] of facets) {
    if (!options.length) continue;
    const group = document.createElement('div');
    group.className = 'chip-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    const name = document.createElement('span');
    name.className = 'chip-group-label';
    name.setAttribute('aria-hidden', 'true');
    name.textContent = label;
    group.append(name);
    for (const [value, text] of options) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'filter-chip';
      chip.dataset.filter = key;
      chip.dataset.value = value;
      chip.textContent = text;
      chip.setAttribute('aria-pressed', String(filters[key].has(value)));
      chip.addEventListener('click', () => {
        if (!filters[key].delete(value)) filters[key].add(value);
        chip.setAttribute('aria-pressed', String(filters[key].has(value)));
        saveFilters();
        applyFilters();
      });
      group.append(chip);
    }
    host.append(group);
  }
  $('labSearch').value = filters.q;
  $('labFilters').hidden = false;
}

function labMatches(lab) {
  const q = filters.q.trim().toLowerCase();
  if (q && !`${lab.title} ${lab.summary ?? ''} ${lab.slug}`.toLowerCase().includes(q)) return false;
  if (filters.difficulty.size && !filters.difficulty.has(lab.difficulty)) return false;
  if (filters.family.size && !filters.family.has(lab.family)) return false;
  if (filters.status.size && !filters.status.has(labStatus(lab))) return false;
  return true;
}

/** Hides what does not match rather than rebuilding, so a launch error inside a card survives typing. */
function applyFilters() {
  const list = $('labList');
  const cards = [...list.querySelectorAll('.lab')];
  let shown = 0;
  for (const card of cards) {
    const lab = labsBySlug.get(card.dataset.slug);
    const match = Boolean(lab) && labMatches(lab);
    card.hidden = !match;
    if (match) shown++;
  }
  // A module or a path with nothing left to show goes too, and the navigator follows.
  for (const module of list.querySelectorAll('.module')) module.hidden = !module.querySelector('.lab:not([hidden])');
  for (const group of list.querySelectorAll('.lab-group')) group.hidden = !group.querySelector('.lab:not([hidden])');
  updatePathNav();
  // A module the path had condensed opens for a search or filter, so a match is never out of sight.
  list.classList.toggle('is-filtering', filtersActive());
  $('labCount').textContent = `${shown} of ${cards.length} labs`;
  $('labNoMatch').hidden = shown > 0 || !cards.length;
  $('btnClearFilters').hidden = !filtersActive();
}

function clearFilters() {
  filters.q = '';
  filters.difficulty.clear();
  filters.family.clear();
  filters.status.clear();
  saveFilters();
  $('labSearch').value = '';
  for (const chip of $('filterChips').querySelectorAll('.filter-chip')) chip.setAttribute('aria-pressed', 'false');
  applyFilters();
}

// -------------------------------------------------------------- resume card

let resumeToken = 0;

/**
 * The lab this browser remembers, if the API says it is still up:
 * `{ saved, status, slug, title }`, else null. The status is asked without
 * recovery: a refused token means the remembered session is gone, not that one
 * should be started to find out.
 */
async function fetchRunning() {
  const saved = rememberedSession();
  if (!saved?.id || !saved?.token || state.session) return null;
  let status;
  try {
    status = await api.status(saved.id, saved.token, { recover: false });
  } catch {
    return null;
  }
  const running = status?.meta?.state;
  if (running !== 'running' && running !== 'starting') return null;
  const slug = status.meta.lab_slug ?? saved.lab;
  return { saved, status, slug, title: labsBySlug.get(slug)?.title ?? slug };
}

/** "Pick up where you left off." beside the running lab, else "Pick your next lab." */
function setHero(resuming) {
  $('heroTitle').replaceChildren(
    document.createTextNode(resuming ? 'Pick up where you ' : 'Pick your next '),
    node('span', 'mark', resuming ? 'left off.' : 'lab.')
  );
}

/** "41:12 left" from the status the API gave, ticking; `set` receives the text. */
function startCountdown(status, set) {
  clearInterval(state.resumeTimer);
  const skew = Number.isFinite(status.server_time) ? status.server_time - Date.now() : 0;
  const expires = status.meta.expires_at;
  const tick = () => {
    if (!expires) return set('');
    const ms = expires - skew - Date.now();
    set(ms > 0 ? `${formatClock(ms)} left` : 'time is up');
  };
  tick();
  state.resumeTimer = setInterval(tick, 1000);
}

/**
 * "You have a lab running". The launcher is what a learner sees after a
 * sign-in that lost the tab, or a session that was left with the remembered
 * record still in place; either way the lab is there and the fastest thing
 * to offer is the way back into it. It is the navy card beside the hero, and
 * the hero says so ("Pick up where you left off").
 */
async function renderResumeCard() {
  const host = $('resumeCard');
  const mine = ++resumeToken;
  clearInterval(state.resumeTimer);
  host.hidden = true;
  host.replaceChildren();
  setHero(false);
  setRunningLab(null);
  const found = await fetchRunning();
  if (!found || mine !== resumeToken || state.session) return;
  const { saved, status, slug, title } = found;

  const live = node('span', 'resume-live');
  live.append(document.createElement('i'), document.createTextNode('RUNNING'));
  const left = node('span', 'resume-left mono');
  const row = node('div', 'resume-row');
  row.append(live, left);

  // Where it sits ("Gateway and access · lab 3 of 6") and how it is going.
  const where = locateLab(launcherModel, slug);
  const latest = status.checks?.results;
  const passed = Array.isArray(latest) ? latest.filter((r) => r.pass).length : 0;
  const parts = [];
  if (where) parts.push(where.module.known ? where.module.title : where.path.title, `lab ${where.position} of ${where.total}`);
  if (Array.isArray(latest) && latest.length) parts.push(`${passed} of ${latest.length} checks passing`);

  const buttons = node('div', 'resume-actions');
  const rejoin = node('button', 'btn btn-accent');
  rejoin.type = 'button';
  rejoin.id = 'btnRejoin';
  rejoin.append(document.createTextNode('Rejoin the lab'), uiIcon('arrow', 14));
  const discard = node('button', 'btn btn-quiet', 'End session');
  discard.type = 'button';
  discard.id = 'btnDiscard';
  buttons.append(rejoin, discard);

  host.append(row, node('p', 'resume-title', title));
  if (parts.length) host.append(node('p', 'resume-sub', parts.join(' · ')));
  if (Array.isArray(latest) && latest.length) host.append(progressBar(passed, latest.length, 'Checks passing in the latest run'));
  host.append(buttons);

  startCountdown(status, (text) => (left.textContent = text));
  rejoin.addEventListener('click', () => {
    // A phone cannot run a lab: say so instead of starting (or rejoining) one.
    if (guardDesktop()) return;
    startSession(slug, host);
  });
  discard.addEventListener('click', () => discardRemembered(saved, host));
  host.hidden = false;
  setHero(true);
  setRunningLab(slug);
}

/**
 * Ends the remembered lab without opening it. The record is dropped only
 * once the API has agreed the session is over: forgetting first would leave
 * a container running that nothing on this browser can reach.
 */
async function discardRemembered(saved, host) {
  if (!confirm('Discard the running lab? Its container is destroyed and unsaved work is lost.')) return;
  const button = host.querySelector('#btnDiscard');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await api.end(saved.id, saved.token, false);
    forgetSession();
    clearInterval(state.resumeTimer);
    host.hidden = true;
    host.replaceChildren();
    setHero(false);
    setRunningLab(null);
  } catch (err) {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    toast(`Could not discard the lab — ${err.message}`, 'bad');
  }
}

// ------------------------------------------------------- the desktop notice

/*
 * A lab needs a wide screen (terminal, editor and checks side by side), so on
 * a phone Start and Rejoin show this screen instead of starting anything: no
 * request is made and no container is claimed. Reading still works on a phone,
 * so only those two actions are gated. The test is device.js; it is asked when
 * the learner tries, and again on resize and on rotation, so a window widened
 * to a desktop size brings the launcher back.
 */

/** Shows the notice and returns true when this screen is too small to start a lab. */
function guardDesktop() {
  if (!isPhoneLike(readDevice())) return false;
  showDesktopNotice();
  return true;
}

async function showDesktopNotice() {
  hideLearnScreen();
  $('launcher').hidden = true;
  const url = `${location.origin}/`;
  $('dnEmail').href = `mailto:?subject=${encodeURIComponent('Opalix labs: open this on a desktop')}&body=${encodeURIComponent(`Open this link on a laptop or desktop to start a lab: ${url}`)}`;
  $('dnUrl').value = url;
  $('dnManual').hidden = true;
  $('dnCopyText').textContent = 'Copy the link';
  $('dnStatus').textContent = '';
  $('dnRunning').hidden = true;
  $('desktopNotice').hidden = false;
  $('desktopNotice').scrollTop = 0;
  window.scrollTo(0, 0);
  $('dnTitle').focus();
  syncQuizButtons();
  // The lab that is still running, if there is one: it can be rejoined from a computer.
  const token = ++noticeToken;
  const found = await fetchRunning();
  if (!found || token !== noticeToken || $('desktopNotice').hidden) return;
  $('dnRunningTitle').textContent = found.title;
  startCountdown(found.status, (text) => ($('dnRunningMeta').textContent = `${text ? `${text} · ` : ''}rejoin from a computer`));
  $('dnRunning').hidden = false;
}
let noticeToken = 0;

function hideDesktopNotice({ focus = true } = {}) {
  noticeToken++;
  $('desktopNotice').hidden = true;
  $('launcher').hidden = false;
  clearInterval(state.resumeTimer);
  // The launcher's own card ticks again.
  renderResumeCard();
  syncQuizButtons();
  if (focus) {
    const heading = $('heroTitle');
    heading.focus({ preventScroll: true });
  }
}

$('dnBrowse').addEventListener('click', () => hideDesktopNotice());

/** Copies the link; where the clipboard cannot be written, shows it selected instead. */
$('dnCopy').addEventListener('click', async () => {
  const url = `${location.origin}/`;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(url);
    $('dnManual').hidden = true;
    $('dnCopyText').textContent = 'Copied';
    $('dnStatus').textContent = 'Link copied.';
    setTimeout(() => {
      $('dnCopyText').textContent = 'Copy the link';
    }, 2500);
  } catch {
    $('dnManual').hidden = false;
    $('dnUrl').focus();
    $('dnUrl').select();
    $('dnStatus').textContent = 'The link is selected. Copy it with your keyboard.';
  }
});

// A window widened to a desktop size (or a phone turned sideways into one) has no use for the notice.
function reevaluateDevice() {
  if (!$('desktopNotice').hidden && !isPhoneLike(readDevice())) hideDesktopNotice({ focus: false });
}
window.addEventListener('resize', reevaluateDevice);
window.addEventListener('orientationchange', reevaluateDevice);

// -------------------------------------------------------------- onboarding

const ONBOARDED_KEY = 'opalixOnboarded';

/** Once per browser, on the launcher; the header "?" opens it again on demand. */
function showOnboarding() {
  const dialog = $('onboarding');
  syncQuizButtons();
  if (!dialog.open) dialog.showModal();
}

function maybeShowOnboarding() {
  if (!lsGet(ONBOARDED_KEY)) showOnboarding();
}

// ---------------------------------------------------------------- learning

/*
 * The learning flow: the platform quiz (once, then on request), "Before you
 * begin" between Start and the boot for a lab that has learning content, and
 * in a session the Learn and Questions tabs. Everything a lab teaches comes
 * from its learn bundle (GET /api/learn/:slug); a lab without one, or a
 * bundle that cannot be fetched, behaves exactly as it did before.
 */

/** The screen that stands in for the launcher while a quiz or "Before you begin" is up. */
let learnFlow = null;

function showLearnScreen() {
  $('launcher').hidden = true;
  $('learnScreen').hidden = false;
  $('learnScreen').scrollTop = 0;
  syncQuizButtons();
}

function hideLearnScreen() {
  learnFlow?.destroy();
  learnFlow = null;
  $('learnScreen').hidden = true;
  $('learnHost').replaceChildren();
  syncQuizButtons();
}

/** Back to the lab list from a learning screen, with focus on the page's heading. */
function leaveLearnScreen() {
  hideLearnScreen();
  $('launcher').hidden = false;
  const heading = $('launcher').querySelector('h1');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

/** A lab's bundle, kept a few minutes so Before you begin and the session share one fetch. */
const learnCache = new Map();
const LEARN_TTL_MS = 5 * 60_000;

/** `{version, learn}` for a lab, or null when it has none or the fetch failed. Never throws. */
async function fetchLearn(slug) {
  const hit = learnCache.get(slug);
  if (hit && Date.now() - hit.at < LEARN_TTL_MS) return hit.entry;
  try {
    const entry = normalizeLearn(await api.learn(slug));
    if (entry) learnCache.set(slug, { at: Date.now(), entry });
    return entry;
  } catch {
    return null;
  }
}

/**
 * Start on a lab card. A lab with learning content goes through "Before you
 * begin" first; everything else (no content, the fetch failing, a session
 * already running that Start would only rejoin) goes straight to the boot.
 */
let beginning = false;
async function beginLab(lab, card) {
  if (beginning) return;
  // Start, Open again and Rejoin all come through here: on a phone they show the desktop notice.
  if (guardDesktop()) return;
  // A running lab is rejoined by Start, whatever was clicked: nothing to prepare for.
  const resuming = !$('resumeCard').hidden;
  if (!lab.has_learn || resuming) return startSession(lab.slug, card);
  beginning = true;
  const buttons = document.querySelectorAll('.lab button, .resume button');
  buttons.forEach((b) => (b.disabled = true));
  const button = card?.querySelector('.lab-start');
  const label = button?.textContent;
  if (button) {
    button.textContent = 'Loading…';
    button.setAttribute('aria-busy', 'true');
  }
  let entry = null;
  try {
    entry = await fetchLearn(lab.slug);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    if (button) {
      button.textContent = label;
      button.removeAttribute('aria-busy');
    }
    beginning = false;
  }
  const hasScreen = entry && (entry.learn.story || entry.learn.concepts.length > 0);
  if (!hasScreen) return startSession(lab.slug, card);
  showLearnScreen();
  learnFlow = runBeforeYouBegin({
    host: $('learnHost'),
    lab: { slug: lab.slug, title: lab.title },
    entry,
    store: mastery,
    post: (body) => api.postAnswers(body),
    // The screen may have shrunk since Start was pressed: ask again before a container is claimed.
    onStart: () => (guardDesktop() ? undefined : startSession(lab.slug)),
    onBack: leaveLearnScreen,
  });
}

// --- the platform quiz

/** The quiz as the API serves it, or null: none published, or the call failed. */
let onboardingOffer = null;

async function loadOnboardingOffer() {
  try {
    return normalizeOnboarding(await api.onboarding());
  } catch {
    return null;
  }
}

/** The two "Retake the quiz" controls show only when a quiz exists and the learner is at the launcher. */
function syncQuizButtons() {
  const atLauncher = !state.session && $('learnScreen').hidden && $('desktopNotice').hidden;
  $('btnRetakeQuiz').hidden = !(onboardingOffer && atLauncher);
  $('btnOnboardingRetake').hidden = !(onboardingOffer && atLauncher);
}

function showQuiz() {
  if (!onboardingOffer || state.session) return;
  if ($('onboarding').open) $('onboarding').close();
  hideLearnScreen();
  showLearnScreen();
  learnFlow = runOnboarding({
    host: $('learnHost'),
    onboarding: onboardingOffer,
    store: mastery,
    post: (body) => api.postAnswers(body),
    onExit: ({ completed }) => {
      leaveLearnScreen();
      // The launcher's "Suggested start" follows the new levels.
      if (completed) loadLabs();
    },
  });
}

/**
 * After the launcher is up: find out whether there is a quiz, show the
 * retake control, and offer the quiz itself once (after the first-run
 * "How this console works" dialog has been read, if that is showing).
 */
async function initLearning() {
  onboardingOffer = await loadOnboardingOffer();
  syncQuizButtons();
  if (!onboardingOffer || state.session || onboardingFinished(mastery.get())) return;
  const dialog = $('onboarding');
  if (dialog.open) await new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
  // Someone may have started a lab, or opened another screen, meanwhile.
  if (state.session || !$('learnScreen').hidden || $('launcher').hidden || onboardingFinished(mastery.get())) return;
  showQuiz();
}

// --- in a session

/** What the running session shows of its lab's bundle. */
const learnSession = { id: '', learn: null, story: null, lessons: null, form: null };

/** Removes the guide's Story, Lessons and Questions and everything behind them. */
function resetLearnSession() {
  learnSession.story?.destroy();
  learnSession.lessons?.destroy();
  learnSession.form?.destroy();
  learnSession.learn = null;
  learnSession.story = null;
  learnSession.lessons = null;
  learnSession.form = null;
  learnSession.id = '';
  for (const id of ['storyBody', 'lessonsBody', 'questionsBody']) $(id).replaceChildren();
}

/**
 * Builds the guide's Story and Lessons and, for a lab with graded fields, its
 * Questions. Called once the session is running; a restart of the container
 * reuses what is there so unsaved answers are not lost.
 */
async function loadLearn() {
  const session = state.session;
  if (!session || !state.lab?.has_learn) return;
  if (learnSession.id === session.id) {
    learnSession.form?.reload();
    return;
  }
  const entry = await fetchLearn(session.lab);
  if (!entry || state.session !== session || learnSession.id === session.id) return;
  learnSession.id = session.id;
  const { learn } = entry;
  learnSession.learn = learn;

  const questions = learn.fields.length > 0 && SAFE_FILE.test(learn.answers_file);
  const tabs = guideTabsFor({ type: state.lab?.type, story: hasStory(learn), lessons: hasLessons(learn), questions });
  if (tabs.includes('story')) learnSession.story = buildStoryTab($('storyBody'), { learn });
  if (tabs.includes('lessons')) {
    learnSession.lessons = buildLessonsTab($('lessonsBody'), {
      learn,
      mastery: mastery.get(),
      withStory: !tabs.includes('story'),
      onProgress: (p) => {
        guide.lessons = p;
        updateBadges();
      },
    });
  }

  if (questions) {
    const file = learn.answers_file;
    const current = () => state.session;
    learnSession.form = mountQuestionsForm($('questionsBody'), {
      fields: learn.fields,
      file,
      onProgress: (p) => {
        guide.answers = p;
        updateBadges();
        renderDock();
      },
      io: {
        read: async () => {
          const s = current();
          try {
            const result = await api.readFile(s.id, s.token, file);
            return typeof result === 'string' ? result : (result?.content ?? '');
          } catch (err) {
            if (/^404:/.test(err.message)) return null;
            throw err;
          }
        },
        write: async (text) => {
          const s = current();
          await api.writeFile(s.id, s.token, file, text);
          hideIdleBanner();
        },
        onWritten: (text) => {
          // The file changed under the editor: show it, unless there are edits there to lose.
          if (state.openFile === file && !state.dirty && state.editor) state.editor.load(text, file);
          refreshFiles();
        },
      },
      runChecks: async () => {
        const run = await runChecks();
        return run?.results?.length ? `Latest run: ${summaryText(tally(run.results))}` : 'The checks could not run. See the Checks panel.';
      },
    });
    learnSession.form.reload();
  }
}

// ------------------------------------------------------------ the guide

/*
 * The guide is the reading pane beside the workspace: a tablist of the lab's
 * Story, Lessons, Brief, Questions, Checks, Hints and Solution (session-layout.js
 * says which a lab has and in what order). It can be hidden, and then a rail of
 * icons stands in for it; each icon reopens it on that tab. Whether it is open
 * is decided when a lab starts (from the window's width) and is never
 * remembered: every lab opens with its guide open on a wide screen.
 */

const guide = {
  open: true,
  /** The active tab's id, and every tab the lab has, in order. */
  tab: null,
  tabs: [],
  /** The lab's learn bundle has been looked at (or there is none), so the tabs are final. */
  ready: false,
  lessons: { read: 0, total: 0 },
  answers: { answered: 0, total: 0 },
  checks: { passed: 0, count: 0 },
  /** 'checks', or 'answers' for a lab graded through its questions. */
  kind: 'checks',
};

const GUIDE_PANEL = {
  story: 'viewStory',
  lessons: 'viewLessons',
  brief: 'viewBrief',
  questions: 'viewQuestions',
  checks: 'viewChecks',
  hints: 'viewHints',
  solution: 'viewSolution',
};
const RAIL_ICON = {
  story: 'i-story',
  lessons: 'i-cap',
  brief: 'i-list',
  questions: 'i-question',
  checks: 'i-checks',
  hints: 'i-bulb',
  solution: 'i-key',
};
const VISIBLE_BADGES = new Set(['lessons', 'questions', 'checks']);
const guideTab = (id) => $(`tab${id[0].toUpperCase()}${id.slice(1)}`);

/** A status line for screen readers: the checks' outcome, a finished lab. */
function announce(text) {
  $('sessionLive').textContent = '';
  // Set on the next turn so the same words said twice are still said.
  setTimeout(() => ($('sessionLive').textContent = text), 50);
}

/** Opens or hides the guide. Focus is the caller's business (what it moves to depends on what was pressed). */
function setGuideOpen(open) {
  guide.open = open;
  $('workspace').dataset.guide = open ? 'open' : 'closed';
  $('guide').hidden = !open;
  $('guideRail').hidden = open;
  const toggle = $('btnGuideToggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.querySelector('.btn-label').textContent = open ? 'Hide guide' : 'Show guide';
}

/** Shows one tab's panel. `reveal` opens a hidden guide on it; `focus` puts the keyboard on the tab. */
function showGuideTab(id, { reveal = false, focus = false } = {}) {
  if (!guide.tabs.includes(id)) return;
  const changed = guide.tab !== id;
  guide.tab = id;
  for (const key of Object.keys(GUIDE_TABS)) {
    const tab = guideTab(key);
    const on = key === id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    tab.classList.toggle('tab-active', on);
    $(GUIDE_PANEL[key]).classList.toggle('gview-active', on);
  }
  for (const b of $('railTabs').children) {
    if (b.dataset.railTab === id) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
  if (reveal && !guide.open) setGuideOpen(true);
  if (changed) $('guideBody').scrollTop = 0;
  const tab = guideTab(id);
  if (guide.open) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focus) tab.focus();
  // Answers may have been edited in the editor since the form last looked.
  if (id === 'questions') learnSession.form?.reload();
}

/** The badges on the tabs and the rail, from what the session knows now. */
function updateBadges() {
  const hints = state.hints;
  const ctx = {
    lessons: guide.lessons,
    questions: guide.answers,
    checks: guide.checks,
    hints: { delivered: hints?.delivered.length ?? 0, slots: hints ? hintSlots(hints) : 0 },
    solution: { unlocked: state.solution ? solutionUnlocked(state.solution) : undefined },
  };
  for (const id of Object.keys(GUIDE_TABS)) {
    const badge = tabBadge(id, ctx[id]);
    const tab = guideTab(id);
    const chip = tab.querySelector('.gtab-badge');
    // Hints and the Solution say their count and state to a screen reader and in the dock; the tab stays plain.
    const drawn = VISIBLE_BADGES.has(id) ? badge?.text : '';
    chip.textContent = drawn ?? '';
    chip.hidden = !drawn;
    chip.setAttribute('aria-hidden', 'true');
    tab.setAttribute('aria-label', railLabel(id, badge));
    const rail = [...$('railTabs').children].find((b) => b.dataset.railTab === id);
    if (rail) {
      rail.setAttribute('aria-label', railLabel(id, badge));
      const chip2 = rail.querySelector('.rail-badge');
      chip2.textContent = drawn ?? '';
      chip2.hidden = !drawn;
    }
  }
}

/** The rail's icons, one per tab the lab has. */
function renderRail() {
  const host = $('railTabs');
  host.replaceChildren();
  for (const id of guide.tabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rail-btn rail-tab';
    button.dataset.railTab = id;
    button.append(spriteIcon(RAIL_ICON[id], 20));
    const chip = document.createElement('span');
    chip.className = 'rail-badge';
    chip.setAttribute('aria-hidden', 'true');
    button.append(chip);
    // Reopens the guide on this tab, and the keyboard goes with it.
    button.addEventListener('click', () => showGuideTab(id, { reveal: true, focus: true }));
    host.append(button);
  }
}

/** Where the checks' results are read: their own tab, or (graded by questions) under the form. */
function placeChecksBlock() {
  const own = guide.tabs.includes('checks');
  const slot = $(own ? 'checksSlot' : 'questionsChecksSlot');
  const block = $('checksBlock');
  if (block.parentElement !== slot) slot.append(block);
  block.classList.toggle('questions-checks', !own);
  $('btnChecksInline').hidden = !own;
}

/** Sets which tabs the guide has, in order, keeping the learner where they are when they can be. */
function applyGuideTabs(tabs) {
  const reordered = tabs.join() !== guide.tabs.join();
  guide.tabs = tabs;
  guide.kind = dockKind(tabs);
  if (reordered) {
    const list = $('guideTabs');
    const focused = document.activeElement;
    for (const id of Object.keys(GUIDE_TABS)) guideTab(id).hidden = !tabs.includes(id);
    list.append(...tabs.map(guideTab));
    if (focused instanceof HTMLElement && list.contains(focused)) focused.focus();
    renderRail();
  }
  placeChecksBlock();
  $('answersTag').hidden = guide.kind !== 'answers';
  $('checksTag').hidden = guide.kind === 'answers';
  showGuideTab(tabs.includes(guide.tab) ? guide.tab : tabs[0]);
  updateBadges();
  renderDock();
  renderChecksButtons();
}

/** The tabs the lab has right now (the solution's presence changes while the lab runs). */
function currentGuideTabs() {
  const learn = learnSession.learn;
  return guideTabsFor({
    type: state.lab?.type,
    story: hasStory(learn),
    lessons: hasLessons(learn),
    questions: Boolean(learnSession.form),
    solution: Boolean(state.solution),
  });
}

/** Called when the lab's brief and learn bundle have been read (or failed): the tabs are final from here. */
function buildGuide() {
  if (!state.session) return;
  guide.ready = true;
  $('guide').dataset.ready = 'true';
  applyGuideTabs(currentGuideTabs());
}

/** The solution appeared or went: the tab follows, once the guide is built. */
function syncGuideTabs() {
  if (guide.ready) applyGuideTabs(currentGuideTabs());
}

/** A new lab: the guide starts open (on a wide window), on nothing yet. */
function resetGuide() {
  guide.tab = null;
  guide.tabs = [];
  guide.ready = false;
  guide.lessons = { read: 0, total: 0 };
  guide.answers = { answered: 0, total: 0 };
  guide.checks = { passed: 0, count: 0 };
  guide.kind = 'checks';
  $('guide').dataset.ready = 'false';
  for (const id of Object.keys(GUIDE_TABS)) {
    const tab = guideTab(id);
    tab.hidden = true;
    tab.setAttribute('aria-selected', 'false');
    tab.classList.remove('tab-active');
    $(GUIDE_PANEL[id]).classList.remove('gview-active');
  }
  $('railTabs').replaceChildren();
  $('checksSlot').append($('checksBlock'));
  $('checksBlock').classList.remove('questions-checks');
  $('btnChecksInline').hidden = false;
  $('answersTag').hidden = true;
  $('checksTag').hidden = false;
  setGuideOpen(defaultGuideOpen(window.innerWidth));
  $('guideBody').scrollTop = 0;
}

// ------------------------------------------------------------ the dock

/** The dock's progress, next hint, cost and action, and the header's two progress tags. */
function renderDock() {
  const kind = guide.kind;
  const { answered, total } = guide.answers;
  const { passed, count } = guide.checks;
  const planned = state.summary?.checks?.length ?? 0;
  const dots = kind === 'answers' ? answerDots(answered, total) : checkDots(state.lastResults, planned);
  const text = dockProgressText({ kind, answered, total, passed, count, planned });
  const hostDots = $('dockDots');
  hostDots.replaceChildren(...dots.map((d) => Object.assign(document.createElement('i'), { className: d === 'p' ? '' : d })));
  hostDots.setAttribute('aria-label', text);
  $('dockProgress').textContent = text;

  // Answers tag (an explore lab): dots and "2/3", in the header.
  $('tagDots').replaceChildren(...answerDots(answered, total).map((d) => Object.assign(document.createElement('i'), { className: d === 'p' ? '' : d })));
  $('statAnswers').textContent = total ? `${answered}/${total}` : NO_VALUE;

  const h = state.hints;
  const slots = h ? hintSlots(h) : 0;
  const locked = [];
  for (let i = 0; i < slots; i++) {
    if (h.delivered.some((d) => d.index === i)) continue;
    locked.push(state.startedAt ? hintRemainingMs(h.schedule[i] ?? 0) : null);
  }
  $('dockHint').textContent = hintCountdown({ locked, slots });
  renderChecksButtons();
}

/** The labels and enabled state of the three buttons that run the checks (header, Checks tab, dock). */
function renderChecksButtons() {
  const running = state.checksRunning;
  const live = Boolean(state.session) && $('statePill').dataset.state !== 'ended';
  const answers = guide.kind === 'answers';
  const setLabel = (button, label) => {
    const target = button.querySelector('.btn-label') ?? button;
    if (target.textContent !== label) target.textContent = label;
  };
  const action = dockAction({ kind: guide.kind, answered: guide.answers.answered, total: guide.answers.total });
  setLabel($('btnChecks'), running ? 'Running…' : answers ? 'Check answers' : 'Run checks');
  setLabel($('btnChecksInline'), running ? 'Running…' : 'Run checks');
  const dockRuns = action.action === 'checks';
  setLabel($('btnDockAction'), running && dockRuns ? 'Running…' : action.label);
  $('btnDockAction').dataset.action = action.action;
  for (const button of [$('btnChecks'), $('btnChecksInline')]) {
    button.disabled = running || !live;
    if (running) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }
  $('btnDockAction').disabled = (running && dockRuns) || !live;
  if (running && dockRuns) $('btnDockAction').setAttribute('aria-busy', 'true');
  else $('btnDockAction').removeAttribute('aria-busy');
}

/** The dock's button: take the learner to the questions, or run the checks. */
function dockPressed() {
  if ($('btnDockAction').dataset.action === 'questions') {
    showGuideTab('questions', { reveal: true });
    learnSession.form?.focusFirstUnanswered();
    return;
  }
  runChecks();
}

async function startSession(slug, card) {
  const error = $('launchError');
  error.hidden = true;
  error.className = 'notice notice-bad';
  const buttons = document.querySelectorAll('.lab button, .resume button');
  buttons.forEach((b) => (b.disabled = true));
  const button = card?.querySelector('button');
  // The resume card's button says "Rejoin", a lab card's says "Start".
  const label = button?.textContent;
  if (button) {
    button.textContent = 'Starting…';
    button.setAttribute('aria-busy', 'true');
  }
  try {
    // 503/409 mean no slot right now: say so and try again, instead of
    // reporting a failure the learner can do nothing about.
    const started = await api.startSession(slug, {
      retries: 5,
      onBusy: (attempt, retries, seconds) => {
        const text = `All lab slots are busy — retrying in ${seconds}s (attempt ${attempt} of ${retries})`;
        if ($('launcher').hidden) return toast(text, 'info', seconds * 1000);
        error.textContent = text;
        error.className = 'notice notice-warn';
        (card ?? $('launcher')).append(error);
        error.hidden = false;
      },
    });
    error.hidden = true;
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
    error.className = 'notice notice-bad';
    if ($('launcher').hidden) return toast(`Could not start this lab — ${err.message}`, 'bad');
    error.textContent = `Could not start this lab — ${err.message}`;
    (card ?? $('launcher')).append(error);
    error.hidden = false;
    error.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    if (button) {
      button.textContent = label;
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
  stopStreamFallback();
  hideIdleBanner();
  hideExpiryBanner();
  state.lastSeq = 0;
  state.bootUnhealthy = null;
  bootServices.clear();
  $('bootServices').innerHTML = '';
  state.openFile = null;
  state.dirty = false;
  state.expanded.clear();
  state.service = null;
  state.loadedService = null;
  state.serviceDown = null;
  state.serviceOpenSeq++;
  $('serviceDown').hidden = true;
  $('serviceFrame').hidden = false;
  state.checksRunning = false;
  $('checksPanel').innerHTML = '<p class="muted small">Not run yet. Run checks to grade your work so far.</p>';
  $('checksSummary').textContent = '';
  delete $('checksSummary').dataset.tone;
  $('hintsPanel').innerHTML = '<p class="muted small">Hints unlock on a timer as the lab goes on.</p>';
  $('hintSteps').replaceChildren();
  $('hintsMeta').textContent = '';
  state.lastResults = null;
  state.landed = false;
  resetSessionFeedback();
  $('fileList').innerHTML = '';
  $('serviceTabs').innerHTML = '';
  $('serviceList').innerHTML = '';
  $('servicesBlock').hidden = true;
  setServicesOpen(false);
  $('serviceFrame').removeAttribute('src');
  $('noticeList').innerHTML = '';
  $('noticeEmpty').hidden = false;
  $('noticeCount').textContent = '';
  $('activityPane').dataset.open = 'false';
  $('btnActivityToggle').hidden = true;
  $('btnActivityToggle').textContent = 'Show all';
  $('btnActivityToggle').setAttribute('aria-expanded', 'false');
  $('idleClock').hidden = true;
  $('editorPath').textContent = 'No file open';
  delete $('editorPath').dataset.dirty;
  // A new lab gets a new editor: the last one's document must not show under "No file open".
  state.editor?.destroy?.();
  state.editor = null;
  $('editorMount').replaceChildren();
  $('editorEmpty').hidden = false;
  $('editorStatus').textContent = '';
  $('btnSaveFile').disabled = true;
  $('endedBanner').hidden = true;
  $('termStatus').hidden = true;
  $('btnReconnectTerm').hidden = false;
  $('btnNewFile').disabled = false;
  $('expiryTimer').textContent = '';
  delete $('expiryTimer').dataset.urgent;
  $('briefBody').innerHTML = '<p class="muted">Loading the brief…</p>';
  // A new session starts without the last one's Story, Lessons and Questions, and with the guide open again.
  resetLearnSession();
  resetGuide();
  hideLearnScreen();
  // The task, not an empty terminal: the guide opens on the brief (or the story), and the workspace on the files.
  showView('editor');
  showBoot('Claiming a container…');

  $('launcher').hidden = true;
  $('workspace').hidden = false;
  $('sessionBar').hidden = false;
  $('sessionActions').hidden = false;
  $('btnBackToLabs').hidden = true;

  setSessionLab(state.session.lab);
  // The id is for support, not for the bar: it lives on the state pill's
  // tooltip, and in a visually hidden node so it can still be read out.
  $('sessionId').textContent = state.session.id;
  $('statePill').title = `Session ${state.session.id}`;
  clearInterval(state.resumeTimer);
  // The last session's 'ended' must not keep the new one's buttons off.
  setStatePill('starting');
  for (const id of ['btnChecks', 'btnChecksInline', 'btnDockAction', 'btnSnapshot', 'btnEnd']) $(id).disabled = false;
  $('btnGuideToggle').disabled = false;
  $('btnServiceRestart').disabled = false;
  renderDock();

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
    ['solution.unlocked', 'good'],
    ['check.started', 'info'],
    ['check.result', 'info'],
    ['check.finished', 'info'],
    ['snapshot.created', 'good'],
    ['cost', 'info'],
    ['llm.call', 'info'],
    ['alert', 'bad'],
  ];
  for (const [type, tone] of types) {
    es.addEventListener(type, (ev) => {
      // A stream reopened by hand starts from the last 50 events again.
      const seq = Number(ev.lastEventId) || 0;
      if (seq && seq <= state.lastSeq) return;
      if (seq) state.lastSeq = seq;
      handleEvent(type, tone, parse(ev.data));
    });
  }
  // `metrics` fires every 30s; it updates the header's cost, which is the
  // only place it is shown.
  es.addEventListener('metrics', (ev) => {
    const data = parse(ev.data);
    // The API sends `cost_usd`; `cost.usd` is the older shape.
    setCostStat(data?.cost_usd ?? data?.cost?.usd);
  });
  // The browser reconnects by itself and sends Last-Event-ID, so nothing
  // is lost across a blip. What the learner needs is to know the page is
  // not live meanwhile, and — if it stays down — for the console to keep
  // itself up to date some other way.
  es.onopen = () => {
    state.streamErrors = 0;
    setStreamPill(false);
    stopStreamFallback();
  };
  es.onerror = () => {
    state.streamErrors++;
    setStreamPill(true);
    // CLOSED means the browser has given up (a refused token, a bad
    // response) and will not retry on its own.
    if (state.streamErrors >= STREAM_ERRORS_BEFORE_POLLING || es.readyState === EventSource.CLOSED) startStreamFallback();
  };
}

const STREAM_ERRORS_BEFORE_POLLING = 3;
const STREAM_POLL_MS = 10_000;

function setStreamPill(on) {
  $('streamPill').hidden = !on;
}

/**
 * While the stream is down, ask for the status every 10s and feed it to the
 * same renderers the stream would have: state pill, checks, services. It
 * also reopens a stream the browser has abandoned. Stops on `onopen`.
 */
function startStreamFallback() {
  if (state.streamPoll || !state.session) return;
  const session = state.session;
  const tick = async () => {
    if (state.session !== session) return;
    try {
      if (state.events?.readyState === EventSource.CLOSED) openEventStream();
      const status = await api.status(session.id, session.token);
      if (state.session !== session) return;
      applyStatus(status);
    } catch {
      /* still down; the next tick asks again */
    }
    if (state.session === session && state.streamPoll) state.streamPoll = setTimeout(tick, STREAM_POLL_MS);
  };
  state.streamPoll = setTimeout(tick, 0);
}

function stopStreamFallback() {
  clearTimeout(state.streamPoll);
  state.streamPoll = 0;
  state.streamErrors = 0;
  setStreamPill(false);
}

/** What one status response says, applied the way the stream's events would have. */
function applyStatus(status) {
  const meta = status.meta ?? {};
  if (meta.state) setStatePill(meta.state);
  if (meta.state === 'ended') return onEnded(meta.end_reason);
  if (meta.state === 'running' && !runningHandled) return onRunning(status);
  if (meta.expires_at && meta.expires_at !== state.expiresAt) {
    state.expiresAt = meta.expires_at;
    startExpiryTimer();
  }
  absorbStatus(status);
  // Rebuilding the list would cancel a restart that is in flight.
  if (status.services && !$('serviceList').querySelector('[aria-busy="true"]')) renderServiceList(status.services);
}

function handleEvent(type, tone, data) {
  noticeFor(type, tone, data);
  bootProgress(type, data);

  if (type === 'session.idle_warning') showIdleBanner();
  if (type === 'session.state' && data?.state === 'ended') {
    confirmEnded(data.reason);
  } else if (type === 'session.state') {
    setStatePill(data.state);
    if (data.state === 'running') onRunning();
  }
  if (type === 'hint') renderHint(data);
  if (type === 'solution.unlocked') onSolutionUnlocked();
  if (type === 'check.finished' || type === 'check.result') refreshChecks();
  if (type === 'container.restarted') onContainerRestarted();
  if (type === 'service.health' && data?.service && data?.health) setServiceHealth(data.service, data.health);
}

/**
 * `session.state: ended` is only believed once the API agrees. The stream
 * replays its last 50 events to every new connection, so a session that
 * ended and was then resumed hands a reloaded console the old `ended`
 * ahead of the `running` that followed — and acting on it put the
 * dead-session screen over a lab that was up. If the check itself cannot be
 * made, the event is taken at its word.
 */
async function confirmEnded(reason) {
  const session = state.session;
  if (!session) return;
  try {
    const status = await api.status(session.id, session.token, { recover: false });
    if (state.session !== session || status.meta.state !== 'ended') return;
    reason = status.meta.end_reason ?? reason;
  } catch {
    /* cannot check; trust the event */
  }
  if (state.session !== session) return;
  bootFailed(`Session ended: ${reason ?? 'unknown'}`);
  onEnded(reason);
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

/**
 * The curated side of the event stream, for the "Lab activity" pane.
 *
 * The rest of the stream is operations telemetry — state transitions, check
 * progress, metrics — and is not shown here. This is the part of it that is
 * about the lab itself — pressure events, hints, warnings — as prose.
 * The pane is shown to every learner: it is how a pressure event, an idle
 * warning or a service going down reaches someone who is not reading the
 * Hints panel.
 */
const LEARNER_NOTICES = {
  pressure: (d) => [d.title, d.message],
  hint: (d) => ['Hint', d.text],
  'solution.unlocked': () => ['The solution is now available', 'Compare it with your work from the Solution block.'],
  // The payload is {reason}, not a duration: the time left is what the
  // header's own timer counts down to.
  'session.expiring': () => {
    const minutes = state.expiresAt ? Math.max(1, Math.ceil((state.expiresAt - Date.now()) / 60_000)) : 5;
    return ['Session ending soon', `About ${minutes} minute${minutes === 1 ? '' : 's'} left. End with a snapshot to keep your work.`];
  },
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
  // A pressure event is the lab changing under the learner: the strip opens so it is not missed.
  addNotice(tone, title, detail, { open: type === 'pressure' });
}

function addNotice(tone, title, detail, { open = false } = {}) {
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
  const n = list.children.length;
  $('noticeCount').textContent = `${n} ${n === 1 ? 'notice' : 'notices'}`;
  $('btnActivityToggle').hidden = n < 2;
  if (open && n > 1) setActivityOpen(true);
}

/** The activity strip: its newest line, or all of it. */
function setActivityOpen(open) {
  $('activityPane').dataset.open = String(open);
  const toggle = $('btnActivityToggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.textContent = open ? 'Show less' : 'Show all';
}

// A restart can start a second poll while the first is still sleeping, and
// two loops racing the same session is how a terminal gets attached twice.
let polling = null;
const BOOT_DEADLINE_MS = 120_000;
async function pollUntilRunning() {
  // Keyed by session, so a different session (a resume, a rejoin that
  // landed on another id) starts its own loop while the old one winds down.
  if (polling === state.session) return;
  const session = state.session;
  polling = session;
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
        setBootServices(status.services);
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
    if (polling === session) polling = null;
  }
}

let runningHandled = false;
async function onRunning(status) {
  if (runningHandled) return;
  runningHandled = true;

  bootStep('services', 'Attaching the terminal…');
  if (!state.terminal) {
    state.terminal = attachSessionTerminal();
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
  absorbStatus(status);
  state.expiresAt = meta.expires_at ?? null;
  startExpiryTimer();
  renderServiceTabs();
  renderServiceList(status.services);
  refreshFiles();
  // The guide's Story, Lessons and Questions are extras: if they cannot be built the lab is unchanged.
  // The tabs are final once the brief and the bundle have been read (or failed).
  loadBrief().finally(() =>
    loadLearn()
      .catch((err) => console.error('The guide could not be built', err))
      .finally(() => {
        buildGuide();
        landOnService();
      })
  );
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
  // "Gateway and access · lab 3 of 6 · " before the slug, when the catalogue says where the lab sits.
  const where = locateLab(launcherModel, slug);
  $('sessionWhere').textContent = where ? `${where.module.known ? where.module.title : where.path.title} · lab ${where.position} of ${where.total} · ` : '';
  $('sessionLab').textContent = slug;
  $('sessionTitle').textContent = lab?.title ?? '';
  $('sessionTitle').title = lab?.title ?? '';
}

/**
 * An explore lab is about what its service shows, so it opens on that service's page, once, when it is
 * up and the learner has not already gone somewhere else.
 */
function landOnService() {
  if (state.landed || !state.session) return;
  state.landed = true;
  if (state.lab?.type !== 'explore' || state.view !== 'editor' || state.openFile) return;
  const first = $('serviceTabs').querySelector('.tab');
  if (first) openService(first.dataset.service, first);
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
      launcherModel = buildLauncherModel(labs, pathMeta, { passed: passedSlugs(labs) });
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
  if (type === 'service.health') {
    bootStep('workspace', `Starting ${data?.service ?? 'services'}…`);
    if (data?.service && data?.health) {
      setBootService(data.service, data.health, data.logs_tail);
      if (data.health !== 'healthy') state.bootUnhealthy ??= data.service;
    }
  }
  if (type === 'session.state' && data?.state === 'running') {
    bootStep('workspace');
    bootStep('services', 'Attaching the terminal…');
  }
  if (type === 'alert' && data?.kind?.startsWith?.('start')) bootFailed(data.message ?? data.kind);
}

// ------------------------------------------------------------- boot modal

/**
 * One row per service under the "Services" boot step, so a slow or failing
 * service is named rather than hiding behind a spinner. Kept as a map and
 * rendered in place: events and status polls both feed it, in either
 * order, and rebuilding rows would collapse a log the learner had opened.
 */
const bootServices = new Map();

/** Rows from a status response; logs, which only events carry, are kept. */
function setBootServices(services) {
  for (const [name, runtime] of Object.entries(services ?? {})) {
    setBootService(name, runtime?.health ?? 'unknown');
  }
}

function setBootService(name, health, logsTail) {
  const entry = bootServices.get(name) ?? {};
  entry.health = health;
  if (logsTail && health !== 'healthy') entry.logs = String(logsTail);
  bootServices.set(name, entry);

  const host = $('bootServices');
  let row = [...host.children].find((el) => el.dataset.service === name);
  if (!row) {
    row = document.createElement('div');
    row.className = 'boot-svc';
    row.dataset.service = name;
    row.innerHTML = '<span class="boot-svc-name"></span><span class="boot-svc-health"></span>';
    row.querySelector('.boot-svc-name').textContent = name;
    host.append(row);
  }
  row.dataset.health = health;
  row.querySelector('.boot-svc-health').textContent = health === 'unknown' ? 'starting' : health;

  if (entry.logs && !row.querySelector('pre')) {
    // Collapsed: it is there for the learner who wants to know why, not
    // shoved in front of the one who only wants the lab to start.
    const details = document.createElement('details');
    details.innerHTML = '<summary>Last log lines</summary><pre class="logs-tail"></pre>';
    row.append(details);
  }
  const pre = row.querySelector('pre');
  if (pre) pre.textContent = entry.logs ?? '';
  // A service that recovered no longer needs its log on screen.
  row.querySelector('details')?.toggleAttribute('hidden', health === 'healthy');
}

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
  // Name the service that was already reporting trouble, so the failure
  // reads as "api did not become healthy", not a bare "start failed".
  message = String(message ?? '');
  if (state.bootUnhealthy && !message.includes(state.bootUnhealthy)) {
    message = `${state.bootUnhealthy} did not become healthy. ${message}`;
  }
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
  stopStreamFallback();
  hideIdleBanner();
  hideExpiryBanner();
  $('expiryTimer').textContent = reason ? `ended: ${reason}` : 'ended';
  delete $('expiryTimer').dataset.urgent;
  for (const id of ['btnChecks', 'btnChecksInline', 'btnDockAction', 'btnSnapshot', 'btnEnd']) $(id).disabled = true;
  state.terminal?.dispose();
  state.terminal = null;
  state.events?.close();
  $('btnBackToLabs').hidden = false;
  $('sessionActions').hidden = true;
  // Said where the learner is looking, since the header pill alone is easy
  // to miss and the activity feed is not theirs to read.
  // Idle and expiry are the two a learner did not choose, and the two the
  // API can undo: it snapshots the workspace on the way out.
  const recoverable = reason === 'idle' || reason === 'expired';
  $('endedText').textContent = recoverable
    ? `This session has ended. ${END_REASONS[reason]} Its container is gone, but you can resume from the last snapshot or start the lab again.`
    : `This session has ended. ${END_REASONS[reason] ?? ''} Its container is gone, so the terminal and files ` +
      'are no longer available — go back to the labs to start again.';
  $('btnResume').hidden = !recoverable;
  $('btnRestart').hidden = !recoverable;
  $('endedBanner').hidden = false;
  $('termStatusText').textContent = 'The session has ended, so there is no terminal to reconnect to.';
  $('btnReconnectTerm').hidden = true;
  $('termStatus').hidden = false;
  $('btnSaveFile').disabled = true;
  $('btnNewFile').disabled = true;
  learnSession.form?.disable();
  for (const b of $('serviceList').querySelectorAll('button')) b.disabled = true;
  $('btnServiceRestart').disabled = true;
  renderDock();
}

/**
 * Brings an idle- or expiry-ended session back from its snapshot. The API
 * answers straight away with the session `resuming` and a token covering
 * its new time budget; the console then goes through the same boot as any
 * start, on the same session id.
 */
async function resumeFromSnapshot() {
  const session = state.session;
  if (!session) return;
  const button = $('btnResume');
  button.disabled = true;
  button.textContent = 'Resuming…';
  button.setAttribute('aria-busy', 'true');
  try {
    const resumed = await api.resume(session.id, session.token);
    if (resumed?.token) session.token = resumed.token;
    rememberSession(session);
    enterSession();
  } catch (err) {
    // A 401 here is not the console's sign-in: the session's own token
    // outlives it by minutes, not hours, and cannot be renewed once it is over.
    toast(
      /^401:/.test(err.message)
        ? 'This session can no longer be resumed — its sign-in has expired. Restart the lab instead.'
        : `Could not resume — ${err.message}`,
      'bad'
    );
  } finally {
    button.disabled = false;
    button.textContent = 'Resume from snapshot';
    button.removeAttribute('aria-busy');
  }
}

async function restartLab() {
  const slug = state.lab?.slug ?? state.session?.lab;
  if (!slug) return backToLabs();
  const button = $('btnRestart');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await startSession(slug);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

/** Everything a live session holds open, released. */
function teardownSession() {
  state.terminal?.dispose();
  state.terminal = null;
  state.events?.close();
  stopExpiryTimer();
  stopStreamFallback();
  stopHintTimer();
  hideIdleBanner();
  hideExpiryBanner();
  hideBoot();
  resetLearnSession();
  setServicesOpen(false);
}

/** An ended session leaves a dead workspace on screen; this is the way out. */
function backToLabs() {
  resetSolution();
  forgetSession();
  state.session = null;
  state.dirty = false;
  teardownSession();
  $('resultCard').hidden = true;
  $('btnBackToLabs').hidden = true;
  $('sessionBar').hidden = true;
  $('sessionActions').hidden = true;
  $('workspace').hidden = true;
  $('launcher').hidden = false;
  $('expiryTimer').textContent = '';
  $('btnNewFile').disabled = false;
  syncQuizButtons();
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
  if (state.session) state.terminal = attachSessionTerminal();
}

function attachSessionTerminal() {
  return attachTerminal({
    container: $('term'),
    sessionId: state.session.id,
    token: state.session.token,
    onNotice: (text) => addNotice('warn', 'Terminal', text),
    onStatus: setTerminalStatus,
    // Any keystroke answers the idle warning.
    onInput: hideIdleBanner,
  });
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
      hideExpiryBanner();
      return;
    }
    el.textContent = `${formatClock(left)} left`;
    el.dataset.urgent = left < 60_000 ? '2' : left < 5 * 60_000 ? '1' : '0';
    if (left <= EXPIRY_WARN_MS) showExpiryBanner(left);
    else hideExpiryBanner();
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

function stopExpiryTimer() {
  clearInterval(state.timer);
  state.timer = 0;
}

/** m:ss, floored, so a countdown never claims more time than there is. */
function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------- header stats

const NO_VALUE = '—';

/** "2/4" from a tally of the latest run, or a dash before any run; the Checks tab and the dock follow. */
function setChecksStat(t) {
  $('statChecks').textContent = t ? `${t.passed}/${t.count}` : NO_VALUE;
  guide.checks = t ? { passed: t.passed, count: t.count } : { passed: 0, count: 0 };
  updateBadges();
  renderDock();
}

/** The Hints tab's count and steps, the tab badge and the dock's next hint: hints delivered over the lab's slots. */
function setHintsStat() {
  const h = state.hints;
  const slots = h ? hintSlots(h) : 0;
  $('hintsMeta').textContent = slots ? `${h.delivered.length} of ${slots} shown` : '';
  const steps = [];
  for (let i = 0; i < slots; i++) {
    const step = document.createElement('span');
    const shown = h.delivered.some((d) => d.index === i);
    step.textContent = String(i + 1);
    if (shown) step.className = 'on';
    else step.className = 'locked';
    steps.push(step);
  }
  $('hintSteps').replaceChildren(...steps);
  updateBadges();
  renderDock();
}

/** "≈ $0.03" from `status().cost.usd` or a `metrics` event; a missing number leaves what is shown. */
function setCostStat(usd) {
  if (usd == null || !Number.isFinite(Number(usd))) return;
  const n = Number(usd);
  const text = n > 0 && n < 0.005 ? '< $0.01' : `≈ $${n.toFixed(2)}`;
  $('statCost').textContent = text;
  $('dockCostValue').textContent = text;
  $('statCostWrap').title = `About $${n.toFixed(4)} spent by this session so far`;
  $('dockCost').title = $('statCostWrap').title;
}

function resetBarStats() {
  setChecksStat(null);
  setHintsStat();
  $('statCost').textContent = NO_VALUE;
  $('dockCostValue').textContent = NO_VALUE;
  $('statCostWrap').title = 'Approximate spend by this session so far';
  $('dockCost').title = $('statCostWrap').title;
}

// ------------------------------------------------------- theme and identity

const THEME_KEY = 'opalixTheme';
const THEMES = ['light', 'dark', 'system'];
const THEME_ICON = { light: 'sun', dark: 'moon', system: 'auto' };

function currentTheme() {
  const saved = lsGet(THEME_KEY);
  return THEMES.includes(saved) ? saved : 'system';
}

/**
 * `data-theme` on <html> picks the palette; without it the browser's own
 * preference decides (the stylesheet declares `color-scheme: light dark`).
 * The same rule runs in theme-init.js before first paint, so a saved choice
 * does not flash the other theme.
 */
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  const next = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length];
  const button = $('btnTheme');
  button.setAttribute('aria-label', `Theme: ${mode}. Switch to ${next}.`);
  button.title = `Theme: ${mode} — click for ${next}`;
  $('themeIcon').replaceChildren(uiIcon(THEME_ICON[mode], 20));
}

$('btnTheme').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  lsSet(THEME_KEY, next);
  applyTheme(next);
});
applyTheme(currentTheme());

/** Who the console thinks you are — the cookie's subject, asked of the Worker. */
async function showIdentity() {
  try {
    const { sub } = await api.me();
    if (typeof sub !== 'string' || !sub) return;
    $('identityName').textContent = sub;
    // Two letters in the circle, as the landing page's account chip has.
    $('identityInitials').textContent = sub.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase();
    $('identity').hidden = false;
  } catch {
    /* an older Worker has no /api/me; the header simply omits it */
  }
}

// ---------------------------------------------------------------- banners

/**
 * The two ways a session dies with the tab still open, each said above the
 * tabs where it cannot be scrolled past.
 *
 * Idle: the API warns this long before it ends an idle session
 * (IDLE_WARN_BEFORE_MS in src/session/lifecycle.ts). "I'm here", a
 * keystroke in the terminal or a save in the editor each answer it.
 */
const IDLE_WARN_BEFORE_MS = 2 * 60_000;
/** Mirrors HARD_WARN_BEFORE_MS in lifecycle.ts, the API's own `session.expiring` lead time. */
const EXPIRY_WARN_MS = 5 * 60_000;

function showIdleBanner() {
  if ($('statePill').dataset.state === 'ended') return;
  // A second warning restarts the countdown rather than stacking a timer.
  clearInterval(state.idleTimer);
  state.idleDeadline = Date.now() + IDLE_WARN_BEFORE_MS;
  const tick = () => {
    const left = formatClock(state.idleDeadline - Date.now());
    $('idleCountdown').textContent = left;
    $('idleClock').textContent = `idle ${left}`;
  };
  tick();
  $('idleBanner').hidden = false;
  $('idleClock').hidden = false;
  state.idleTimer = setInterval(tick, 1000);
}

function hideIdleBanner() {
  if ($('idleBanner').hidden && !state.idleTimer) return;
  clearInterval(state.idleTimer);
  state.idleTimer = 0;
  $('idleBanner').hidden = true;
  $('idleClock').hidden = true;
}

/** "I'm here": the API moves the idle clock; the banner goes only once it has. */
async function imHere() {
  const session = state.session;
  if (!session) return;
  const button = $('btnImHere');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await api.touch(session.id, session.token);
    hideIdleBanner();
  } catch (err) {
    toast(`Could not tell the lab you are here — ${err.message}`, 'bad');
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

function showExpiryBanner(left) {
  $('expiryCountdown').textContent = formatClock(left);
  $('expiryBanner').hidden = false;
  if (!endInFlight) $('btnEnd').textContent = 'End & snapshot';
}

function hideExpiryBanner() {
  $('expiryBanner').hidden = true;
  if (!endInFlight) $('btnEnd').textContent = 'End lab';
}

// ---------------------------------------------------------------- checks

async function refreshChecks() {
  // A run the learner started renders its own result when it returns;
  // the per-check events arriving meanwhile would otherwise replace the
  // "running" state with the previous run's results.
  if (state.checksRunning || !state.session) return;
  await refreshStatus({ celebrate: true });
}

/** Reads status() and applies the parts the checks and hints blocks show. */
async function refreshStatus({ celebrate = false } = {}) {
  const session = state.session;
  if (!session) return;
  try {
    const status = await api.status(session.id, session.token);
    if (state.session === session) absorbStatus(status, { celebrate });
  } catch {
    /* the event that triggered this will come again */
  }
}

/**
 * What one status() says about checks, hints and completion. `celebrate`
 * is true only when the learner watched the result arrive (a run they
 * started, or the stream's `check.finished`) — opening a lab that was
 * finished earlier shows the card without the confetti.
 */
function absorbStatus(status, { celebrate = false } = {}) {
  const meta = status?.meta ?? {};
  if (Number.isFinite(status?.server_time)) state.clockSkew = status.server_time - Date.now();
  if (meta.started_at) state.startedAt = meta.started_at;
  if (status?.manifest_summary) state.summary = status.manifest_summary;
  if (Array.isArray(status?.checks_history)) state.history = status.checks_history;
  if (status?.hints) {
    state.hints = status.hints;
    renderHints();
  }
  // An API that predates the solution omits it, which reads as "none".
  renderSolution(status?.solution);
  setCostStat(status?.cost?.usd);
  if (state.checksRunning) return;
  if (status?.checks) renderChecks(status.checks);
  showResultIfComplete(status?.checks, celebrate);
}

/**
 * Checks can take minutes (a Real-mode lab runs its agent once per check),
 * and the only sign one was running used to be a greyed-out button. Say
 * so in the panel where the results will land.
 */
async function runChecks() {
  // The header button, the one in the Checks block and the dock's are the same control.
  const panel = $('checksPanel');
  state.checksRunning = true;
  renderChecksButtons();
  // Where the results will land is where the learner is taken: the Checks tab, or (graded by questions) the Questions tab.
  const home = guide.tabs.includes('checks') ? 'checks' : guide.tabs.includes('questions') ? 'questions' : null;
  if (home) showGuideTab(home);
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
    showResultIfComplete(run, true);
    if (run?.results?.length) announce(`Checks: ${summaryText(tally(run.results))}`);
    // History and hints move on with every run; the run itself is not enough.
    refreshStatus();
    return run;
  } catch (err) {
    state.checksRunning = false;
    panel.innerHTML = `${previous}<p class="notice notice-bad small" role="alert"></p>`;
    panel.querySelector('.notice').textContent = `The checks could not run — ${err.message}`;
    return null;
  } finally {
    state.checksRunning = false;
    renderChecksButtons();
  }
}

/** A check's weight; a run from before weights existed counts every check once. */
function weightOf(result) {
  return Number.isFinite(result?.weight) && result.weight >= 0 ? result.weight : 1;
}

/** Weighted points and plain counts for a list of `{pass, weight}` results. */
function tally(results) {
  let pts = 0;
  let total = 0;
  let passed = 0;
  for (const r of results) {
    const w = weightOf(r);
    total += w;
    if (r.pass) {
      pts += w;
      passed++;
    }
  }
  return { pts, total, passed, count: results.length };
}

function fmtPts(n) {
  return String(Number.isInteger(n) ? n : Math.round(n * 100) / 100);
}

/** "3/4 pts · 2/3 checks": points are weighted, checks are not. */
function summaryText(t) {
  return `${fmtPts(t.pts)}/${fmtPts(t.total)} pts · ${t.passed}/${t.count} checks`;
}

const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });

function renderChecks(run) {
  const panel = $('checksPanel');
  const summary = $('checksSummary');
  if (!run?.results?.length) {
    panel.innerHTML = '<p class="muted small">Not run yet. Run checks to grade your work so far.</p>';
    summary.textContent = '';
    delete summary.dataset.tone;
    state.lastResults = null;
    setChecksStat(null);
    return;
  }
  const t = tally(run.results);
  state.lastResults = run.results;
  setChecksStat(t);
  summary.textContent = summaryText(t);
  summary.dataset.tone = t.passed === t.count ? 'good' : t.passed ? 'warn' : 'bad';

  const historyWasOpen = panel.querySelector('details.check-history')?.open ?? false;
  panel.innerHTML = '';
  for (const r of run.results) {
    const weight = weightOf(r);
    const row = document.createElement('div');
    row.className = `check ${r.pass ? 'check-pass' : 'check-fail'}`;
    row.dataset.weight = String(weight);
    row.innerHTML = `<span class="check-mark" aria-hidden="true"></span><span class="check-msg"><span class="sr-only"></span><strong class="check-name"></strong></span>`;
    // Icon plus text, never colour alone.
    row.querySelector('.check-mark').textContent = r.pass ? '✓' : '✗';
    row.querySelector('.sr-only').textContent = r.pass ? 'Passed: ' : 'Failed: ';
    const msg = row.querySelector('.check-msg');
    row.querySelector('.check-name').textContent = r.name;
    if (weight !== 1) {
      const chip = document.createElement('span');
      chip.className = 'chip chip-weight';
      chip.textContent = `×${fmtPts(weight)}`;
      chip.title = `Counts ×${fmtPts(weight)} towards the points`;
      msg.append(' ', chip);
    }
    if (r.timed_out) {
      const tag = document.createElement('span');
      tag.className = 'chip chip-warn';
      tag.textContent = 'timed out';
      msg.append(' ', tag);
    }
    if (r.message) {
      const detail = document.createElement('pre');
      detail.className = 'check-detail';
      detail.textContent = r.message;
      msg.append(detail);
    }
    panel.append(row);
  }
  if (run.finished_at) {
    const when = document.createElement('p');
    when.className = 'muted small check-when';
    when.textContent = `Last run ${clockTime(run.finished_at)}`;
    panel.append(when);
  }
  // Earlier runs, newest first. The run shown above is already the latest
  // history entry once status() has caught up, so it is left out.
  const earlier = state.history.filter((h) => h.run_id !== run.run_id).reverse();
  if (earlier.length) {
    const details = document.createElement('details');
    details.className = 'check-history';
    details.open = historyWasOpen;
    const head = document.createElement('summary');
    head.textContent = `Previous runs (${earlier.length})`;
    const list = document.createElement('ul');
    for (const h of earlier) {
      const li = document.createElement('li');
      const ht = tally(h.results ?? []);
      li.textContent = `${clockTime(h.finished_at ?? h.started_at)} · ${fmtPts(ht.pts)}/${fmtPts(ht.total)} pts · ${ht.passed}/${ht.count} checks`;
      list.append(li);
    }
    details.append(head, list);
    panel.append(details);
  }
}

// ---------------------------------------------------------------- hints

/** Milliseconds until a hint unlocks, by the server's clock (the learner's may be minutes off). */
function hintRemainingMs(afterMinutes) {
  return state.startedAt + afterMinutes * 60_000 - state.clockSkew - Date.now();
}

/** "Hint 2 · unlocks in 12m". */
function lockedHintLabel(index, afterMinutes) {
  const name = `Hint ${index + 1}`;
  if (!state.startedAt) return `${name} · unlocks in ${afterMinutes}m from the start`;
  const ms = hintRemainingMs(afterMinutes);
  if (ms <= 0) return `${name} · unlocking now`;
  if (ms < 60_000) return `${name} · unlocks in under 1m`;
  const m = Math.ceil(ms / 60_000);
  const h = Math.floor(m / 60);
  return `${name} · unlocks in ${h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`}`;
}

function hintBox(index, text) {
  const box = document.createElement('div');
  box.className = 'hint';
  box.dataset.hint = String(index ?? text);
  const label = document.createElement('div');
  label.className = 'hint-label';
  label.textContent = index != null ? `Hint ${Number(index) + 1}` : 'Hint';
  const body = document.createElement('div');
  body.textContent = text;
  box.append(label, body);
  return box;
}

function lockedHintBox(index, afterMinutes) {
  const box = document.createElement('div');
  box.className = 'hint hint-locked';
  box.dataset.hint = String(index);
  box.dataset.after = String(afterMinutes);
  const label = document.createElement('div');
  label.className = 'hint-label';
  // A countdown that a screen reader read out every minute would be noise.
  label.setAttribute('aria-live', 'off');
  label.textContent = lockedHintLabel(index, afterMinutes);
  box.append(label);
  return box;
}

/** How many hint slots a lab has: whatever is larger of the total, the schedule and what has been delivered. */
const hintSlots = (h) => Math.max(h.total, h.schedule.length, ...h.delivered.map((d) => d.index + 1));

const hintSignature = (h) => JSON.stringify([h.total, h.schedule, h.delivered.map((d) => d.index)]);

/** Every hint slot from status(): delivered ones open, the rest locked with a countdown. */
function renderHints() {
  const hints = state.hints;
  if (!hints) return;
  setHintsStat();
  const sig = hintSignature(hints);
  if (sig === state.hintSig && $('hintsPanel').querySelector('[data-hint]')) return;
  state.hintSig = sig;
  const panel = $('hintsPanel');
  panel.innerHTML = '';
  const slots = hintSlots(hints);
  if (!slots) {
    panel.innerHTML = '<p class="muted small">This lab has no hints.</p>';
  }
  for (let i = 0; i < slots; i++) {
    const delivered = hints.delivered.find((d) => d.index === i);
    panel.append(delivered ? hintBox(i, delivered.text) : lockedHintBox(i, hints.schedule[i] ?? 0));
  }
  updateResultHints();
  startHintTimer();
}

function stopHintTimer() {
  clearInterval(state.hintTimer);
  state.hintTimer = 0;
}

/** Counts the locked labels down once a minute, and asks status() if one is overdue and no event came. */
function startHintTimer() {
  stopHintTimer();
  if (!$('hintsPanel').querySelector('.hint-locked')) return;
  state.hintTimer = setInterval(() => {
    const locked = [...$('hintsPanel').querySelectorAll('.hint-locked')];
    if (!locked.length || !state.session) return stopHintTimer();
    let overdue = false;
    for (const box of locked) {
      const after = Number(box.dataset.after);
      box.querySelector('.hint-label').textContent = lockedHintLabel(Number(box.dataset.hint), after);
      if (state.startedAt && hintRemainingMs(after) <= 0) overdue = true;
    }
    renderDock();
    if (overdue) refreshStatus();
  }, 60_000);
}

/** A `hint` event: the locked slot turns into the hint, in place. */
function renderHint(data) {
  const index = Number.isInteger(Number(data.index)) && data.index != null ? Number(data.index) : null;
  const panel = $('hintsPanel');
  if (state.hints && index != null && !state.hints.delivered.some((d) => d.index === index)) {
    state.hints.delivered.push({ index, after_minutes: data.after_minutes ?? state.hints.schedule[index] ?? 0, text: data.text });
    state.hints.delivered.sort((a, b) => a.index - b.index);
    state.hints.total = Math.max(state.hints.total, index + 1);
    state.hintSig = hintSignature(state.hints);
    setHintsStat();
  }
  // A replayed stream sends the same hint again; show each one once.
  const key = String(index ?? data.text);
  const existing = panel.querySelector(`[data-hint="${CSS.escape(key)}"]`);
  if (existing && !existing.classList.contains('hint-locked')) return;
  const box = hintBox(index, data.text);
  if (existing) {
    existing.replaceWith(box);
  } else {
    if (panel.querySelector('.muted')) panel.innerHTML = '';
    panel.append(box);
  }
  updateResultHints();
  startHintTimer();
}

// -------------------------------------------------------------- solution

/** Unlocked once the API says so, or once the learner has finished the lab. */
const solutionUnlocked = (solution) => solution.unlocked === true || solution.progress?.completed === true;

/** "Checks run 1 · Hints used 2 of 3", from whichever numbers the API sent. */
function solutionProgressText(progress) {
  const parts = [];
  if (Number.isFinite(progress?.check_runs)) parts.push(`Checks run ${progress.check_runs}`);
  if (Number.isFinite(progress?.hints_total) && progress.hints_total > 0 && Number.isFinite(progress?.hints_delivered)) {
    parts.push(`Hints used ${progress.hints_delivered} of ${progress.hints_total}`);
  }
  return parts.join(' · ');
}

/**
 * The Solution block, from `status().solution`. Not there (an older API, a
 * lab with no solution) means nothing is shown at all. The button and the
 * paragraphs are static elements that are only shown or hidden, so a status
 * refresh never replaces the button the dialog returns focus to.
 */
function renderSolution(solution) {
  const block = $('solutionBlock');
  const had = Boolean(state.solution);
  if (!solution || solution.available !== true) {
    state.solution = null;
    block.hidden = true;
    if (had) syncGuideTabs();
    updateBadges();
    return;
  }
  state.solution = solution;
  if (!had) syncGuideTabs();
  const unlocked = solutionUnlocked(solution);
  block.hidden = false;
  block.dataset.state = unlocked ? 'unlocked' : 'locked';
  $('solutionMeta').textContent = unlocked ? 'Available' : 'Locked';
  $('solutionMeta').dataset.tone = unlocked ? 'good' : 'warn';
  $('solutionLocked').hidden = unlocked;
  $('solutionReady').hidden = !unlocked;
  $('solutionRule').textContent = solution.rule || 'The solution unlocks as you work through the lab.';
  $('solutionProgress').textContent = solutionProgressText(solution.progress);
  updateBadges();
}

/** The stream said it unlocked; show that now and let status() confirm it. */
function onSolutionUnlocked() {
  if (state.solution) renderSolution({ ...state.solution, unlocked: true });
  refreshStatus();
}

/** A new session, or leaving one: nothing of the last lab's solution stays on screen. */
function resetSolution() {
  state.solution = null;
  solutionLoad++;
  $('solutionBlock').hidden = true;
  const dialog = $('solutionDialog');
  if (dialog.open) dialog.close();
  syncGuideTabs();
}

/** Bumped by every load and by closing, so an answer that arrives late is dropped. */
let solutionLoad = 0;
/** What the open dialog is showing: `files` are `{path, content, mine, missing, unreadable, ops, changed}`. */
const solutionView = { files: [], selected: 0 };

const CONTEXT_LINES = 3;
const READ_CONCURRENCY = 4;

function openSolutionDialog() {
  const dialog = $('solutionDialog');
  if (!dialog.open) dialog.showModal();
  loadSolution();
}

/** One line under the dialog's heading in place of the diff: loading, an error (with Retry) or the lock. */
function setSolutionStatus(kind, text = '') {
  const box = $('solutionStatus');
  box.hidden = !kind;
  box.dataset.kind = kind || '';
  $('solutionSpinner').hidden = kind !== 'loading';
  $('solutionStatusText').textContent = text;
  $('solutionStatusText').classList.toggle('error', kind === 'error');
  $('btnSolutionRetry').hidden = kind !== 'error';
  $('solutionBody').hidden = true;
  $('solutionTruncated').hidden = true;
  $('solutionDirty').hidden = true;
  $('btnSolutionCopy').disabled = true;
  $('solutionCopyNote').textContent = '';
}

/** The API's `solution_locked` 403, shown in the dialog and mirrored into the block. */
function showSolutionLocked(details) {
  const previous = state.solution ?? {};
  renderSolution({
    ...previous,
    available: true,
    unlocked: false,
    rule: details?.rule ?? previous.rule,
    progress: details?.progress ?? previous.progress,
  });
  const progress = solutionProgressText(state.solution.progress);
  setSolutionStatus('locked', `The solution is still locked. ${$('solutionRule').textContent}${progress ? ` (${progress})` : ''}`);
  refreshStatus();
}

/** A file path from the API, as the files route wants it: relative, each segment encoded. */
const filesRoutePath = (path) =>
  path
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');

/** The learner's saved copy of a file. Missing counts as empty; another failure is reported per file. */
async function readMine(session, path) {
  try {
    const result = await api.readFile(session.id, session.token, filesRoutePath(path));
    return { text: typeof result?.content === 'string' ? result.content : '', missing: false };
  } catch (err) {
    if (err.status === 404) return { text: '', missing: true };
    return { text: '', missing: false, unreadable: err.message };
  }
}

async function loadSolution() {
  const session = state.session;
  if (!session) return;
  const seq = ++solutionLoad;
  const current = () => seq === solutionLoad && state.session === session;
  setSolutionStatus('loading', 'Loading the solution…');
  try {
    const result = await api.solution(session.id, session.token);
    if (!current()) return;
    const files = (Array.isArray(result?.files) ? result.files : [])
      .filter((f) => f && typeof f.path === 'string' && f.path)
      .map((f) => ({ path: f.path, content: typeof f.content === 'string' ? f.content : '' }));
    if (!files.length) {
      setSolutionStatus('empty', 'The solution has no files to show.');
      return;
    }
    // A few reads at a time: a solution can be many files, and the learner's
    // container answers each one in turn.
    const mine = new Array(files.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, async () => {
        while (next < files.length && current()) {
          const i = next++;
          mine[i] = await readMine(session, files[i].path);
        }
      })
    );
    if (!current()) return;
    solutionView.files = files.map((file, i) => {
      const own = mine[i];
      const ops = own.unreadable ? null : diffLines(own.text, file.content);
      return {
        ...file,
        missing: own.missing,
        unreadable: own.unreadable ?? null,
        ops,
        changed: ops ? ops.some((op) => op.type !== 'same') : true,
      };
    });
    solutionView.selected = Math.max(0, solutionView.files.findIndex((f) => f.changed));
    showSolutionDiff(result.truncated === true);
  } catch (err) {
    if (!current()) return;
    if (err.status === 403 && err.code === 'solution_locked') return showSolutionLocked(err.details);
    if (err.status === 404) {
      renderSolution(null);
      return setSolutionStatus('empty', 'This lab has no solution to show.');
    }
    setSolutionStatus('error', `Could not load the solution — ${err.message}`);
  }
}

function showSolutionDiff(truncated) {
  setSolutionStatus(null);
  $('solutionBody').hidden = false;
  $('solutionTruncated').hidden = !truncated;
  // The comparison reads what is saved in the container; an open file with
  // edits that were never saved is not in it.
  const dirty = state.dirty && state.openFile && solutionView.files.some((f) => f.path === state.openFile);
  $('solutionDirty').hidden = !dirty;
  if (dirty) $('solutionDirty').textContent = `You have unsaved changes to ${state.openFile}. This comparison uses the saved version.`;

  const list = $('solutionFiles');
  list.innerHTML = '';
  solutionView.files.forEach((file, i) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sol-file';
    button.dataset.index = String(i);
    button.dataset.path = file.path;
    button.title = `/workspace/${file.path}`;
    const name = document.createElement('span');
    name.className = 'sol-file-name mono';
    name.textContent = file.path;
    button.append(name);
    const tag = file.unreadable ? 'unreadable' : file.missing ? 'not in your work' : file.changed ? '' : 'matches';
    if (tag) {
      const chip = document.createElement('span');
      chip.className = `sol-file-tag${file.changed ? ' sol-file-tag-warn' : ''}`;
      chip.textContent = tag;
      button.append(chip);
    }
    button.addEventListener('click', () => selectSolutionFile(i));
    li.append(button);
    list.append(li);
  });
  selectSolutionFile(solutionView.selected);
}

function selectSolutionFile(index) {
  const file = solutionView.files[index];
  if (!file) return;
  solutionView.selected = index;
  for (const button of $('solutionFiles').querySelectorAll('.sol-file')) {
    const on = Number(button.dataset.index) === index;
    if (on) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  $('solutionPath').textContent = file.path;
  $('btnSolutionCopy').disabled = false;
  $('solutionCopyNote').textContent = '';
  const diff = $('solutionDiff');
  diff.setAttribute('aria-label', `Differences in ${file.path}`);
  diff.scrollTop = 0;
  diff.scrollLeft = 0;

  const note = $('solutionFileNote');
  const counts = $('solutionCounts');
  counts.textContent = '';
  note.hidden = true;

  if (file.unreadable) {
    note.hidden = false;
    note.textContent = `Could not read your copy of this file (${file.unreadable}), so the solution is shown without a comparison.`;
    diff.replaceChildren(
      ...file.content.split('\n').map((text, i) => diffRow({ type: 'same', text, aLine: undefined, bLine: i + 1 }))
    );
    return;
  }
  const added = file.ops.filter((op) => op.type === 'add').length;
  const removed = file.ops.filter((op) => op.type === 'del').length;
  counts.textContent = file.changed ? `+${added} -${removed}` : '';
  if (file.missing) {
    note.hidden = false;
    note.textContent = 'This file is not in your workspace yet.';
  } else if (!file.changed) {
    note.hidden = false;
    note.textContent = 'Your file matches the solution.';
  }
  const rows = file.changed ? collapseContext(file.ops, CONTEXT_LINES) : file.ops;
  const frag = document.createDocumentFragment();
  for (const op of rows) frag.append(op.type === 'gap' ? gapRow(op.count) : diffRow(op));
  diff.replaceChildren(frag);
}

const SIGNS = { add: '+', del: '-', same: '' };
const SIGN_TITLES = { add: 'In the solution, missing from yours', del: 'In yours, not in the solution', same: '' };

function diffRow(op) {
  const row = document.createElement('div');
  row.className = `dl dl-${op.type}`;
  const cells = [
    ['dl-n', op.aLine],
    ['dl-n', op.bLine],
  ].map(([cls, n]) => {
    const cell = document.createElement('span');
    cell.className = cls;
    cell.textContent = n ?? '';
    return cell;
  });
  const sign = document.createElement('span');
  sign.className = 'dl-sign';
  sign.textContent = SIGNS[op.type];
  if (SIGN_TITLES[op.type]) sign.title = SIGN_TITLES[op.type];
  const text = document.createElement('span');
  text.className = 'dl-text';
  text.textContent = op.text;
  row.append(...cells, sign, text);
  return row;
}

function gapRow(count) {
  const row = document.createElement('div');
  row.className = 'dl dl-gap';
  row.setAttribute('role', 'separator');
  row.textContent = `… ${count} unchanged line${count === 1 ? '' : 's'} …`;
  return row;
}

let copyNoteTimer = 0;
async function copySolutionFile() {
  const file = solutionView.files[solutionView.selected];
  if (!file) return;
  const note = $('solutionCopyNote');
  clearTimeout(copyNoteTimer);
  try {
    await navigator.clipboard.writeText(file.content);
    note.textContent = `Copied ${file.path}`;
  } catch {
    note.textContent = 'Could not copy. Select the text in the diff and copy it instead.';
  }
  copyNoteTimer = setTimeout(() => (note.textContent = ''), 4000);
}

$('btnSolutionOpen').addEventListener('click', openSolutionDialog);
$('btnSolutionRetry').addEventListener('click', loadSolution);
$('btnSolutionCopy').addEventListener('click', copySolutionFile);
$('btnSolutionClose').addEventListener('click', () => $('solutionDialog').close());
$('solutionDialog').addEventListener('close', () => {
  // Drops a load still in flight, and hands focus back to where it came from
  // (the browser does this too, but not if the block was redrawn meanwhile).
  solutionLoad++;
  const opener = $('btnSolutionOpen');
  if (!opener.closest('[hidden]')) opener.focus();
});

// ---------------------------------------------------------------- result

/**
 * A run finished the lab when every check the manifest lists passed in it.
 * A run of a subset (`only`) or one still in progress has all-passing
 * results too, so the names are compared, and `finished_at` is required.
 * Without a manifest_summary (its manifest purged) every result passing is
 * all there is to go on.
 */
function runCompletesLab(run) {
  const results = run?.results;
  if (!results?.length || !run.finished_at || !results.every((r) => r.pass)) return false;
  const required = state.summary?.checks?.map((c) => c.name) ?? [];
  const seen = new Set(results.map((r) => r.name));
  return required.every((name) => seen.has(name));
}

/**
 * `status()` has no completed_at, so completion is read off the runs: the
 * latest one, else the newest all-pass entry in `checks_history` (a console
 * opened after the learner had finished, and then failed a re-run).
 */
function showResultIfComplete(latest, celebrate) {
  if (state.resultShown || !state.session) return;
  const winner = [latest, ...[...state.history].reverse()].find(runCompletesLab);
  if (winner) showResultCard(winner, celebrate);
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function showResultCard(run, celebrate) {
  state.resultShown = true;
  const t = tally(run.results);
  const finished = run.finished_at ?? Date.now() + state.clockSkew;
  const title = state.summary?.title ?? state.lab?.title ?? state.session.lab;
  state.result = {
    title,
    slug: state.session.lab,
    checks: `${t.passed}/${t.count} checks`,
    pts: `${fmtPts(t.pts)} pts`,
    time: state.startedAt ? fmtElapsed(finished - state.startedAt) : '–',
  };
  $('resultLab').textContent = title;
  $('resultChecks').textContent = `${state.result.checks} · ${state.result.pts}`;
  $('resultTime').textContent = state.result.time;
  updateResultHints();
  $('resultCard').hidden = false;
  if (celebrate) {
    announce('Lab complete. Every check passed.');
    // The result card is in the guide: if the guide is hidden, say where it is.
    if (!guide.open) toast('Lab complete. Every check passed. Open the guide to see your result.', 'good');
  }
  if (celebrate && !matchMedia('(prefers-reduced-motion: reduce)').matches) confettiBurst();
}

function hintsUsedText() {
  const h = state.hints;
  return h ? `${h.delivered.length} of ${h.total}` : '–';
}

function updateResultHints() {
  if (state.result) $('resultHints').textContent = hintsUsedText();
}

const CONFETTI_COLORS = ['--good', '--accent', '--warn', '--bad'];

/** About twenty CSS-animated pieces, gone after 1.2s. The caller has already checked reduced motion. */
function confettiBurst() {
  const box = $('confetti');
  box.innerHTML = '';
  for (let i = 0; i < 20; i++) {
    const piece = document.createElement('i');
    piece.style.setProperty('--x', `${5 + Math.random() * 90}%`);
    piece.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 80)}px`);
    piece.style.setProperty('--r', `${Math.round(Math.random() * 720 - 360)}deg`);
    piece.style.setProperty('--d', `${Math.round(Math.random() * 200)}ms`);
    piece.style.setProperty('--c', `var(${CONFETTI_COLORS[i % CONFETTI_COLORS.length]})`);
    box.append(piece);
  }
  setTimeout(() => (box.innerHTML = ''), 1500);
}

/** A new session starts with nothing judged, no result and no clock. */
function resetSessionFeedback() {
  stopHintTimer();
  state.summary = null;
  state.history = [];
  state.hints = null;
  state.hintSig = '';
  resetSolution();
  resetBarStats();
  state.startedAt = null;
  state.clockSkew = 0;
  state.resultShown = false;
  state.result = null;
  $('resultCard').hidden = true;
  $('confetti').innerHTML = '';
  $('feedbackForm').reset();
  $('feedbackForm').hidden = false;
  $('btnFeedback').disabled = true;
  $('feedbackError').hidden = true;
  $('feedbackThanks').hidden = true;
}

function summaryPlainText() {
  const r = state.result;
  return [
    `Opalix lab complete: ${r.title} (${r.slug})`,
    `Checks: ${r.checks} · ${r.pts}`,
    `Time: ${r.time}`,
    `Hints used: ${hintsUsedText()}`,
  ].join('\n');
}

async function copySummary() {
  if (!state.result) return;
  try {
    await navigator.clipboard.writeText(summaryPlainText());
    toast('Summary copied.', 'good');
  } catch {
    toast('Could not copy — your browser blocked clipboard access.', 'bad');
  }
}

async function sendFeedback(event) {
  event.preventDefault();
  const session = state.session;
  const rating = Number($('feedbackForm').querySelector('input[name="rating"]:checked')?.value);
  if (!session || !rating) return;
  const button = $('btnFeedback');
  const error = $('feedbackError');
  error.hidden = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await api.feedback(session.id, session.token, { rating, text: $('feedbackText').value.trim().slice(0, 2000) });
    if (state.session !== session) return;
    $('feedbackForm').hidden = true;
    const thanks = $('feedbackThanks');
    thanks.hidden = false;
    thanks.tabIndex = -1;
    thanks.focus();
  } catch (err) {
    error.textContent = `Could not send your feedback — ${err.message}`;
    error.hidden = false;
    button.disabled = false;
  } finally {
    button.removeAttribute('aria-busy');
  }
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
    updateWindowTitle();
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
    // A write is activity, as far as the API's idle clock is concerned.
    hideIdleBanner();
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
  for (const name of names) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab wtab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('aria-controls', 'viewService');
    tab.tabIndex = -1;
    tab.title = `Open the ${name} service`;
    tab.dataset.service = name;
    tab.dataset.health = 'unknown';
    const dot = document.createElement('span');
    dot.className = 'svc-dot';
    dot.dataset.health = 'unknown';
    dot.setAttribute('aria-hidden', 'true');
    tab.append(dot, name);
    tab.addEventListener('click', () => openService(name, tab));
    host.append(tab);
    // The dot is the tab's own mark of health; "Open the echo service (healthy)" is what the tooltip says.
  }
}

/**
 * Every service the lab runs, each with a Restart button. The tabs cover
 * only `ui: true` services, but a learner who edits a service's config has
 * to restart it for the change to apply, and the terminal runs
 * unprivileged, so it can't. The API restarts the service from its manifest
 * spec and answers once it is healthy again (or has given up).
 */
function renderServiceList(services) {
  const names = Object.keys(services ?? {});
  $('servicesBlock').hidden = !names.length;
  if (!names.length) setServicesOpen(false);
  const host = $('serviceList');
  host.innerHTML = '';
  for (const name of names) {
    const li = document.createElement('li');
    li.dataset.service = name;
    const label = document.createElement('span');
    label.className = 'svc-name';
    label.textContent = name;
    const health = document.createElement('span');
    health.className = 'svc-health';
    const button = document.createElement('button');
    button.className = 'btn btn-tiny';
    button.textContent = 'Restart';
    button.title = `Stop ${name} and start it again, so it picks up changed files`;
    button.addEventListener('click', () => restartService(name, button));
    li.append(label, health, button);
    host.append(li);
    setServiceHealth(name, services[name]?.health ?? 'unknown');
  }
  updateServicesSummary();
}

/** The Services button: how many are healthy, and one dot for the worst of them. */
function updateServicesSummary() {
  const rows = [...$('serviceList').children].map((li) => li.querySelector('.svc-health')?.dataset.health ?? 'unknown');
  const healthy = rows.filter((h) => h === 'healthy').length;
  $('servicesCount').textContent = rows.length ? `${healthy}/${rows.length}` : '';
  const worst = rows.includes('unhealthy') ? 'unhealthy' : rows.includes('restarting') ? 'restarting' : rows.length && healthy === rows.length ? 'healthy' : 'unknown';
  $('servicesDot').dataset.health = worst;
  $('btnServices').title = rows.length ? `${healthy} of ${rows.length} services healthy` : '';
}

/** The Services popover: every service the lab runs, with its health and a Restart. */
function setServicesOpen(open) {
  $('servicesPop').hidden = !open;
  $('btnServices').setAttribute('aria-expanded', String(open));
}

function setServiceHealth(name, health) {
  const tab = [...$('serviceTabs').children].find((el) => el.dataset.service === name);
  if (tab) {
    tab.dataset.health = health;
    tab.title = `Open the ${name} service (${health})`;
    const dot = tab.querySelector('.svc-dot');
    if (dot) dot.dataset.health = health;
  }
  const li = [...$('serviceList').children].find((el) => el.dataset.service === name);
  const el = li?.querySelector('.svc-health');
  if (!el) return;
  el.dataset.health = health;
  el.textContent = health;
  updateServicesSummary();
}

async function restartService(name, button) {
  if (!state.session) return;
  button.disabled = true;
  button.textContent = 'Restarting…';
  button.setAttribute('aria-busy', 'true');
  setServiceHealth(name, 'restarting');
  try {
    const runtime = await api.restartService(state.session.id, state.session.token, name);
    const health = runtime?.health ?? 'unknown';
    setServiceHealth(name, health);
    if (health === 'healthy') toast(`${name} restarted.`, 'good');
    else toast(`${name} restarted but is ${health}. If you changed its files, check them and restart it again.`, 'bad');
    // A tab already showing this service is showing the old process's page.
    if (state.service === name && $('viewService').classList.contains('view-active')) {
      openService(name, activeServiceTab(), { reload: true });
    }
  } catch (err) {
    setServiceHealth(name, 'unknown');
    toast(`Could not restart ${name} — ${err.message}`, 'bad');
  } finally {
    button.disabled = false;
    button.textContent = 'Restart';
    button.removeAttribute('aria-busy');
  }
}

/**
 * Points the iframe at a service — only when it is not already showing
 * that one. Re-pointing it on every tab click reloaded the service's UI
 * each time the learner came back from the terminal, and threw away
 * wherever they had navigated to inside it.
 *
 * The iframe and the "open in new tab" link carry no token: the API is
 * asked to set the session cookie first (a credentialed fetch), then the
 * service URL is probed once. A 502 there shows the "not answering" card
 * instead of a broken frame. If the browser will not keep the cookie, or
 * the API has no such route, the iframe alone falls back to `?token=`.
 */
async function openService(name, tab, { reload = false } = {}) {
  const frame = $('serviceFrame');
  const { id, token } = state.session;
  const base = serviceBaseUrl(id, name);
  $('serviceName').textContent = name;
  $('serviceOpen').href = base;
  state.service = name;

  const loaded = frame.getAttribute('src') && state.loadedService === name && state.serviceDown !== name;
  if (!reload && loaded) {
    showView('service', tab);
    return;
  }

  const seq = ++state.serviceOpenSeq;
  state.loadedService = name;
  state.serviceDown = null;
  $('serviceDown').hidden = true;
  frame.hidden = false;
  $('serviceLoadingText').textContent = `Loading ${name}…`;
  $('serviceLoading').hidden = false;
  $('serviceStatus').textContent = '';
  showView('service', tab);

  let useToken = false;
  let status = 0;
  try {
    status = await api.serviceSession(id, token, name);
  } catch {
    /* an API without the route fails the credentialed CORS check */
  }
  if (seq !== state.serviceOpenSeq) return;
  if (status === 204) {
    status = await probeService(base);
    if (seq !== state.serviceOpenSeq) return;
    // The cookie was set but not sent back: third-party cookies are blocked.
    if (status === 401 || status === 403) useToken = true;
  } else {
    useToken = true;
  }

  if (useToken) {
    if (!state.serviceCookieFallback) {
      state.serviceCookieFallback = true;
      $('servicePanel').dataset.cookieFallback = '1';
    }
    status = await probeService(serviceUrl(id, token, name));
    if (seq !== state.serviceOpenSeq) return;
  }

  if (status === 502) {
    showServiceDown(name);
    return;
  }
  frame.src = useToken ? serviceUrl(id, token, name) : base;
}

/**
 * One credentialed GET of the service URL, for its status alone. Resolves 0
 * when the answer cannot be read (network error, or an opaque redirect from
 * a service that redirects itself), which is treated as "go ahead and load".
 */
async function probeService(url) {
  try {
    const res = await fetch(url, { credentials: 'include', redirect: 'manual' });
    return res.status;
  } catch {
    return 0;
  }
}

/** The card that replaces the iframe when a service is not answering. */
function showServiceDown(name) {
  state.serviceDown = name;
  $('serviceLoading').hidden = true;
  $('serviceFrame').hidden = true;
  $('serviceDownName').textContent = name;
  // Logs only come with a `service.health` event, and only from a failed start.
  const logs = bootServices.get(name)?.logs;
  $('serviceDownLogs').textContent = logs ?? '';
  $('serviceDownLogsBox').hidden = !logs;
  $('serviceDown').hidden = false;
}

/** The service tab that is showing, if a service is. */
const activeServiceTab = () => $('serviceTabs').querySelector('.tab[aria-selected="true"]') ?? undefined;

/**
 * Shows one of the workspace window's views (the guide's tabs are showGuideTab's). `focus` is false
 * for a tab reached with the arrow keys, so the keyboard stays on the tablist.
 */
function showView(view, tabEl, { focus = true } = {}) {
  // Every tab's `data-view` must have an entry here. Adding a tab without one
  // made `$(undefined)` null and threw on `.classList`, which enterSession
  // swallowed into the launcher's error line — so no lab could be started at
  // all. Fail loudly instead of dereferencing null.
  const map = { terminal: 'viewTerminal', editor: 'viewEditor', service: 'viewService' };
  const target = map[view] && $(map[view]);
  if (!target) throw new Error(`showView: no view registered for "${view}"`);
  for (const el of document.querySelectorAll('#window .view')) el.classList.remove('view-active');
  for (const el of document.querySelectorAll('#workspaceTabs .tab')) {
    el.setAttribute('aria-selected', 'false');
    el.tabIndex = -1;
  }
  target.classList.add('view-active');
  const tab = tabEl ?? document.querySelector(`#workspaceTabs .tab[data-view="${view}"]`);
  tab?.setAttribute('aria-selected', 'true');
  if (tab) tab.tabIndex = 0;
  state.view = view;
  updateWindowTitle();
  if (view === 'terminal') {
    state.terminal?.refit();
    // Switching to the terminal is switching to typing in it.
    if (focus) state.terminal?.focus();
  }
}

/** The window's title: the open file in the editor, else the view's name. */
function updateWindowTitle() {
  $('windowTitle').textContent = windowTitle({ view: state.view, file: state.openFile, service: state.service });
}

/** A workspace tab pressed (focus: true) or reached with the arrow keys (focus: false). */
function activateWorkspaceTab(tab, { focus }) {
  if (tab.dataset.service) return openService(tab.dataset.service, tab);
  showView(tab.dataset.view, tab, { focus });
  if (focus && tab.dataset.view === 'editor' && state.openFile) state.editor?.focus();
}

/**
 * Arrow keys walk a tablist (Left/Right, Home, End), and the tab under the keyboard is the one
 * shown. `tabs()` are the tabs in order; a tab reached this way keeps the focus.
 */
function wireTablist(list, tabs, activate) {
  list.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const all = tabs();
    const at = all.indexOf(document.activeElement);
    if (at < 0) return;
    const next = roveIndex(event.key, at, all.length);
    if (next === null) return;
    event.preventDefault();
    all[next].focus();
    activate(all[next]);
  });
}

// ---------------------------------------------------------------- wiring

// The header's own links. Labs (and the brand) go home: the launcher from a learning or
// notice screen, the top of it from the launcher. Paths goes to the path navigator.
function goHome(event) {
  event.preventDefault();
  setMenu(false);
  if (state.session) return;
  if (!$('desktopNotice').hidden) hideDesktopNotice();
  else if (!$('learnScreen').hidden) leaveLearnScreen();
  else {
    $('launcher').scrollTo({ top: 0, behavior: 'auto' });
    window.scrollTo(0, 0);
  }
}
$('brandLink').addEventListener('click', goHome);
$('navLabs').addEventListener('click', goHome);
$('navPaths').addEventListener('click', (event) => {
  event.preventDefault();
  setMenu(false);
  if (state.session || $('launcher').hidden) return;
  const nav = $('pathNav');
  const first = nav.hidden ? null : nav.querySelector('.path-pill');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  (first ?? $('labList')).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  first?.focus({ preventScroll: true });
});

// On a phone the links and account controls live behind a menu button inside the pill.
function setMenu(open) {
  $('nav').classList.toggle('menu-open', open);
  const button = $('btnMenu');
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
$('btnMenu').addEventListener('click', () => setMenu($('btnMenu').getAttribute('aria-expanded') !== 'true'));
$('nav').addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('btnMenu').getAttribute('aria-expanded') === 'true') {
    setMenu(false);
    $('btnMenu').focus();
  }
});
$('btnHelp').addEventListener('click', () => setMenu(false));
$('btnRetakeQuiz').addEventListener('click', () => setMenu(false));

$('btnHelp').addEventListener('click', showOnboarding);
$('btnRetakeQuiz').addEventListener('click', showQuiz);
$('btnOnboardingRetake').addEventListener('click', showQuiz);
// Escape and the button both count as having read it.
$('onboarding').addEventListener('close', () => lsSet(ONBOARDED_KEY, '1'));
$('btnOnboardingDone').addEventListener('click', () => {
  // Set now, not only on the dialog's async `close` event.
  lsSet(ONBOARDED_KEY, '1');
  $('onboarding').close();
});
$('labSearch').addEventListener('input', () => {
  filters.q = $('labSearch').value;
  saveFilters();
  applyFilters();
});
$('btnClearFilters').addEventListener('click', clearFilters);
$('btnChecks').addEventListener('click', runChecks);
$('btnChecksInline').addEventListener('click', runChecks);

$('btnCopySummary').addEventListener('click', copySummary);
// The lab is done, but its container is still up (and a learner may have one
// live session), so "back to labs" goes through the end dialog rather than
// abandoning it.
$('btnResultBack').addEventListener('click', () => {
  if ($('statePill').dataset.state === 'ended') backToLabs();
  else $('btnEnd').click();
});
$('feedbackForm').addEventListener('change', () => {
  $('btnFeedback').disabled = !$('feedbackForm').querySelector('input[name="rating"]:checked');
});
$('feedbackForm').addEventListener('submit', sendFeedback);

// A snapshot used to report nothing to the learner either way: success was
// silent and failure went nowhere the learner would look.
$('btnSnapshot').addEventListener('click', async () => {
  const button = $('btnSnapshot');
  button.disabled = true;
  button.textContent = 'Saving…';
  button.setAttribute('aria-busy', 'true');
  try {
    await api.snapshot(state.session.id, state.session.token);
    toast(`Snapshot saved at ${new Date().toLocaleTimeString([], { hour12: false })}.`, 'good');
  } catch (err) {
    toast(`Snapshot failed — ${err.message}`, 'bad');
  } finally {
    button.textContent = 'Snapshot';
    button.removeAttribute('aria-busy');
    button.disabled = !state.session || $('statePill').dataset.state === 'ended';
  }
});

/**
 * Ending used to be a confirm() that always threw the work away. It is now
 * the learner's choice: keep it (a snapshot, so the lab can be resumed) or
 * discard it. Neither is the default action of Escape — that only cancels.
 */
let endInFlight = false;
$('btnEnd').addEventListener('click', () => {
  const dirty = $('endDialogDirty');
  dirty.hidden = !(state.dirty && state.openFile);
  dirty.textContent = `Your unsaved changes to ${state.openFile} live only in this tab and will be lost. Save the file first to keep them.`;
  $('endDialog').showModal();
});
$('btnEndCancel').addEventListener('click', () => $('endDialog').close());
$('btnEndKeep').addEventListener('click', () => endSession(true));
$('btnEndDiscard').addEventListener('click', () => endSession(false));

async function endSession(snapshot) {
  $('endDialog').close();
  const session = state.session;
  if (!session) return;
  const btn = $('btnEnd');
  endInFlight = true;
  btn.disabled = true;
  btn.textContent = 'Ending…';
  try {
    await api.end(session.id, session.token, snapshot);
  } catch (err) {
    // Say so, but still go home: the container is gone or was never there,
    // and leaving a dead workspace on screen helps nobody.
    addNotice('bad', 'Could not end cleanly', err.message);
    toast(`The session may not have ended cleanly — ${err.message}`, 'bad');
  } finally {
    endInFlight = false;
    btn.textContent = 'End lab';
  }
  // Ending is a deliberate act with an obvious next step, so take it —
  // rather than parking the learner in a dead workspace behind one more
  // button. A session that ends *on its own* (idle, expiry, error) still
  // stops here and explains itself, because being teleported away from
  // your work without being told why is worse than an extra click.
  onEnded('user');
  backToLabs();
}

$('btnResume').addEventListener('click', resumeFromSnapshot);
$('btnRestart').addEventListener('click', restartLab);
$('btnEndedBack').addEventListener('click', backToLabs);
$('btnImHere').addEventListener('click', imHere);

$('btnBackToLabs').addEventListener('click', backToLabs);
$('btnSignOut')?.addEventListener('click', async () => {
  // POST-only on the Worker; a GET is refused. The page reload lands on the
  // login form because the cookie is gone.
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

$('btnRefreshFiles').addEventListener('click', refreshFiles);
$('btnNewFile').addEventListener('click', newFile);
$('btnReconnectTerm').addEventListener('click', reconnectTerminal);
$('btnSaveFile').addEventListener('click', saveFile);

// The workspace window's tabs (Terminal, Editor, one per service) and the guide's.
for (const tab of document.querySelectorAll('#workspaceTabs .tab[data-view]')) {
  tab.addEventListener('click', () => activateWorkspaceTab(tab, { focus: true }));
}
const workspaceTabs = () => [...$('workspaceTabs').querySelectorAll('.tab:not([hidden])')];
wireTablist($('workspaceTabs'), workspaceTabs, (tab) => activateWorkspaceTab(tab, { focus: false }));

for (const tab of document.querySelectorAll('#guideTabs .tab[data-guide-tab]')) {
  tab.addEventListener('click', () => showGuideTab(tab.dataset.guideTab));
}
wireTablist($('guideTabs'), () => [...$('guideTabs').querySelectorAll('.tab:not([hidden])')], (tab) => showGuideTab(tab.dataset.guideTab));

// Hiding the guide: the keyboard goes to the rail's Show button, and Show takes it back to the tab.
$('btnGuideToggle').addEventListener('click', () => setGuideOpen(!guide.open));
$('btnGuideHide').addEventListener('click', () => {
  setGuideOpen(false);
  $('btnGuideShow').focus();
});
$('btnGuideShow').addEventListener('click', () => {
  setGuideOpen(true);
  (guide.tab ? guideTab(guide.tab) : $('btnGuideToggle')).focus();
});

// The Services popover: Escape closes it (and the keyboard returns to its button); so does a click elsewhere.
$('btnServices').addEventListener('click', () => setServicesOpen($('servicesPop').hidden));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('servicesPop').hidden) return;
  setServicesOpen(false);
  $('btnServices').focus();
});
document.addEventListener('click', (event) => {
  if (!$('servicesPop').hidden && !$('servicesBlock').contains(event.target)) setServicesOpen(false);
});
$('btnActivityToggle').addEventListener('click', () => setActivityOpen($('activityPane').dataset.open !== 'true'));
$('btnDockAction').addEventListener('click', dockPressed);

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
$('btnServiceDownRetry').addEventListener('click', () => {
  if (state.service) openService(state.service, activeServiceTab(), { reload: true });
});
$('btnServiceDownRestart').addEventListener('click', (event) => {
  if (state.service) restartService(state.service, event.currentTarget);
});
// A new tab is a first-party context, where the partitioned cookie set for
// the embed is not sent; so the link carries no token at rest and the
// click opens the tokenised URL, which the proxy immediately redirects to
// the token-less one. Middle-click is the same; the context menu still
// gets the plain href.
function openServiceTab(event) {
  if (!state.session || !state.service || event.button > 1) return;
  event.preventDefault();
  window.open(serviceUrl(state.session.id, state.session.token, state.service), '_blank', 'noopener,noreferrer');
}
$('serviceOpen').addEventListener('click', openServiceTab);
$('serviceOpen').addEventListener('auxclick', openServiceTab);
$('btnServiceReload').addEventListener('click', () => {
  if (state.service) openService(state.service, activeServiceTab(), { reload: true });
});
$('btnServiceRestart').addEventListener('click', (event) => {
  if (state.service) restartService(state.service, event.currentTarget);
});

$('btnToastClose').addEventListener('click', () => ($('toast').hidden = true));

// The browser's own "leave site?" prompt, only while there is something to lose.
window.addEventListener('beforeunload', (event) => {
  if (state.dirty && state.session) event.preventDefault();
});

// ---------------------------------------------------------- 401 recovery

/**
 * A session token the API refuses is usually one that has aged out under a
 * tab that stayed open. The start route rejoins the caller's live session
 * with a fresh token, so ask it for one (api.js does, once per failing
 * request, and replays the request with it).
 *
 * If the rejoin lands on a *different* session the old one is over and the
 * API has started a new lab for this user; that is adopted rather than
 * left running unseen. If the console's own sign-in is what expired, the
 * rejoin 401s too, and the learner is told to sign in.
 */
configureAuth({
  async refresh() {
    const current = state.session;
    // Never resurrect a session that has ended: the rejoin would start a
    // new container the learner did not ask for.
    if (!current || $('statePill').dataset.state === 'ended') return null;
    let started;
    try {
      started = await api.startSession(current.lab);
    } catch (err) {
      if (err.status === 401) showSignedOut();
      return null;
    }
    if (started.id !== current.id) {
      adoptSession(started, current.lab);
      return null;
    }
    current.token = started.token;
    if (started.urls) current.urls = started.urls;
    rememberSession(current);
    // A stream the browser gave up on carried the old token in its URL.
    if (state.events?.readyState === EventSource.CLOSED) openEventStream();
    return started.token;
  },
  signedOut() {
    if ($('statePill').dataset.state !== 'ended') showSignedOut();
  },
});

function adoptSession(started, lab) {
  teardownSession();
  state.session = { id: started.id, token: started.token, lab, urls: started.urls };
  state.lab = labsBySlug.get(lab) ?? null;
  rememberSession(state.session);
  toast('Your previous lab had ended, so a new one was started.', 'info');
  enterSession();
}

/**
 * The console's own sign-in is gone, so nothing further can be asked of
 * the API. Leaves the session remembered — signing in and reloading comes
 * straight back to it — and says so where the learner is looking.
 */
function showSignedOut() {
  if (!state.session) return;
  teardownSession();
  state.session = null;
  $('workspace').hidden = true;
  $('sessionBar').hidden = true;
  $('sessionActions').hidden = true;
  $('btnBackToLabs').hidden = true;
  $('launcher').hidden = false;
  parkLaunchError();
  const error = $('launchError');
  error.className = 'notice notice-warn';
  error.textContent = 'Signed out — sign in to return to your running lab. ';
  const link = document.createElement('a');
  link.href = '/';
  link.textContent = 'Sign in';
  error.append(link);
  error.hidden = false;
  syncQuizButtons();
}

showIdentity();
$('saveShortcut').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S';
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
    // A phone cannot run a lab, so it does not walk back into one: the launcher shows it
    // as the lab in progress, and Rejoin explains. The record stays for the computer.
    if (isPhoneLike(readDevice())) return await loadLabs();

    // No recovery here: a refused token means the remembered session is
    // gone, and rejoining to find out could start a new container.
    const status = await api.status(saved.id, saved.token, { recover: false });
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
    // Only over the picker: someone already inside a lab has found their way.
    if (!state.session) maybeShowOnboarding();
    initLearning();
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
