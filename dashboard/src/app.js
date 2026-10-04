import { api, plainError, configureAuth, eventsUrl, serviceUrl, serviceBaseUrl } from './api.js';
import { attachTerminal } from './terminal.js';
import { diffLines, collapseContext } from './diff.js';
import {
  breadcrumbs,
  buildLauncherModel,
  findModule,
  findPath,
  heroLede,
  labStatus,
  locateLab,
  moduleLabel,
  moduleMetaLine,
  passedSlugs,
  pathCardLine,
  pathId,
  scopeEntries,
  summaryLine,
  unmetPrerequisite,
  visibleLabs,
} from './launcher-model.js';
import { isPhoneLike, readDevice } from './device.js';
import { createRouter } from './router.js';
import { installCodeCopy } from './code-copy.js';
import { GUIDE_TAB_NAMES, buildRoute, isOpaqueId, routeTitle } from './routes.js';
import { icon, spriteIcon, uiIcon } from './icons.js';
import { createMasteryStore, normalizeLearn, normalizeOnboarding, onboardingFinished, suggestStart } from './learn-model.js';
import { runOnboarding } from './onboarding.js';
import { createProgressHub } from './progress-hub.js';
import { runBeforeYouBegin } from './before-you-begin.js';
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
    // Whose it is rides along, so a session this browser kept for one learner is never taken up by another.
    localStorage.setItem(SESSION_STORAGE, JSON.stringify({ ...session, userId: state.userId ?? session.userId }));
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
    const saved = raw ? JSON.parse(raw) : null;
    if (saved?.userId && state.userId && saved.userId !== state.userId) return null;
    return saved;
  } catch {
    return null;
  }
}

const state = {
  /** The signed-in learner's opaque id (GET /api/me), the `<user>` of a session's address; null until it is known. */
  userId: null,
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

/**
 * An address on the public site. The site's origin is written once, in the footer's Status link (index.html);
 * this reads it from there. Null when that link is missing, and the caller then leaves the link out.
 */
function siteHref(path) {
  try {
    return new URL(path, $('footerStatus').href).href;
  } catch {
    return null;
  }
}

/** What this browser knows about the learner's learning (learn-model.js); never sent anywhere. */
const mastery = createMasteryStore();

/**
 * The learner's skills, awards and path (progress-hub.js): the profile page, the bands on Home, /paths/mine and the
 * award toast. It is given what only this file knows; `progress` is how the rest of the file reaches it.
 */
const progress = createProgressHub({
  api,
  plainError,
  getLevels: () => mastery.get().onboarding?.levels,
  hasQuiz: () => Object.keys(mastery.get().onboarding?.levels ?? {}).length > 0,
  isRunning: (slug) => slug === runningSlug,
  labKnown: (slug) => labsBySlug.has(slug),
  plansHref: () => siteHref('/#pricing'),
  startLab: (slug, card) => {
    const lab = labsBySlug.get(slug);
    if (lab) beginLab(lab, card);
  },
  reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
});

// ------------------------------------------------------------------ routes

/*
 * Every screen has an address (routes.js has the table, docs/console-routes.md the story). The URL
 * decides what shows: on load, on Back and Forward and on a link click `applyRoute` shows the route's
 * screen; the screens a learner moves between themselves (a step, a tab, Start) keep the address in
 * step through `setRoute`, which never re-renders. A session's address is /u/<user>/labs/<lab>/session/<session>:
 * the ids are labels, not credentials, and the session token is never put in an address.
 */
const router = createRouter();
/** Above zero while a route is being shown: a step or tab that comes on screen then only corrects the address. */
let applying = 0;
/** Bumped per applyRoute, so a slow one (a fetch) cannot show over a newer one. */
let routeToken = 0;
/** The first catalogue load: a route that names a lab waits for it. */
let labsReady = Promise.resolve();
/** Who is signed in (GET /api/me): a session's address names the learner, so a route to one waits for this too. */
let meReady = Promise.resolve();
/** The tab a session URL asked for, applied once the lab is up and its guide is built. */
let pendingTab = null;
/** The pages that live inside #launcher: home, a path, a module and a lab's own page. */
const BROWSE_ROUTES = new Set(['launcher', 'path', 'module', 'lab', 'profile', 'my-path']);
/**
 * Set (per browser tab) when the learner leaves a running lab for the launcher, so a refresh of the
 * launcher does not walk them straight back in. A fresh tab has none, and "/" then rejoins as it always did.
 */
const LEFT_SESSION = 'opalix.leftSession';

function leftSession(value) {
  try {
    if (value === undefined) return sessionStorage.getItem(LEFT_SESSION) === '1';
    if (value) sessionStorage.setItem(LEFT_SESSION, '1');
    else sessionStorage.removeItem(LEFT_SESSION);
  } catch {
    /* blocked storage: "/" rejoins, as before */
  }
  return false;
}

/** Moves the address to a route without showing anything (the screen is already up). Replaces while a route is being shown. */
function setRoute(name, params = {}, { replace = false } = {}) {
  try {
    router.navigate(name, params, { replace: replace || applying > 0, silent: true });
  } catch {
    /* an address this console cannot spell: the bar stays as it is */
  }
  updateTitle();
}

/** The browser tab's title for the screen the address names. */
function updateTitle() {
  if (!$('notFound').hidden) {
    document.title = routeTitle({ name: 'not-found' });
    return;
  }
  if (!$('sessionGone').hidden) {
    document.title = 'Session not active · Opalix labs';
    return;
  }
  const route = router.current();
  const titles = {};
  if (route.name === 'path' || route.name === 'module') {
    const path = findPath(launcherModel, route.path);
    titles.path = path?.title;
    if (route.name === 'module') titles.module = findModule(path, route.module)?.title;
  }
  document.title = routeTitle(route, route.slug ? (labsBySlug.get(route.slug)?.title ?? null) : null, titles);
}

/** Said to screen readers when the URL, not a click on the page, changed the screen. */
function announceRoute(text) {
  const live = $('routeLive');
  live.textContent = '';
  // Set on the next turn so the same words said twice are still said.
  setTimeout(() => (live.textContent = text), 50);
}

/** A quiet screen while a route's data loads, instead of the launcher flashing past. */
function showTransient(text) {
  showLearnScreen();
  const note = node('p', 'learn-lede', text);
  note.setAttribute('role', 'status');
  $('learnHost').replaceChildren(note);
}

/**
 * The params of a session's address: the lab, and (once the learner's id and the session's own are known) the
 * two ids, so the address is /u/<user>/labs/<lab>/session/<session>. Without them it is the old form.
 */
function sessionParams(slug, tab, service, session = state.session) {
  const params = { slug };
  if (tab) params.tab = tab;
  if (tab === 'service' && service) params.service = service;
  if (isOpaqueId(state.userId) && isOpaqueId(session?.id)) {
    params.userId = state.userId;
    params.sessionId = session.id;
  }
  return params;
}

/** After a refused navigation (unsaved edits kept), the address goes back to the session. */
function restoreSessionUrl() {
  if (state.session) setRoute('session', sessionParams(state.session.lab));
}

/**
 * Takes down whatever screen is up so a route's own can show. A running lab is left running (its
 * record stays, so the lab's page offers Resume). Returns false when the learner chose to stay
 * because of unsaved edits.
 */
function clearScreens() {
  if (state.session) {
    if (state.dirty && state.openFile && !confirm(`Leave the lab? Your unsaved changes to ${state.openFile} will be lost. The lab keeps running.`)) return false;
    leaveSessionScreen(false);
  }
  $('notFound').hidden = true;
  $('sessionGone').hidden = true;
  hideLearnScreen();
  closeNotice();
  return true;
}

/** Shows the screen a route names. */
async function applyRoute(route, { initial = false } = {}) {
  const mine = ++routeToken;
  const stale = () => mine !== routeToken;
  await Promise.all([labsReady, meReady]);
  if (stale()) return;
  try {
    switch (route.name) {
      case 'launcher':
      case 'path':
      case 'module':
      case 'lab':
      case 'profile':
      case 'my-path':
        showBrowseRoute(route, initial);
        break;
      case 'onboarding':
        await openOnboardingRoute(stale, initial);
        break;
      case 'lab-step':
        await openLabStepRoute(route, stale);
        break;
      case 'session':
        await openSessionRoute(route, stale);
        break;
      default:
        showNotFound('page');
    }
  } catch (err) {
    console.error('Could not show this address', err);
  }
  if (!stale()) updateTitle();
}

function showBrowseRoute(route, initial = false) {
  if (!clearScreens()) return restoreSessionUrl();
  $('launcher').hidden = false;
  syncNav(route);
  syncQuizButtons();
  renderBrowse(route, { initial });
  // Which lab is running decides Start or Resume on every page; the card itself is home's.
  if (!initial) renderResumeCard();
}

function showNotFound(kind) {
  clearScreens();
  $('launcher').hidden = true;
  $('nfDetail').textContent =
    kind === 'lab'
      ? 'This console has no lab at this address.'
      : kind === 'path'
        ? 'This console has no learning path at this address.'
        : kind === 'module'
          ? 'This learning path has no module at this address.'
          : 'There is nothing at this address.';
  $('notFound').hidden = false;
  $('notFound').scrollTop = 0;
  window.scrollTo(0, 0);
  syncQuizButtons();
  updateTitle();
  $('nfTitle').focus();
  announceRoute('Page not found');
}

async function openOnboardingRoute(stale, initial) {
  await ensureOnboardingOffer();
  if (stale()) return;
  if (!onboardingOffer) {
    // No quiz is published: the address has nothing to show, so it becomes the launcher's.
    setRoute('launcher', {}, { replace: true });
    return showBrowseRoute({ name: 'launcher' }, initial);
  }
  if (!clearScreens()) return restoreSessionUrl();
  showQuiz();
}

/** The steps before a lab (/labs/<slug>/story ...). A lab with nothing to read has none: its own page is the address. */
async function openLabStepRoute(route, stale) {
  const lab = labsBySlug.get(route.slug);
  if (!lab) {
    // No catalogue at all (it failed to load) is the launcher's error to show, not a missing lab.
    return labsBySlug.size ? showNotFound('lab') : showBrowseRoute({ name: 'launcher' }, true);
  }
  // Already reading this lab's steps: Back and Forward only move between them.
  if (learnFlow?.goto && learnFlowLab === lab.slug && !$('learnScreen').hidden) {
    applying++;
    try {
      learnFlow.goto(route.step, route.n);
    } finally {
      applying--;
    }
    return;
  }
  if (!clearScreens()) return restoreSessionUrl();
  showTransient('Opening the lab…');
  const entry = lab.has_learn ? await fetchLearn(lab.slug) : null;
  if (stale()) return;
  const hasScreen = entry && (entry.learn.story || entry.learn.concepts.length > 0);
  if (!hasScreen) return landOnLabPage(lab.slug);
  openLearnFlow(lab, entry, route.step, { fromRoute: true, n: route.n });
}

/** The lab's own page, with its address corrected to it (in place: the address that led here was not a page). */
function landOnLabPage(slug) {
  setRoute('lab', { slug }, { replace: true });
  showBrowseRoute({ name: 'lab', slug, search: '' }, false);
}

/**
 * A session's address. The new form (/u/<user>/labs/<lab>/session/<session>) names a learner and one of their
 * sessions: another learner's id is "not found", and a session that is not the learner's active one for the lab
 * is the "not active" page. The old form (/labs/<lab>/session) starts the lab or rejoins it, as it always did;
 * either way the address becomes the new form once the session's id is known.
 */
async function openSessionRoute(route, stale) {
  const { slug } = route;
  const modern = Boolean(route.sessionId);
  if (modern && (!state.userId || route.userId !== state.userId)) return showNotFound('page');
  if (labsBySlug.size && !labsBySlug.has(slug)) return showNotFound('lab');
  if (route.invalidTab) {
    // /session/whatever: the session itself, not a dead end.
    setRoute('session', modern ? { slug, userId: route.userId, sessionId: route.sessionId } : { slug }, { replace: true });
    route = { ...route, tab: undefined, service: undefined, invalidTab: false };
  }
  if (state.session && state.session.lab === slug && (!modern || state.session.id === route.sessionId)) {
    // Back and Forward only moved between this lab's tabs.
    if (!modern) ensureSessionUrl(slug);
    applySessionTab(route);
    return;
  }
  if (!clearScreens()) return restoreSessionUrl();
  // A phone cannot run a lab: the notice says so, with this lab's own link.
  if (guardDesktop(slug)) return;
  showTransient('Opening your lab…');
  if (modern) return openSessionById(route, stale);

  const saved = rememberedSession();
  if (saved?.id && saved?.token) {
    let status = null;
    try {
      status = await api.status(saved.id, saved.token, { recover: false });
    } catch {
      /* gone: the record is dropped below */
    }
    if (stale()) return;
    const live = status?.meta?.state;
    if (live === 'running' || live === 'starting') return rejoinRemembered(saved, status, route);
    forgetSession();
    if (live === 'ended') {
      // A refresh at the end of a session must not buy a new container: the lab is one press away.
      toast('That lab has ended. Start it again when you are ready.');
      return landOnLabPage(slug);
    }
  }

  const at = locateLab(launcherModel, slug);
  if (at?.entry.locked) {
    toast(`Locked until ${at.entry.lockedByTitle ?? at.entry.lockedBy} passes. Pass every check of that lab to unlock this one.`);
    return landOnLabPage(slug);
  }

  pendingTab = route.tab ? route : null;
  if (await startSession(slug)) return;
  // It could not start (the reason is on screen as a toast): home, where Start can be tried again.
  pendingTab = null;
  router.navigate('launcher', {}, { replace: true });
}

/** A session address of the new form: this browser's own session, or the learner's active one, or "not active". */
async function openSessionById(route, stale) {
  const { slug, sessionId } = route;
  const saved = rememberedSession();
  if (saved?.id === sessionId && saved?.token) {
    let status = null;
    try {
      status = await api.status(saved.id, saved.token, { recover: false });
    } catch {
      /* gone: the record is dropped below */
    }
    if (stale()) return;
    const live = status?.meta?.state;
    if ((live === 'running' || live === 'starting') && (status.meta.lab_slug ?? saved.lab) === slug) return rejoinRemembered(saved, status, route);
    forgetSession();
  }
  // Not a session this browser holds (a fresh browser, a link someone sent): ask which are the learner's.
  const active = await fetchActiveSessions();
  if (stale()) return;
  const mine = active?.find((s) => s.lab === slug) ?? null;
  if (mine && mine.id === sessionId) {
    // The learner's active session for this lab, and this browser has no token for it: rejoining hands one out.
    pendingTab = route.tab ? route : null;
    sessionUrlReplace = true;
    if (await startSession(slug)) return;
    sessionUrlReplace = false;
    pendingTab = null;
  }
  showSessionGone(slug, mine);
}

/** The learner's live sessions as the Worker lists them (`[{ id, lab, state }]`), or null when it cannot say. */
async function fetchActiveSessions() {
  try {
    const body = await api.activeSessions();
    return Array.isArray(body?.sessions) ? body.sessions : null;
  } catch {
    return null;
  }
}

/** What the "not active" page offers: Rejoin when the learner has a (different) active session for this lab. */
let goneFor = null;

function showSessionGone(slug, mine) {
  hideLearnScreen();
  $('launcher').hidden = true;
  $('notFound').hidden = true;
  goneFor = { slug, mine };
  const title = labsBySlug.get(slug)?.title ?? slug;
  $('sgDetail').textContent = mine
    ? `This address names a session that has ended, or one that is not yours. You do have a session running for ${title}: rejoin it to carry on.`
    : `This address names a session that has ended, or one that is not yours. Go back to the labs to start ${title} again.`;
  $('sgError').hidden = true;
  const rejoin = $('sgRejoin');
  rejoin.hidden = !mine;
  rejoin.disabled = false;
  rejoin.removeAttribute('aria-busy');
  $('sessionGone').hidden = false;
  $('sessionGone').scrollTop = 0;
  window.scrollTo(0, 0);
  syncQuizButtons();
  updateTitle();
  $('sgTitle').focus();
  announceRoute('This session is not active');
}

$('sgRejoin').addEventListener('click', async () => {
  if (!goneFor?.mine) return;
  const { slug } = goneFor;
  if (guardDesktop(slug)) return;
  const button = $('sgRejoin');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  $('sgError').hidden = true;
  // The address is replaced with the active session's own, not pushed beside this one.
  sessionUrlReplace = true;
  const ok = await startSession(slug);
  if (ok) return;
  sessionUrlReplace = false;
  button.disabled = false;
  button.removeAttribute('aria-busy');
  $('sgError').textContent = 'Could not rejoin the session. Try again, or go back to the labs.';
  $('sgError').hidden = false;
});

/** Takes the lab this browser remembers (the API says it is up) as the session. */
function rejoinRemembered(saved, status, route) {
  const actual = status.meta.lab_slug ?? saved.lab;
  const same = actual === route.slug;
  state.session = saved;
  state.lab = labsBySlug.get(actual) ?? null;
  setRoute('session', same ? sessionParams(actual, route.tab, route.service) : sessionParams(actual), { replace: true });
  pendingTab = same && route.tab ? route : null;
  enterSession();
  if (!same) toast('You already had a lab running, so you are back in it. End it to start another.');
}

/** A session URL's tab, now (the guide is built) or once it is. */
function applySessionTab(route) {
  if (!route.tab) return;
  if (!guide.ready) {
    pendingTab = route;
    return;
  }
  showRouteTab(route);
}

function applyPendingTab() {
  const route = pendingTab;
  pendingTab = null;
  if (route && state.session?.lab === route.slug) showRouteTab(route);
}

/** Shows the tab of a session URL; one this lab does not have makes the URL the session's own. */
function showRouteTab(route) {
  const { tab } = route;
  let shown = false;
  if (GUIDE_TAB_NAMES.includes(tab)) {
    if (guide.tabs.includes(tab)) {
      showGuideTab(tab, { reveal: true });
      shown = true;
    }
  } else if (tab === 'terminal' || tab === 'editor') {
    state.landed = true;
    showView(tab, undefined, { focus: false });
    shown = true;
  } else if (tab === 'service') {
    const el = [...$('serviceTabs').querySelectorAll('.tab')].find((t) => t.dataset.service === route.service);
    if (el) {
      state.landed = true;
      openService(route.service, el);
      shown = true;
    }
  }
  if (!shown) setRoute('session', sessionParams(route.slug), { replace: true });
}

/** A tab the learner chose: the address follows, in place (Back does not step through every tab). */
function syncTabUrl(tab, service) {
  const slug = state.session?.lab;
  if (!slug || router.current().name !== 'session') return;
  setRoute('session', sessionParams(slug, tab, service), { replace: true });
}

/** Set by a caller that wants the session's address replaced rather than pushed (Rejoin on a fresh browser). */
let sessionUrlReplace = false;

/**
 * The session's address, for a session that came on screen some other way (Start on a lab's page, a rejoin from home,
 * an old-form address). An address that is already a session address of this lab is corrected in place: the old form
 * gains the ids, and a session address with another session's id takes the one that is open.
 */
function ensureSessionUrl(slug) {
  const route = router.current();
  const same = route.name === 'session' && route.slug === slug;
  const params = sessionParams(slug, same ? route.tab : undefined, same ? route.service : undefined);
  const replace = sessionUrlReplace || same;
  sessionUrlReplace = false;
  let wanted = null;
  try {
    wanted = buildRoute('session', { ...params, search: location.search });
  } catch {
    /* an address this console cannot spell: the bar stays as it is */
  }
  if (wanted === null || wanted === location.pathname + location.search) return;
  setRoute('session', params, { replace });
}

// ---------------------------------------------------------------- launcher

/** The catalogue, kept so a running session can show its lab's context. */
const labsBySlug = new Map();
/** Slugs the learner has passed every check of (the whole catalogue: a visible lab may name an archived prerequisite). */
let passedLabs = new Set();
/** The first catalogue load failed (and there is no earlier one to keep showing): the list says why. */
let catalogueFailed = false;

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

/**
 * Reads the catalogue and the learner's progress, and draws the page that is open. Asked again after a lab (so its
 * progress shows): the page stays as it is until the answer is in, and a failed refresh keeps what was drawn.
 */
async function loadLabs() {
  const list = $('labList');
  parkLaunchError();
  const refreshing = Boolean(launcherModel) && !catalogueFailed;
  if (!refreshing) {
    $('labCount').textContent = '';
    $('labFilters').hidden = true;
    if (!list.querySelector('.lab-skeleton')) showLabSkeleton();
  }
  try {
    const labs = await api.labs();
    catalogueFailed = false;
    // Every lab is known before any card is drawn: a card names its
    // prerequisite by title, and that lab may sit in a later group. This map
    // holds the archived labs too: an address, the resume card and Start look
    // a lab up here, and an archived lab must still resolve. Only what the
    // learner is shown (cards, counts, filters, suggestions) leaves them out.
    for (const lab of labs) labsBySlug.set(lab.slug, lab);
    passedLabs = passedSlugs(labs);
    const visible = visibleLabs(labs);
    launcherModel = buildLauncherModel(labs, pathMeta, { passed: passedLabs });
    renderFilters(visible);
    list.removeAttribute('aria-busy');
    if (!refreshing || !$('launcher').hidden) renderBrowseIfShown(true);
    updateTitle();
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
      catalogueFailed = true;
      return;
    }
    if (refreshing) return;
    catalogueFailed = true;
    list.innerHTML = `
      <div class="empty-state">
        <p class="error"></p>
        <button class="btn" id="btnRetryLabs">Try again</button>
      </div>`;
    list.querySelector('.error').textContent = `Could not load labs. ${plainError(err)}`;
    list.querySelector('#btnRetryLabs').addEventListener('click', () => {
      showLabSkeleton();
      loadLabs();
    });
  } finally {
    list.removeAttribute('aria-busy');
    renderResumeCard();
  }
}

// ------------------------------------------------ pages: paths, modules, labs

/*
 * What is drawn comes from buildLauncherModel (launcher-model.js): the labs
 * grouped by path and module, with every total. Text from the catalogue and
 * from packages/catalogue/paths.json always goes in through textContent.
 *
 * One page at a time, inside #launcher: home (a card per path), a path (a card per module), a module (its intro
 * beside its labs) and a lab (its own page). Search and filters act on the labs of the page that is open.
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

/** A link to a route of the console: a real address, so it can be opened in a new tab, and a click stays in the app. */
function routeLink(className, text, route) {
  const link = node('a', className, text);
  link.href = buildRoute(route.name, route);
  return link;
}

/** The model the pages are drawn from, kept so the resume card can say where its lab sits. */
let launcherModel = null;
/** The slug of the lab that is still running (verified by renderResumeCard), so its row says Resume. */
let runningSlug = null;

/** The entries of `entries` the search and filters let through. */
const shown = (entries) => entries.filter((e) => labMatches(e.lab));

/** Where the platform quiz says to begin: the first module card whose area is new to this learner (none before the quiz). */
function suggestedStart() {
  const cards = (launcherModel?.paths ?? []).flatMap((p) => (p.cards ? p.modules.map((m) => ({ path: p.slug, number: m.number })) : []));
  return suggestStart(cards, mastery.get());
}

/** Redraws the page that is on screen (the catalogue or the filters changed). */
function renderBrowseIfShown(quiet = true) {
  if ($('launcher').hidden || state.session) return;
  const route = router.current();
  if (BROWSE_ROUTES.has(route.name)) renderBrowse(route, { quiet });
}

/** What a browse route stands for in the catalogue: `{ kind, ... }`, `{ redirect }` or `{ missing }`. */
function resolveBrowse(route) {
  switch (route.name) {
    case 'launcher':
      return { kind: 'home' };
    case 'profile':
      return { kind: 'profile' };
    case 'my-path':
      return { kind: 'mypath' };
    case 'path': {
      const path = findPath(launcherModel, route.path);
      return path ? { kind: 'path', path } : { missing: 'path' };
    }
    case 'module': {
      const path = findPath(launcherModel, route.path);
      if (!path) return { missing: 'path' };
      const module = findModule(path, route.module);
      if (module) return { kind: 'module', path, module };
      // A path with no module cards is its labs: its one implicit module is the path's own page.
      if (!path.cards && path.modules.some((m) => m.number === route.module)) return { redirect: { name: 'path', path: route.path } };
      return { missing: 'module' };
    }
    case 'lab': {
      const lab = labsBySlug.get(route.slug);
      return lab ? { kind: 'lab', lab } : { missing: 'lab' };
    }
    default:
      return { missing: 'page' };
  }
}

/**
 * Draws the page a browse route names into #launcher: the trail, then home's paths, a path's modules, a module's
 * labs or a lab's own page. `quiet` redraws what is on screen (a filter changed, the catalogue came in again):
 * no scrolling, focus or announcement. `initial` is the first page of this load: nothing is moved or said.
 */
function renderBrowse(route = router.current(), { quiet = false, initial = false } = {}) {
  const list = $('labList');
  if (catalogueFailed || !launcherModel) {
    // Nothing to draw: the list already says why the catalogue is not here.
    $('hello').hidden = false;
    $('crumbs').hidden = true;
    return;
  }
  const view = resolveBrowse(route);
  if (view.missing) return showNotFound(view.missing);
  if (view.redirect) {
    setRoute(view.redirect.name, view.redirect, { replace: true });
    return renderBrowse(router.current(), { quiet, initial });
  }

  const entries = scopeEntries(launcherModel, route);
  const matching = shown(entries);
  // A filter saved earlier may hide everything a link is about: a deep link opens with them cleared.
  if (initial && view.kind !== 'lab' && entries.length && !matching.length && filtersActive()) {
    resetFilters();
    return renderBrowse(route, { quiet, initial });
  }

  parkLaunchError();
  list.removeAttribute('aria-busy');
  const home = view.kind === 'home';
  $('hello').hidden = !home;
  renderCrumbs(route, view.kind === 'lab' ? view.lab : null);
  const filterable = view.kind !== 'lab' && entries.length > 0;
  $('labFilters').hidden = !filterable;
  $('labCount').textContent = filterable ? `${matching.length} of ${entries.length} labs` : '';
  $('labNoMatch').hidden = !filterable || matching.length > 0;
  $('btnClearFilters').hidden = !filtersActive();
  list.className = `lab-list lab-page-${view.kind}`;

  switch (view.kind) {
    case 'home':
      list.replaceChildren(progress.homeBands(), homePage());
      break;
    case 'profile':
      list.replaceChildren(progress.profileScreen());
      break;
    case 'mypath':
      list.replaceChildren(progress.pathScreen());
      break;
    case 'path':
      list.replaceChildren(pathPage(view.path, suggestedStart()));
      break;
    case 'module':
      list.replaceChildren(moduleCard(view.path, view.module, suggestedStart()));
      break;
    default:
      list.replaceChildren(labPage(view.lab));
  }
  syncQuizButtons();
  if (quiet) return;

  $('launcher').scrollTo({ top: 0, behavior: 'auto' });
  window.scrollTo(0, 0);
  if (initial) return;
  const toPaths = focusFirstPath;
  focusFirstPath = false;
  const [target, said] =
    view.kind === 'home'
      ? [toPaths ? (list.querySelector('.path-card-title a') ?? $('heroTitle')) : $('heroTitle'), 'Labs']
      : view.kind === 'profile'
        ? [list.querySelector('.profile-title'), 'Your profile']
        : view.kind === 'mypath'
          ? [list.querySelector('.mypath-title'), 'Your path']
          : view.kind === 'path'
            ? [list.querySelector('.group-head'), view.path.title]
            : view.kind === 'module'
              ? [list.querySelector('.module-title'), moduleLabel(view.module)]
              : [list.querySelector('.lab-detail-title'), view.lab.title || view.lab.slug];
  target?.focus({ preventScroll: true });
  announceRoute(said);
}

/** The header's "Paths" asked for home with focus on the first path rather than on the heading. */
let focusFirstPath = false;

/** The header's links say which page is open: Profile on /profile, Labs on the others. */
function syncNav(route) {
  const profile = route.name === 'profile';
  if (profile) $('navProfile').setAttribute('aria-current', 'page');
  else $('navProfile').removeAttribute('aria-current');
  if (profile) $('navLabs').removeAttribute('aria-current');
  else $('navLabs').setAttribute('aria-current', 'page');
}

/** The trail above the page: Home > Path > Module > Lab, as a nav landmark; the page itself is the last item. */
function renderCrumbs(route, lab) {
  const items = breadcrumbs(launcherModel, route, lab);
  const trail = $('crumbList');
  trail.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    if (item.route) {
      li.append(routeLink('', item.label, item.route));
    } else {
      const here = node('span', '', item.label);
      here.setAttribute('aria-current', 'page');
      li.append(here);
    }
    trail.append(li);
  }
  $('crumbs').hidden = false;
}

/** Home: one card per path with its title, a line about it, how many modules and labs, and how far along the learner is. */
function homePage() {
  const model = launcherModel;
  if (!model.paths.length) {
    const empty = node('div', 'empty-state');
    empty.append(node('p', '', 'No labs are available yet.'));
    empty.append(node('p', 'muted small', 'Please check back soon.'));
    $('heroLede').textContent = heroLede(0);
    return empty;
  }
  $('heroLede').textContent = heroLede(model.paths.filter((p) => !p.other).length);
  const cards = node('div', 'path-cards');
  const suggested = suggestedStart();
  for (const path of model.paths) {
    if (shown(path.labs).length) cards.append(pathCard(path, suggested));
  }
  return cards;
}

function pathCard(path, suggested = null) {
  const id = path.other ? 'path-other' : `path-${safeId(path.slug)}`;
  const card = node('article', 'path-card');
  card.id = id;
  card.dataset.path = path.slug;
  card.dataset.accent = path.accent;
  card.setAttribute('aria-labelledby', `${id}-title`);

  const tile = node('span', 'tile path-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(icon(path.icon || 'grid', 28));

  const title = node('h2', 'path-card-title');
  title.id = `${id}-title`;
  title.append(routeLink('', path.title, { name: 'path', path: pathId(path) }));

  // Where the platform quiz says to begin sits in this path: the badge here, the module's own on its page.
  const top = node('div', 'path-card-top');
  top.append(tile);
  if (suggested && suggested.path === path.slug) top.append(node('span', 'badge badge-suggested', 'Suggested start'));
  card.append(top, title);
  if (path.intro) card.append(node('p', 'path-card-intro', path.intro));
  card.append(node('p', 'path-card-line', pathCardLine(path)));
  card.append(progressBar(path.totals.done, path.totals.labs, `Labs done in ${path.title}`));
  const match = filtersActive() ? ` · ${shown(path.labs).length} match` : '';
  card.append(node('p', 'path-card-progress', `${path.totals.done} of ${path.totals.labs} done${match}`));
  return card;
}

/**
 * One path: a band with its icon, title, intro and totals, then its modules as cards that open the module's page,
 * or (a path with no module cards) its labs straight underneath. The heading is a direct child of the section,
 * and every part of the band is a grid item of it.
 */
function pathPage(path, suggested = null) {
  const id = path.other ? 'path-other' : `path-${safeId(path.slug)}`;
  const section = node('section', 'lab-group path');
  section.id = id;
  section.dataset.path = path.slug;
  section.dataset.accent = path.accent;
  section.setAttribute('aria-labelledby', `${id}-title`);

  const tile = node('span', 'tile path-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(icon(path.icon || 'grid', 32));

  const head = node('h1', 'group-head');
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
    const modules = node('div', 'module-cards');
    for (const module of path.modules) {
      if (shown(module.labs).length) modules.append(moduleSummaryCard(path, module, suggested));
    }
    body.append(modules);
  } else {
    // No module cards, so no module page: the labs are on the path's own page.
    body.append(labRows(shown(path.modules[0].labs), 'lab-rows lab-rows-flat'));
  }
  section.append(body);
  return section;
}

/** A module on its path's page: number, title, intro, size and progress; the title opens the module's page. */
function moduleSummaryCard(path, module, suggested = null) {
  const id = `${path.other ? 'path-other' : `path-${safeId(path.slug)}`}-module-${module.number}`;
  const card = node('article', 'module-card');
  card.id = id;
  card.dataset.module = String(module.number);
  card.dataset.accent = module.accent;
  if (module.optional) card.dataset.optional = '1';
  card.setAttribute('aria-labelledby', `${id}-title`);

  const tile = node('span', 'tile module-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(icon(module.icon || 'grid', 24));
  card.append(tile, moduleEyebrow(path, module, suggested));

  const title = node('h2', 'module-title');
  title.id = `${id}-title`;
  title.append(routeLink('', module.title, { name: 'module', path: pathId(path), module: module.number }));
  card.append(title);
  if (module.intro) card.append(node('p', 'module-intro', module.intro));

  const { totals } = module;
  const match = filtersActive() ? ` · ${shown(module.labs).length} match` : '';
  card.append(node('p', 'module-meta', moduleMetaLine(totals)));
  card.append(progressBar(totals.done, totals.labs, `Labs done in ${module.title}`));
  card.append(node('p', 'module-progress', `${totals.done} of ${totals.labs} done${match}`));
  return card;
}

/** "Module 3", with its Optional and Suggested start badges. */
function moduleEyebrow(path, module, suggested) {
  const eyebrow = node('p', 'module-eyebrow');
  if (module.known) eyebrow.append(node('span', 'module-num', module.eyebrow));
  if (module.optional) eyebrow.append(node('span', 'badge badge-optional', 'Optional'));
  if (suggested && suggested.path === path.slug && suggested.number === module.number) {
    eyebrow.append(node('span', 'badge badge-suggested', 'Suggested start'));
  }
  return eyebrow;
}

/**
 * One module, as its own page: on the left its number, title, intro, what you will learn and a progress meter;
 * on the right its labs as rows, each with a way in and a link to the lab's page.
 */
function moduleCard(path, module, suggested = null) {
  const id = `${path.other ? 'path-other' : `path-${safeId(path.slug)}`}-module-${module.number}`;
  const card = node('section', 'module');
  card.id = id;
  card.dataset.module = String(module.number);
  card.dataset.accent = module.accent;
  if (module.optional) card.dataset.optional = '1';
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

  const eyebrow = moduleEyebrow(path, module, suggested);
  if (eyebrow.childElementCount) info.append(eyebrow);

  const title = node('h1', 'module-title', module.title);
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

  card.append(info, labRows(shown(module.labs), 'lab-rows'));
  return card;
}

function labRows(entries, className) {
  const rows = node('div', className);
  for (const entry of entries) rows.append(labCard(entry));
  return rows;
}

/** best_score is a 0-1 fraction of the weighted points. */
const percent = (score) => Math.round((Number(score) <= 1 ? Number(score) * 100 : Number(score)) || 0);

/** The chips of a lab's facts, in the one text line support and the browser suite read ("slug@version · family · …"). */
function fillFacts(sub, lab) {
  // One fact per chip, but the text stays the plain line: the separators are
  // real text, only hidden visually, so nothing that reads .lab-sub sees a
  // different string. The chips are shown in a different order (type first) by CSS `order`.
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
        : 'Time limit for this lab';
    }
    chip.textContent = text;
    if (limit) chip.append(node('span', 'chip-limit', limit));
    sub.append(chip);
  });
}

/**
 * Where this person stands on a lab: done with the best score, locked until a named lab passes, in progress, or
 * not started; and the button's state to match. Shared by a lab's row and its page.
 */
function fillStanding(status, button, lab, { done, locked, lockedBy, lockedByTitle }) {
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
}

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
      <h2 class="lab-title"></h2>
      <div class="lab-sub"></div>
    </div>
    <div class="lab-act">
      <div class="lab-status"></div>
      <button class="btn lab-start">Start</button>
    </div>
    <a class="lab-about">About this lab</a>`;
  row.querySelector('.lab-num').textContent = String(index);
  const title = row.querySelector('.lab-title');
  title.id = titleId;
  title.textContent = lab.title;

  // The summary and objectives are one click away, on the lab's own page.
  const about = row.querySelector('.lab-about');
  about.href = buildRoute('lab', { slug: lab.slug });
  about.setAttribute('aria-describedby', titleId);

  fillFacts(row.querySelector('.lab-sub'), lab);

  const status = row.querySelector('.lab-status');
  const button = row.querySelector('.lab-start');
  fillStanding(status, button, lab, { done, locked, lockedBy, lockedByTitle });
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    beginLab(lab, row);
  });
  styleStartButton(row);
  if (lab.slug === runningSlug) applyRunning(row, true);
  return row;
}

/**
 * A lab's own page: what it is (summary, objectives, prerequisites) on the left, and where this learner stands on
 * it and the way in (Start, Resume or Locked, with the reason) on the right. An archived lab has one too.
 */
function labPage(lab) {
  const at = locateLab(launcherModel, lab.slug);
  const lockedBy = at ? at.entry.lockedBy : unmetPrerequisite(lab, passedLabs);
  const standing = {
    done: at ? at.entry.done : passedLabs.has(lab.slug),
    locked: lockedBy !== null,
    lockedBy,
    lockedByTitle: lockedBy === null ? null : (labsBySlug.get(lockedBy)?.title ?? lockedBy),
  };
  const page = node('article', `lab-detail${standing.done ? ' lab-done' : ''}${standing.locked ? ' lab-locked' : ''}`);
  page.dataset.slug = lab.slug;
  if (at) page.dataset.accent = at.module.known ? at.module.accent : at.path.accent;
  const titleId = `lab-title-${lab.slug}`;
  page.setAttribute('aria-labelledby', titleId);

  const main = node('div', 'lab-detail-main');
  const head = node('header', 'lab-detail-head');
  if (at && at.path.cards) head.append(node('p', 'lab-detail-where', `${at.module.known ? at.module.title : at.path.title} · lab ${at.position} of ${at.total}`));
  const title = node('h1', 'lab-detail-title', lab.title || lab.slug);
  title.id = titleId;
  title.tabIndex = -1;
  const sub = node('div', 'lab-sub');
  fillFacts(sub, lab);
  head.append(title, sub);
  main.append(head);

  if (lab.summary) {
    const section = node('section');
    section.append(node('h2', '', 'About this lab'), node('p', 'lab-summary', lab.summary));
    main.append(section);
  }
  const objectives = (lab.objectives ?? []).filter((o) => typeof o === 'string' && o.trim());
  if (objectives.length) {
    const section = node('section');
    const items = node('ul', 'lab-objectives');
    for (const objective of objectives) items.append(node('li', '', objective));
    section.append(node('h2', '', 'You will practise'), items);
    main.append(section);
  }

  const prerequisites = node('section', 'lab-prereq-section');
  prerequisites.append(node('h2', '', 'Prerequisites'));
  const needs = (lab.prerequisites ?? []).filter((s) => typeof s === 'string' && s);
  if (!needs.length) {
    prerequisites.append(node('p', 'lab-detail-note', 'None. You can start right away.'));
  } else {
    const items = node('ul', 'lab-prereqs');
    for (const slug of needs) {
      const li = document.createElement('li');
      const known = labsBySlug.get(slug);
      li.append(known ? routeLink('', known.title || slug, { name: 'lab', slug }) : node('span', '', slug));
      const met = passedLabs.has(slug);
      const state = node('span', 'prereq-state', met ? 'Passed' : 'Not passed yet');
      state.dataset.met = met ? '1' : '0';
      li.append(state);
      items.append(li);
    }
    prerequisites.append(items);
  }
  main.append(prerequisites);

  const side = node('aside', 'lab-detail-side');
  side.setAttribute('aria-label', 'Your progress and the way in');
  const status = node('div', 'lab-status');
  const button = node('button', 'btn lab-start');
  button.type = 'button';
  button.textContent = 'Start';
  fillStanding(status, button, lab, standing);
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-disabled') === 'true') return;
    beginLab(lab, page);
  });
  side.append(status, button);
  if (standing.locked) {
    side.append(node('p', 'lab-detail-note', `Pass every check of ${standing.lockedByTitle} first, then this lab opens.`));
  } else if (lab.estimated_minutes) {
    side.append(node('p', 'lab-detail-note', `About ${lab.estimated_minutes} min${lab.timeout_minutes ? `; the session ends after ${lab.timeout_minutes} min.` : '.'}`));
  }
  page.append(main, side);
  styleStartButton(page);
  if (lab.slug === runningSlug && !standing.locked) applyRunning(page, true);
  return page;
}

/**
 * What the button says and how it looks: Start (the dark one), Open again
 * for a lab already passed, Resume for the lab that is running, and a quiet
 * Locked while a prerequisite stands in the way. `row` is a lab's row or its page.
 */
function styleStartButton(row) {
  const button = row.querySelector('.lab-start');
  const running = row.classList.contains('lab-running');
  const locked = row.classList.contains('lab-locked');
  const done = row.classList.contains('lab-done');
  button.textContent = locked ? 'Locked' : running ? 'Resume' : done ? 'Open again' : 'Start';
  button.className = `btn lab-start ${locked ? 'btn-ghost' : running ? 'btn-accent' : done ? 'btn-ghost' : 'btn-strong'}`;
}

/** Marks a row (or a lab's page) as the lab that is running (or clears it), keeping the status line and the button in step. */
function applyRunning(row, on) {
  row.classList.toggle('lab-running', on);
  const status = row.querySelector('.lab-status');
  const badge = status.querySelector('.badge-running');
  if (on && !badge) status.prepend(node('span', 'badge badge-running', 'Running'));
  if (!on && badge) badge.remove();
  styleStartButton(row);
}

/** The pages learn which lab is running once the resume card has asked the API. */
function setRunningLab(slug) {
  runningSlug = slug;
  for (const row of $('labList').querySelectorAll('.lab, .lab-detail')) applyRunning(row, row.dataset.slug === slug && !row.classList.contains('lab-locked'));
}

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
}

function labMatches(lab) {
  const q = filters.q.trim().toLowerCase();
  if (q && !`${lab.title} ${lab.summary ?? ''} ${lab.slug}`.toLowerCase().includes(q)) return false;
  if (filters.difficulty.size && !filters.difficulty.has(lab.difficulty)) return false;
  if (filters.family.size && !filters.family.has(lab.family)) return false;
  if (filters.status.size && !filters.status.has(labStatus(lab))) return false;
  return true;
}

/** The page on screen is drawn again with what the search and filters let through (a launch error inside a card is parked and put back). */
function applyFilters() {
  renderBrowseIfShown(true);
}

/** No search, no filters: state, saved copy and the controls. */
function resetFilters() {
  filters.q = '';
  filters.difficulty.clear();
  filters.family.clear();
  filters.status.clear();
  saveFilters();
  $('labSearch').value = '';
  for (const chip of $('filterChips').querySelectorAll('.filter-chip')) chip.setAttribute('aria-pressed', 'false');
}

function clearFilters() {
  resetFilters();
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
  const found = await fetchRunning();
  if (mine !== resumeToken || state.session) return;
  if (!found) return setRunningLab(null);
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
    if (guardDesktop(slug)) return;
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
  if (!confirm('Discard the running lab? Its workspace is cleared and unsaved work is lost.')) return;
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
    toast(`Could not discard the lab. ${plainError(err)}`, 'bad');
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

/**
 * Shows the notice and returns true when this screen is too small to start a lab. `slug` is the lab
 * that was about to start: the notice's link is that lab's own address (the console's, with none).
 */
function guardDesktop(slug) {
  if (!isPhoneLike(readDevice())) return false;
  showDesktopNotice(slug);
  return true;
}

/** The link the notice offers: the lab's own address when a lab is open, else the console's. */
let noticeSlug = null;
function noticeUrl() {
  try {
    return `${location.origin}${noticeSlug ? buildRoute('lab', { slug: noticeSlug }) : '/'}`;
  } catch {
    return `${location.origin}/`;
  }
}

async function showDesktopNotice(slug) {
  hideLearnScreen();
  $('notFound').hidden = true;
  $('sessionGone').hidden = true;
  $('launcher').hidden = true;
  noticeSlug = slug || null;
  const url = noticeUrl();
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

/** Puts the notice away without showing anything in its place (the route that follows does). */
function closeNotice() {
  noticeToken++;
  noticeSlug = null;
  $('desktopNotice').hidden = true;
  clearInterval(state.resumeTimer);
}

function hideDesktopNotice({ focus = true } = {}) {
  closeNotice();
  $('launcher').hidden = false;
  // The launcher's own card ticks again.
  renderResumeCard();
  syncQuizButtons();
  // The page the address names is back (its heading takes focus unless the window was only resized).
  const route = router.current();
  if (BROWSE_ROUTES.has(route.name)) renderBrowse(route, { quiet: !focus });
}

$('dnBrowse').addEventListener('click', () => {
  closeNotice();
  // From a lab's own session address (a phone opened a link to it) the way out is home.
  if (!BROWSE_ROUTES.has(router.current().name)) setRoute('launcher', {}, { replace: true });
  hideDesktopNotice();
});

/** Copies the link; where the clipboard cannot be written, shows it selected instead. */
$('dnCopy').addEventListener('click', async () => {
  const url = noticeUrl();
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
  if ($('desktopNotice').hidden || isPhoneLike(readDevice())) return;
  hideDesktopNotice({ focus: false });
  // An address that was waiting for a wide screen (a lab's session, its lessons) now has one.
  const route = router.current();
  if (!BROWSE_ROUTES.has(route.name)) applyRoute(route);
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
 * begin" between Start and the boot for a lab that has learning content (its
 * story, then its lessons full screen), and in a session the Questions tab.
 * The story and the lessons are read there and are not in the session at
 * all. Everything a lab teaches comes
 * from its learn bundle (GET /api/learn/:slug); a lab without one, or a
 * bundle that cannot be fetched, behaves exactly as it did before.
 */

/** The screen that stands in for the launcher while a quiz or "Before you begin" is up. */
let learnFlow = null;

/** The lab whose "Before you begin" `learnFlow` is (null for the platform quiz). */
let learnFlowLab = null;

function showLearnScreen() {
  $('launcher').hidden = true;
  $('notFound').hidden = true;
  $('sessionGone').hidden = true;
  $('learnScreen').hidden = false;
  $('learnScreen').scrollTop = 0;
  syncQuizButtons();
}

function hideLearnScreen() {
  learnFlow?.destroy();
  learnFlow = null;
  learnFlowLab = null;
  $('learnScreen').hidden = true;
  $('learnHost').replaceChildren();
  syncQuizButtons();
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
  if (guardDesktop(lab.slug)) return;
  // A running lab is rejoined by Start, whatever was clicked: nothing to prepare for.
  const resuming = runningSlug !== null || !$('resumeCard').hidden;
  if (!lab.has_learn || resuming) return startSession(lab.slug, card);
  beginning = true;
  const buttons = document.querySelectorAll('.lab button, .lab-detail button, .resume button');
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
  openLearnFlow(lab, entry);
}

/**
 * "Before you begin" for a lab, on its step (the first when none is named): `initial` is the path's
 * word and `n` the `?step=N` number. From a card, each step pushes its address (/labs/x/story,
 * /labs/x/questions, /labs/x/lessons?step=4 ...); from an address, the steps only correct it, and a
 * refresh picks up the plan and the answers this tab already had.
 */
function openLearnFlow(lab, entry, initial, { fromRoute = false, n } = {}) {
  hideLearnScreen();
  showLearnScreen();
  learnFlowLab = lab.slug;
  if (fromRoute) applying++;
  try {
    learnFlow = runBeforeYouBegin({
      host: $('learnHost'),
      lab: { slug: lab.slug, title: lab.title },
      entry,
      store: mastery,
      post: (body) => api.postAnswers(body),
      initial,
      step: n,
      resume: fromRoute,
      onStep: (step, number) => onLabStep(lab.slug, step, number),
      // The screen may have shrunk since Start was pressed: ask again before a container is claimed.
      onStart: () => (guardDesktop(lab.slug) ? undefined : startSession(lab.slug)),
      // The container is warmed while the last steps are read, so Start is instant; a phone cannot run a lab, so it warms nothing.
      prepare: () => (isPhoneLike(readDevice()) ? undefined : api.prepareLab(lab.slug)),
      cancelPrepare: (opts) => api.cancelPrepare(lab.slug, opts),
      // Start was on the lab's page, so that is where Back to labs goes (a step on in history, as before).
      onBack: () => router.navigate('lab', { slug: lab.slug }),
    });
  } finally {
    if (fromRoute) applying--;
  }
}

/**
 * A step of "Before you begin" is on screen: the address says so (its word, and `?step=N` for a step
 * that is not the first of its kind). Each step pushes an address, so the browser's Back walks the
 * flow back one step; the flow keeps the answers, so nothing is asked twice.
 */
function onLabStep(slug, step, n) {
  // Already the address of this step, exactly (a junk ?step= a link carried is not): nothing to move.
  let wanted = null;
  try {
    wanted = buildRoute('lab-step', { slug, step, n: n ?? undefined, search: location.search });
  } catch {
    /* an address this console cannot spell: the bar stays as it is */
  }
  if (wanted === null || wanted === location.pathname + location.search) return updateTitle();
  setRoute('lab-step', { slug, step, n: n ?? undefined });
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

/** Asks once; a route to /onboarding and the launcher's own offer share the answer. */
let onboardingLoad = null;
function ensureOnboardingOffer() {
  onboardingLoad ??= loadOnboardingOffer().then((offer) => (onboardingOffer = offer));
  return onboardingLoad;
}

/** The two "Retake the quiz" controls show only when a quiz exists and the learner is at the launcher. */
function syncQuizButtons() {
  const atLauncher = !state.session && $('learnScreen').hidden && $('desktopNotice').hidden && $('notFound').hidden && $('sessionGone').hidden;
  $('btnRetakeQuiz').hidden = !(onboardingOffer && atLauncher);
  $('btnOnboardingRetake').hidden = !(onboardingOffer && atLauncher);
}

/**
 * Takes the learner to the page the quiz's last screen chose ({ name, params }), in place of the quiz. A module
 * page the catalogue does not have (or an address that cannot be spelled) is not gone to: false, and the caller
 * shows home, the labs list.
 */
function quizDestination(to) {
  if (!to) return false;
  try {
    if (to.name === 'module') {
      const path = findPath(launcherModel, to.params.path);
      if (!path || !findModule(path, to.params.module)) return false;
    } else if (to.name !== 'my-path') return false;
    router.navigate(to.name, to.params, { replace: true });
    return true;
  } catch {
    return false;
  }
}

function showQuiz() {
  if (!onboardingOffer || state.session) return;
  if ($('onboarding').open) $('onboarding').close();
  hideLearnScreen();
  showLearnScreen();
  // From a button the quiz pushes its address; from the address (or Back) it is already there.
  setRoute('onboarding');
  learnFlow = runOnboarding({
    host: $('learnHost'),
    onboarding: onboardingOffer,
    store: mastery,
    post: (body) => api.postAnswers(body),
    // The goal and the hours go to the server with the quiz result, which builds (or rebuilds) the learner's path.
    // Silent when it fails: the path is then simply not shown, and a retake tries again.
    onGoal: ({ levels, goal }) =>
      progress.savePathInputs(goal, levels).catch((err) => {
        progress.pathStore.invalidate();
        throw err;
      }),
    onExit: ({ completed, to }) => {
      // Done or skipped, the quiz is not somewhere Back should return to: the page the learner chose on the last
      // screen (their area's page, their personal path) or else home takes its place.
      if (!(completed && quizDestination(to))) router.navigate('launcher', {}, { replace: true });
      // The "Suggested start" badge follows the new levels.
      if (completed) {
        // The quiz result is the skills' starting point, and the path was just rebuilt from it.
        progress.profileStore.invalidate();
        loadLabs();
      }
    },
  });
}

/**
 * After the launcher is up: find out whether there is a quiz, show the
 * retake control, and offer the quiz itself once (after the first-run
 * "How this console works" dialog has been read, if that is showing).
 */
async function initLearning() {
  await ensureOnboardingOffer();
  syncQuizButtons();
  if (!onboardingOffer || state.session || onboardingFinished(mastery.get())) return;
  const dialog = $('onboarding');
  if (dialog.open) await new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
  // Someone may have started a lab, or opened another screen, meanwhile.
  if (state.session || !$('learnScreen').hidden || $('launcher').hidden || onboardingFinished(mastery.get())) return;
  showQuiz();
}

// --- in a session

/** What the running session shows of its lab's bundle: the graded questions. */
const learnSession = { id: '', form: null };

/** Removes the guide's Questions and everything behind them. */
function resetLearnSession() {
  learnSession.form?.destroy();
  learnSession.form = null;
  learnSession.id = '';
  $('questionsBody').replaceChildren();
}

/**
 * Builds, for a lab with graded fields, the guide's Questions. Called once the
 * session is running; a restart of the container reuses what is there so
 * unsaved answers are not lost.
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

  const questions = learn.fields.length > 0 && SAFE_FILE.test(learn.answers_file);
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
            throw new Error(plainError(err));
          }
        },
        write: async (text) => {
          const s = current();
          try {
            await api.writeFile(s.id, s.token, file, text);
          } catch (err) {
            throw new Error(plainError(err));
          }
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
 * Brief, Questions, Checks, Hints and Solution (session-layout.js
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
  answers: { answered: 0, total: 0 },
  checks: { passed: 0, count: 0 },
  /** 'checks', or 'answers' for a lab graded through its questions. */
  kind: 'checks',
  /** A checks run was started before the tabs existed: take the learner to its results once they do. */
  wantResults: false,
};

const GUIDE_PANEL = {
  brief: 'viewBrief',
  questions: 'viewQuestions',
  checks: 'viewChecks',
  hints: 'viewHints',
  solution: 'viewSolution',
};
const RAIL_ICON = {
  brief: 'i-list',
  questions: 'i-question',
  checks: 'i-checks',
  hints: 'i-bulb',
  solution: 'i-key',
};
const VISIBLE_BADGES = new Set(['questions', 'checks']);
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
    button.addEventListener('click', () => { showGuideTab(id, { reveal: true, focus: true }); syncTabUrl(id); });
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
  // A run started before the guide was built asked to be taken to its results: honour that
  // instead of landing on the first tab (Brief) with the results hidden behind it.
  const resultsTab = guide.wantResults && (tabs.includes('checks') ? 'checks' : tabs.includes('questions') ? 'questions' : null);
  if (resultsTab) guide.wantResults = false;
  showGuideTab(resultsTab || (tabs.includes(guide.tab) ? guide.tab : tabs[0]));
  updateBadges();
  renderDock();
  renderChecksButtons();
}

/** The tabs the lab has right now (the solution's presence changes while the lab runs). */
function currentGuideTabs() {
  return guideTabsFor({
    type: state.lab?.type,
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
    syncTabUrl('questions');
    learnSession.form?.focusFirstUnanswered();
    return;
  }
  runChecks();
}

async function startSession(slug, card) {
  const error = $('launchError');
  error.hidden = true;
  error.className = 'notice notice-bad';
  const buttons = document.querySelectorAll('.lab button, .lab-detail button, .resume button, #sgRejoin');
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
        const text = `Labs are busy right now. Trying again in ${seconds}s.`;
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
    return true;
  } catch (err) {
    // Next to the card that was clicked, not at the foot of a long list
    // where it scrolled out of sight and the click looked like it did nothing.
    error.className = 'notice notice-bad';
    if ($('launcher').hidden) {
      toast(`Could not start this lab. ${plainError(err)}`, 'bad');
      return false;
    }
    error.textContent = `Could not start this lab. ${plainError(err)}`;
    (card ?? $('launcher')).append(error);
    error.hidden = false;
    error.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return false;
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
  // A new session starts without the last one's Questions, and with the guide open again.
  resetLearnSession();
  resetGuide();
  hideLearnScreen();
  $('notFound').hidden = true;
  $('sessionGone').hidden = true;
  // The task, not an empty terminal: the guide opens on the brief, and the workspace on the files.
  showView('editor');
  showBoot('Getting your lab ready…');
  // The address names the lab; a session that came on screen by a button gets it now.
  leftSession(false);
  ensureSessionUrl(state.session.lab);
  announceRoute(`Lab session: ${labsBySlug.get(state.session.lab)?.title ?? state.session.lab}`);

  $('launcher').hidden = true;
  $('workspace').hidden = false;
  $('sessionBar').hidden = false;
  $('sessionActions').hidden = false;
  // A running lab can be left (it keeps running and the launcher offers Rejoin).
  $('btnBackToLabs').hidden = false;

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
    ['award.earned', 'good'],
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
  if (type === 'check.finished' || type === 'check.result') {
    refreshChecks();
    // A run can change a skill score, the XP and the path: Home and the profile ask again next time.
    progress.invalidate();
  }
  if (type === 'award.earned') progress.awardEarned(data);
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
  bootFailed('The lab stopped before it was ready.');
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
  setTerminalStatus('closed', 'Your lab was restarted, so the terminal is reconnecting');
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
  'award.earned': (d) => ['Award earned', typeof d.title === 'string' ? d.title : ''],
  // The payload is {reason}, not a duration: the time left is what the
  // header's own timer counts down to.
  'session.expiring': () => {
    const minutes = state.expiresAt ? Math.max(1, Math.ceil((state.expiresAt - Date.now()) / 60_000)) : 5;
    return ['Session ending soon', `About ${minutes} minute${minutes === 1 ? '' : 's'} left. Use End & save to keep your work.`];
  },
  'session.idle_warning': () => ['Still there?', 'This session ends soon if nothing happens.'],
  'container.restarted': () => ['Your lab restarted', 'Your workspace is being restored and the terminal will reconnect on its own.'],
  alert: () => ['Something went wrong', 'The lab ran into a problem. If it keeps happening, end the lab and start it again.'],
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
          ? 'This lab is no longer available. It may have ended or expired.'
          : lastError
            ? `The lab is not responding. ${plainError(lastError)}`
            : 'The lab is taking longer than expected to start. You can keep waiting, or go back and start it again.',
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

  bootStep('services', 'Opening your terminal…');
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
  // The guide's Questions are an extra: if they cannot be built the lab is unchanged.
  // The tabs are final once the brief and the bundle have been read (or failed).
  loadBrief().finally(() =>
    loadLearn()
      .catch((err) => console.error('The guide could not be built', err))
      .finally(() => {
        buildGuide();
        // A tab the address asked for wins over landing on the first service.
        applyPendingTab();
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
    // The start route may have rejoined another lab than the one asked for: the address names the one that is open.
    const route = router.current();
    if (route.name === 'session' && route.slug !== slug) setRoute('session', sessionParams(slug), { replace: true });
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
      body.querySelector('.error').textContent = `Could not load the brief. ${plainError(err)}`;
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
  if (type === 'session.state' && data?.state === 'starting') bootStep('container', 'Setting up your workspace…');
  if (type === 'service.health') {
    bootStep('workspace', `Starting ${data?.service ?? 'services'}…`);
    if (data?.service && data?.health) {
      setBootService(data.service, data.health, data.logs_tail);
      if (data.health !== 'healthy') state.bootUnhealthy ??= data.service;
    }
  }
  if (type === 'session.state' && data?.state === 'running') {
    bootStep('workspace');
    bootStep('services', 'Opening your terminal…');
  }
  if (type === 'alert' && data?.kind?.startsWith?.('start')) bootFailed('The lab could not finish starting.');
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
    message = `${state.bootUnhealthy} did not start properly. ${message}`;
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
  error: 'Something went wrong on our side and it had to stop.',
  evicted: 'It had to be closed on our side to free up room.',
};

function onEnded(reason) {
  setStatePill('ended');
  stopExpiryTimer();
  stopStreamFallback();
  hideIdleBanner();
  hideExpiryBanner();
  $('expiryTimer').textContent = 'ended';
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
    ? `This session has ended. ${END_REASONS[reason]} You can pick up from your last save or start the lab again.`
    : `This session has ended. ${END_REASONS[reason] ?? ''} The terminal and files ` +
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
        ? 'This lab can no longer be resumed. Start it again instead.'
        : `Could not resume. ${plainError(err)}`,
      'bad'
    );
  } finally {
    button.disabled = false;
    button.textContent = 'Resume my work';
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

/** An ended session leaves a dead workspace on screen; this is the way out. The address becomes the lab's page. */
function backToLabs() {
  const slug = state.session?.lab;
  leaveSessionScreen(true);
  // Replaced, not pushed: Back must not lead to the address of a session that is gone (it would start another).
  if (slug) router.navigate('lab', { slug }, { replace: true });
  else router.navigate('launcher', {}, { replace: true });
}

/**
 * The session screen taken down. `forget` ends the console's claim on the lab (the record is dropped);
 * without it the lab keeps running and its page offers Resume, which is what Back out of a lab does.
 * The page that follows is the caller's to show.
 */
function leaveSessionScreen(forget) {
  resetSolution();
  if (forget) forgetSession();
  else leftSession(true);
  state.session = null;
  state.dirty = false;
  pendingTab = null;
  teardownSession();
  $('resultCard').hidden = true;
  $('btnBackToLabs').hidden = true;
  $('sessionBar').hidden = true;
  $('sessionActions').hidden = true;
  $('workspace').hidden = true;
  $('expiryTimer').textContent = '';
  $('btnNewFile').disabled = false;
  syncQuizButtons();
  // Progress may have moved while the lab was open: the catalogue is read again, and the page redrawn.
  loadLabs();
}

/** Shows why the terminal is blank, instead of leaving a black rectangle. */
function setTerminalStatus(status, detail) {
  const panel = $('termStatus');
  if (status === 'open') {
    panel.hidden = true;
    return;
  }
  if (status === 'reconnecting') {
    $('termStatusText').textContent = 'Reconnecting to your terminal…';
    $('btnReconnectTerm').hidden = true;
    panel.hidden = false;
    return;
  }
  $('termStatusText').textContent = detail ? `${detail}.` : 'The terminal lost its connection. Press Reconnect to pick up where you left off.';
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

function resetBarStats() {
  setChecksStat(null);
  setHintsStat();
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

/**
 * Who the console thinks you are — the cookie's subject, asked of the Worker — and the opaque id a session's
 * address names you by. A route to a session waits for this (`meReady`).
 */
async function loadIdentity() {
  try {
    const { sub, user_id: userId } = await api.me();
    if (isOpaqueId(userId)) state.userId = userId;
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
    toast(`Could not tell the lab you are here. ${plainError(err)}`, 'bad');
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

function showExpiryBanner(left) {
  $('expiryCountdown').textContent = formatClock(left);
  $('expiryBanner').hidden = false;
  if (!endInFlight) $('btnEnd').textContent = 'End & save';
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
  if (status?.manifest_summary) {
    state.summary = status.manifest_summary;
    relabelServiceTabs();
    updateServicesSummary();
  }
  if (Array.isArray(status?.checks_history)) state.history = status.checks_history;
  if (status?.hints) {
    state.hints = status.hints;
    renderHints();
  }
  // An API that predates the solution omits it, which reads as "none".
  renderSolution(status?.solution);
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
  if (home) {
    showGuideTab(home);
    syncTabUrl(home);
  } else {
    guide.wantResults = true; // the guide is not built yet; applyGuideTabs takes the learner to the results once it is
  }
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
    panel.querySelector('.notice').textContent = `The checks could not run. ${plainError(err)}`;
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
    return { text: '', missing: false, unreadable: plainError(err) };
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
    setSolutionStatus('error', `Could not load the solution. ${plainError(err)}`);
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
    note.textContent = 'Could not read your copy of this file, so the solution is shown without a comparison.';
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
  progress.clearResultAwards();
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
    error.textContent = `Could not send your feedback. ${plainError(err)}`;
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
    list.querySelector('li').textContent = `Could not list files. ${plainError(err)}`;
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
    setEditorStatus(`The editor failed to load. ${plainError(err)}`, 'bad');
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
    setEditorStatus(`Could not open ${name}. ${plainError(err)}`, 'bad');
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
    showFileError(`Could not create ${clean}. ${plainError(err)}`);
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
    setEditorStatus(`Not saved. ${plainError(err)}`, 'bad');
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

/** What the lab calls a service's tab (its `label`), else the service's own name. */
function serviceLabel(name) {
  return state.summary?.services?.find((s) => s.name === name)?.label ?? name;
}

/** The tab's one-line explanation (the lab's `about`), else a plain "Open …". */
function serviceAbout(name) {
  return state.summary?.services?.find((s) => s.name === name)?.about ?? `Open ${serviceLabel(name)}`;
}

/** The summary can arrive after the tabs are drawn; give them the lab's own words once it has. */
function relabelServiceTabs() {
  for (const tab of $('serviceTabs').querySelectorAll('.tab')) {
    const name = tab.dataset.service;
    const text = tab.querySelector('.svc-label');
    if (text) text.textContent = serviceLabel(name);
    tab.title = serviceAbout(name);
  }
}

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
    tab.title = serviceAbout(name);
    tab.dataset.service = name;
    tab.dataset.health = 'unknown';
    const dot = document.createElement('span');
    dot.className = 'svc-dot';
    dot.dataset.health = 'unknown';
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'svc-label';
    text.textContent = serviceLabel(name);
    tab.append(dot, text);
    tab.addEventListener('click', () => {
      syncTabUrl('service', name);
      openService(name, tab);
    });
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
    label.textContent = serviceLabel(name);
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

/**
 * The status chip: one word on whether the lab is up, never which part is. It is a button only in a lab
 * whose task has the learner restart something (manifest `learner_restart`), where it opens the restart list.
 */
function updateServicesSummary() {
  const rows = [...$('serviceList').children].map((li) => li.querySelector('.svc-health')?.dataset.health ?? 'unknown');
  const healthy = rows.filter((h) => h === 'healthy').length;
  const worst = rows.includes('unhealthy') ? 'unhealthy' : rows.includes('restarting') ? 'restarting' : rows.length && healthy === rows.length ? 'healthy' : 'unknown';
  $('servicesDot').dataset.health = worst;
  $('servicesLabel').textContent = { healthy: 'Operational', unhealthy: 'Needs attention', restarting: 'Restarting…', unknown: 'Starting…' }[worst];
  const restartable = Boolean(state.summary?.learner_restart);
  const button = $('btnServices');
  button.dataset.restartable = restartable ? '1' : '0';
  button.setAttribute('aria-haspopup', restartable ? 'true' : 'false');
  if (restartable) button.setAttribute('aria-controls', 'servicesPop');
  else {
    button.removeAttribute('aria-controls');
    button.removeAttribute('aria-expanded');
    setServicesOpen(false);
  }
  $('servicesChevron').hidden = !restartable;
}

/** The Services popover: every service the lab runs, with its health and a Restart. */
function setServicesOpen(open) {
  $('servicesPop').hidden = !open;
  if ($('btnServices').dataset.restartable === '1') $('btnServices').setAttribute('aria-expanded', String(open));
}

function setServiceHealth(name, health) {
  const tab = [...$('serviceTabs').children].find((el) => el.dataset.service === name);
  if (tab) {
    tab.dataset.health = health;
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
    toast(`Could not restart ${name}. ${plainError(err)}`, 'bad');
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
  $('serviceDownName').textContent = serviceLabel(name);
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
  // The address follows the tab the learner chose (in place: Back does not step through tabs).
  if (tab.dataset.service) syncTabUrl('service', tab.dataset.service);
  else syncTabUrl(tab.dataset.view);
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

// The header's own links. Labs (and the brand) go home: the top of it when it is open, else home as
// a step forward in history. Paths is home too, with focus on the first path.
function goHome(event) {
  event.preventDefault();
  setMenu(false);
  if (state.session) return;
  if (!$('launcher').hidden && router.current().name === 'launcher') {
    $('launcher').scrollTo({ top: 0, behavior: 'auto' });
    window.scrollTo(0, 0);
    return;
  }
  router.navigate('launcher');
}
$('brandLink').addEventListener('click', goHome);
$('navLabs').addEventListener('click', goHome);
$('navPaths').addEventListener('click', (event) => {
  const first = $('labList').querySelector('.path-card-title a');
  if (state.session || $('launcher').hidden || router.current().name !== 'launcher' || !first) {
    // From another page: home, with focus on the first path once it is drawn.
    focusFirstPath = !state.session;
    return goHome(event);
  }
  event.preventDefault();
  setMenu(false);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('labList').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  first.focus({ preventScroll: true });
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
$('navProfile').addEventListener('click', () => setMenu(false));
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

// Saving progress used to report nothing to the learner either way: success was
// silent and failure went nowhere the learner would look.
$('btnSnapshot').addEventListener('click', async () => {
  const button = $('btnSnapshot');
  button.disabled = true;
  button.textContent = 'Saving…';
  button.setAttribute('aria-busy', 'true');
  try {
    await api.snapshot(state.session.id, state.session.token);
    toast(`Progress saved at ${new Date().toLocaleTimeString([], { hour12: false })}.`, 'good');
  } catch (err) {
    toast(`Could not save your progress. ${plainError(err)}`, 'bad');
  } finally {
    button.textContent = 'Save progress';
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
    addNotice('bad', 'Could not end cleanly', plainError(err));
    toast(`The lab may not have ended cleanly. ${plainError(err)}`, 'bad');
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

$('btnBackToLabs').addEventListener('click', () => {
  if ($('statePill').dataset.state === 'ended') backToLabs();
  // The lab keeps running: its page is where the learner left from, and offers Resume.
  else if (state.session) router.navigate('lab', { slug: state.session.lab });
});
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
  tab.addEventListener('click', () => { showGuideTab(tab.dataset.guideTab); syncTabUrl(tab.dataset.guideTab); });
}
wireTablist($('guideTabs'), () => [...$('guideTabs').querySelectorAll('.tab:not([hidden])')], (tab) => {
  showGuideTab(tab.dataset.guideTab);
  syncTabUrl(tab.dataset.guideTab);
});

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
$('btnServices').addEventListener('click', () => {
  if ($('btnServices').dataset.restartable === '1') setServicesOpen($('servicesPop').hidden);
});
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
  // The session's address is not a page of the launcher: home is drawn under the notice.
  if (launcherModel && !catalogueFailed) renderBrowse({ name: 'launcher' }, { quiet: true });
  parkLaunchError();
  const error = $('launchError');
  error.className = 'notice notice-warn';
  error.textContent = 'Signed out — sign in to return to your running lab. ';
  const link = document.createElement('a');
  // A full page load of this very address: the Worker answers it with the sign-in form, and signing in comes back here.
  link.href = location.pathname + location.search;
  link.setAttribute('data-native', '');
  link.textContent = 'Sign in';
  error.append(link);
  error.hidden = false;
  syncQuizButtons();
}

meReady = loadIdentity();
$('saveShortcut').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S';
router.onRoute((route) => applyRoute(route));
router.start();
installCodeCopy();
boot();

/**
 * On load: the catalogue (every screen that names a lab needs it), then the screen the address
 * names. The bare "/" first tries the session this browser was last in, as it always did.
 */
async function boot() {
  const route = router.current();
  // An address that is not the launcher's should not flash the launcher while the catalogue loads.
  if (!BROWSE_ROUTES.has(route.name)) showTransient('Opening…');
  try {
    labsReady = loadLabs();
    await Promise.all([labsReady, meReady]);
    if (!(await resumeOnLoad(route))) await applyRoute(route, { initial: true });
  } catch (err) {
    console.error('The console could not start', err);
  } finally {
    // Says the console has finished deciding which screen to show.
    // Anything that races that decision — a test, or a person clicking
    // straight away — can wait for it.
    document.body.dataset.booted = '1';
    // Only over the picker: someone already inside a lab, or reading one, has found their way.
    if (!state.session && !$('launcher').hidden) maybeShowOnboarding();
    initLearning();
  }
}

/**
 * The bare "/" walks back into the lab this browser was in (its address becomes the lab's, one step
 * on from "/", so Back is the launcher). A session that has ended (or whose token has expired) falls
 * back to the picker rather than leaving a dead workspace on screen; a learner who just left the lab
 * with Back (this tab remembers) stays on the launcher, where Rejoin is one press; a phone does not
 * walk back into a lab at all.
 */
async function resumeOnLoad(route) {
  if (route.name !== 'launcher' || leftSession()) return false;
  const saved = rememberedSession();
  if (!saved?.id || !saved?.token) return false;
  // A phone cannot run a lab, so it does not walk back into one: the launcher shows it
  // as the lab in progress, and Rejoin explains. The record stays for the computer.
  if (isPhoneLike(readDevice())) return false;
  try {
    // No recovery here: a refused token means the remembered session is
    // gone, and rejoining to find out could start a new container.
    const status = await api.status(saved.id, saved.token, { recover: false });
    if (status.meta.state === 'ended') {
      forgetSession();
      return false;
    }
  } catch {
    forgetSession();
    return false;
  }
  state.session = saved;
  enterSession();
  return true;
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
