/**
 * Saving the learner's place in "Before you begin" and in a warm-up on the server, so closing the tab, or
 * coming back on another browser or device, does not lose it (docs/learning-content.md, "Saving progress").
 *
 * The flow already keeps its visit in sessionStorage (`createFlowStore` in learn-flow.js): that stays the
 * instant local copy, which a refresh of the same tab reads. `createProgressStore` wraps it and also sends
 * the visit to the API (PUT /api/learn-progress/<slug>):
 *   - the moment the step on screen changes,
 *   - one second (`delay`) after anything else changes (an answer, a game, a lesson page), debounced,
 *   - and as the page is hidden or closed (`pagehide`, `visibilitychange`), with `keepalive`.
 * Nothing is sent until there is something worth coming back to (past the first step, an answer, a game or a
 * lesson read). The calls go one after another, so a "forget it" is never overtaken by an earlier save.
 *
 * The record on the server is
 *   { version, state: { v: 1, steps, at, answers, games?, started_at?, lessons?, label } }
 * where `version` is the learn bundle's (another version is another plan), `at` the step on screen (0-based),
 * `lessons` the lessons pager's memory of this lab and `label` the step's name (so the lab's page can say
 * "Step 3 of 7: Lessons" without the bundle).
 *
 * Pure apart from the storage, the timers and the listeners it is handed (or finds on globalThis).
 */

import { createFlowStore, restoreSteps, stepLabel } from './learn-flow.js';

/**
 * Where the lessons pager keeps where the learner was, per lab: { [slug]: { at, pages, read } }. The same key as
 * learn-lessons.js PAGES_KEY (a unit test pins them together); not imported, so this module stays free of the DOM.
 */
export const LESSON_PAGES_KEY = 'opalix.lessonPages';

/** How long after a change (that is not a step change) the visit is sent. */
export const SAVE_DELAY_MS = 1000;

/** How long a progress read is trusted before it is asked again. */
export const PROGRESS_TTL_MS = 30_000;

const isRecord = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The lessons pager's memory of one lab, read and written as it stands. Best effort: blocked storage reads as none. */
export function lessonPagesFor(slug, storage) {
  const backend = () => {
    try {
      return storage !== undefined ? storage : (globalThis.localStorage ?? null);
    } catch {
      return null;
    }
  };
  const readAll = () => {
    try {
      const all = JSON.parse(backend()?.getItem(LESSON_PAGES_KEY) || '{}');
      return isRecord(all) ? all : {};
    } catch {
      return {};
    }
  };
  return {
    load() {
      const mine = readAll()[slug];
      return isRecord(mine) ? mine : null;
    },
    save(value) {
      try {
        const all = readAll();
        all[slug] = value;
        backend()?.setItem(LESSON_PAGES_KEY, JSON.stringify(all));
      } catch {
        /* the pager opens on the first page instead */
      }
    },
  };
}

/** Whether a saved state is worth a "Continue where you left off": past the first step, or something done on it. */
export function worthResuming(state) {
  if (!isRecord(state) || !Array.isArray(state.steps) || state.steps.length === 0) return false;
  if (Number.isInteger(state.at) && state.at > 0) return true;
  if (isRecord(state.answers) && Object.keys(state.answers).length > 0) return true;
  if (isRecord(state.games) && Object.keys(state.games).length > 0) return true;
  return Array.isArray(state.lessons?.read) && state.lessons.read.length > 0;
}

/** "Step 3 of 7: Lessons, part 1 of 2" (the name left out when there is none). */
export function progressSummary({ at, total, label }) {
  return `Step ${at + 1} of ${total}${label ? `: ${label}` : ''}`;
}

/**
 * Where saved progress continues in this bundle: { state, at, total, label }, or null when there is
 * nothing to continue (no progress, not worth it), or it no longer fits: another bundle version, or
 * steps that name questions, concepts or games the bundle does not have. Null means start over; it never throws.
 *   entry     { version, learn } as GET /api/learn/:slug gives it
 *   progress  { version, state } as GET /api/learn-progress/:slug gives it (or null)
 */
export function resumePoint(entry, progress) {
  try {
    if (!entry?.learn || !isRecord(progress) || !isRecord(progress.state)) return null;
    if (progress.version !== entry.version || progress.state.v !== 1) return null;
    if (!worthResuming(progress.state)) return null;
    const steps = restoreSteps(entry.learn, progress.state.steps);
    // A step dropped on the way (a game or a closing the bundle no longer has) moves every later one: start over.
    if (!steps || steps.length !== progress.state.steps.length) return null;
    const at = Number.isInteger(progress.state.at) ? Math.min(Math.max(progress.state.at, 0), steps.length - 1) : 0;
    return { state: progress.state, at, total: steps.length, label: stepLabel(steps[at], entry.learn) };
  } catch {
    return null;
  }
}

/**
 * The same for a page that has the catalogue entry and not the bundle (the lab's own page): the versions must
 * match and the state be worth continuing; the name is the one saved with it. { at, total, label } or null.
 */
export function pagePoint(lab, progress) {
  if (!lab || !isRecord(progress) || !isRecord(progress.state)) return null;
  if (!progress.version || progress.version !== lab.version || !worthResuming(progress.state)) return null;
  const total = progress.state.steps.length;
  const at = Number.isInteger(progress.state.at) ? Math.min(Math.max(progress.state.at, 0), total - 1) : 0;
  return { at, total, label: typeof progress.state.label === 'string' ? progress.state.label : '' };
}

/**
 * What a lab's page does with the saved progress it read (`progress`, `{ version, state, updated_at? }` or null, and
 * `point`, pagePoint's reading of it) for a lab that is `done` or not, done when `doneAt` (ms, the lab's last run):
 *   'resume'      not done: "You left off at ...", with Continue where you left off and Start over
 *   'second-run'  done, and a second run is under way: past its first step and saved after the lab was done (or
 *                 with no time to compare): one quiet "Continue your second run" link
 *   'forget'      done, and what is saved is left over (the first step of a run opened again, or older than the
 *                 finish): nothing is shown, and it is deleted without a word
 *   'none'        nothing to show (no progress, or progress that no longer fits the lab, which Start forgets)
 */
export function labPlaceView({ done = false, progress = null, point = null, doneAt = null } = {}) {
  if (!isRecord(progress)) return 'none';
  if (!done) return point ? 'resume' : 'none';
  if (!point || point.at < 1) return 'forget';
  const saved = progress.updated_at;
  if (Number.isFinite(saved) && Number.isFinite(doneAt) && saved <= doneAt) return 'forget';
  return 'second-run';
}

/**
 * The calls to the API's learn progress, with a short memory: what was last read or sent for a lab is
 * answered from it for `ttl` ms, so the lab's page shows the place the flow saved a moment ago without
 * waiting on that save. `api` has learnProgress, saveLearnProgress and clearLearnProgress (api.js).
 *   get(slug, { fresh })  { version, state, updated_at? } or null; a failed read is null (and not remembered); two
 *                         reads at once share one call, and a save or clear made while it was out wins over its answer
 *   save(slug, body, { keepalive })   resolves true or false, never throws; remembered at once, and forgotten
 *                                     again when the call fails (the server does not have it)
 *   clear(slug, { keepalive })        likewise
 *   peek(slug)            the remembered value (undefined when nothing is)
 */
export function createProgressClient(api, { ttl = PROGRESS_TTL_MS, now = () => Date.now() } = {}) {
  const memory = new Map();
  const remember = (slug, value) => memory.set(slug, { at: now(), value });
  /** Remembers `value` at once (a page reading it next sees it), and puts back what was there when the call fails. */
  const change = async (slug, value, call) => {
    const before = memory.get(slug);
    remember(slug, value);
    const mine = memory.get(slug);
    try {
      await call();
      return true;
    } catch {
      if (memory.get(slug) === mine) {
        if (before) memory.set(slug, before);
        else memory.delete(slug);
      }
      return false;
    }
  };
  /** The reads under way, by slug. */
  const reading = new Map();
  const read = async (slug) => {
    const before = memory.get(slug);
    try {
      const body = await api.learnProgress(slug);
      // Saved or forgotten here while the call was out: that is newer than what the server answered.
      const since = memory.get(slug);
      if (since !== before && since) return since.value;
      const p = body?.progress;
      // `updated_at` (ms) says when it was saved: the lab's page weighs it against when the lab was done.
      const value = isRecord(p) ? { version: p.version, state: p.state, ...(Number.isFinite(p.updated_at) ? { updated_at: p.updated_at } : {}) } : null;
      remember(slug, value);
      return value;
    } catch {
      return null;
    }
  };
  return {
    get(slug, { fresh = false } = {}) {
      const hit = memory.get(slug);
      if (!fresh && hit && now() - hit.at < ttl) return Promise.resolve(hit.value);
      // Two readers at once (a page drawn twice) share one call, so neither answer lands after the other's change.
      if (!fresh && reading.has(slug)) return reading.get(slug);
      const call = read(slug).finally(() => {
        if (reading.get(slug) === call) reading.delete(slug);
      });
      reading.set(slug, call);
      return call;
    },
    save(slug, body, opts = {}) {
      return change(slug, { version: body.version, state: body.state }, () => api.saveLearnProgress(slug, body, opts));
    },
    clear(slug, opts = {}) {
      return change(slug, null, () => api.clearLearnProgress(slug, opts));
    },
    peek(slug) {
      return memory.get(slug)?.value;
    },
  };
}

/**
 * The flow store of one visit (runBeforeYouBegin's `flowStore`), local and on the server.
 *   slug, version   the lab and its learn bundle version
 *   learn           the bundle, for the name of the step on screen
 *   storage         the local copy's storage (default sessionStorage), as createFlowStore
 *   pagesStorage    where the lessons pager keeps its memory (default localStorage)
 *   remote          a createProgressClient (omitted: local only, as before)
 *   done            true for a lab already done (opened again): a visit of it is not worth coming back to until it
 *                   is past its first step, so opening a finished lab and leaving it saves nothing
 *   delay           the debounce, ms
 *   timers          { setTimeout, clearTimeout } (default globalThis)
 *   events          where `pagehide` and `visibilitychange` are listened for (default globalThis and document)
 *
 * load / save(steps, answers, { games, started_at, at }) / clear() are createFlowStore's, save also taking the
 * step on screen. More:
 *   flush({ keepalive })  sends what changed now
 *   seed(state)           makes a saved state (from the server) this visit's: the local copy and the lesson pages
 *   finish()              the visit is done (the lab started, the warm-up finished): forgets it here and on the
 *                         server, and sends nothing more
 * clear() ends the visit without forgetting it (Back to labs, leaving the page): what changed is sent first.
 */
export function createProgressStore({ slug, version = '', learn, storage, pagesStorage, remote, done = false, delay = SAVE_DELAY_MS, timers = globalThis, events } = {}) {
  const local = createFlowStore({ slug, version, storage });
  // A finished lab opened again brings its lessons pager's memory (and so "lessons read") with it: only a step on
  // makes that visit one to come back to.
  const worth = (state) => worthResuming(state) && (!done || (Number.isInteger(state.at) && state.at > 0));
  const pages = lessonPagesFor(slug, pagesStorage);
  let last = null; // { steps, answers, games, started_at, at }
  let sentJson = null;
  let sentAt = null;
  let timer = null;
  let ended = false;
  let detached = false;
  let queue = Promise.resolve();
  const enqueue = (op) => {
    queue = queue.then(op, op);
    return queue;
  };

  const record = () => {
    if (!last) return null;
    const lessons = pages.load();
    const at = Number.isInteger(last.at) ? Math.min(Math.max(last.at, 0), last.steps.length - 1) : 0;
    let label = '';
    try {
      label = learn ? stepLabel(last.steps[at], learn) : '';
    } catch {
      /* no name: the summary leaves it out */
    }
    const state = {
      v: 1,
      steps: last.steps,
      at,
      answers: last.answers ?? {},
      ...(last.games ? { games: last.games } : {}),
      ...(last.started_at ? { started_at: last.started_at } : {}),
      ...(lessons ? { lessons } : {}),
      ...(label ? { label: String(label).slice(0, 200) } : {}),
    };
    return { version, state };
  };

  const cancel = () => {
    if (timer !== null) {
      try {
        timers.clearTimeout(timer);
      } catch {
        /* nothing pending */
      }
      timer = null;
    }
  };

  /**
   * Sends the visit when it changed since the last send and is worth keeping. `keepalive` lets it outlive the
   * page; `now` sends it at once, past any call still under way (the page is going, and cannot wait its turn).
   */
  const send = ({ keepalive = false, now = false } = {}) => {
    cancel();
    if (ended || !remote || !version) return;
    const body = record();
    if (!body || !worth(body.state)) return;
    const json = JSON.stringify(body);
    if (json === sentJson) return;
    sentJson = json;
    sentAt = body.state.at;
    const opts = keepalive ? { keepalive: true } : {};
    if (now) remote.save(slug, body, opts);
    else enqueue(() => remote.save(slug, body, opts));
  };

  const win = events?.window ?? globalThis;
  const doc = events?.document ?? globalThis.document;
  const onHide = () => {
    if (doc?.visibilityState === 'hidden') send({ keepalive: true, now: true });
  };
  const onPageHide = () => send({ keepalive: true, now: true });
  try {
    win?.addEventListener?.('pagehide', onPageHide);
    doc?.addEventListener?.('visibilitychange', onHide);
  } catch {
    /* no events: the debounce and the step changes still send */
  }
  const detach = () => {
    if (detached) return;
    detached = true;
    try {
      win?.removeEventListener?.('pagehide', onPageHide);
      doc?.removeEventListener?.('visibilitychange', onHide);
    } catch {
      /* already gone */
    }
  };

  return {
    load: () => local.load(),
    save(steps, answers, { games, started_at, at } = {}) {
      if (ended) return;
      local.save(steps, answers, { games, started_at });
      last = { steps, answers, games, started_at, at: Number.isInteger(at) ? at : (last?.at ?? 0) };
      if (!remote) return;
      // A new step goes at once; anything else (a save that names no step included) waits for the learner to pause.
      if (Number.isInteger(at) && at !== sentAt && worth(record()?.state)) return send();
      cancel();
      timer = timers.setTimeout(() => {
        timer = null;
        send();
      }, delay);
    },
    flush: (opts) => send(opts),
    seed(state) {
      if (!isRecord(state) || !Array.isArray(state.steps)) return;
      const answers = isRecord(state.answers) ? state.answers : {};
      const games = isRecord(state.games) ? state.games : undefined;
      local.save(state.steps, answers, { games, started_at: state.started_at });
      if (isRecord(state.lessons)) pages.save(state.lessons);
      last = { steps: state.steps, answers, games, started_at: state.started_at, at: Number.isInteger(state.at) ? state.at : 0 };
      // What the server has already: nothing to send until something changes.
      const body = record();
      sentJson = body ? JSON.stringify(body) : null;
      sentAt = last.at;
    },
    clear() {
      if (!ended) send({ keepalive: true });
      detach();
      local.clear();
    },
    finish() {
      cancel();
      ended = true;
      detach();
      local.clear();
      if (remote) enqueue(() => remote.clear(slug));
    },
    /** Resolves once every call sent so far is over (tests, and a caller that must wait). */
    settled: () => queue,
  };
}
