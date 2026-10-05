/**
 * Where the learner's progress screens meet the console: the profile page, the "Your progress" and "Your path"
 * bands on Home, the page at /paths/mine, and the moment an award is earned.
 *
 * app.js gives this what only it knows (the catalogue, which lab is running, how a lab is started, the quiz
 * result) and asks it for the pieces to draw. The learner is always the signed-in one: the Worker names them, so
 * nothing here sends a user. A failed call on Home is silent (the band is simply not shown); on the profile and
 * path pages it is said in plain words, with a way to try again.
 */
import { createLiveStore } from './live-store.js';
import { createAwardToasts, createResultAwards } from './awards.js';
import { gainBetween, progressBand, profilePage, standingOf, startingParam } from './profile.js';
import { myPathPage, normalizePath, pathBand, pathInvite } from './path-view.js';
import { pathInputsBody, saveGoal as rememberGoal } from './goal-fields.js';
import { skillById } from './skills.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Keeps `paint(state)` in step with a store for as long as `root` is on the page: it draws at once from what the
 * store already holds, loads when that is missing or old, and redraws when the answer changes. It lets go when
 * `root` has been taken off the page (another screen replaced it).
 */
function bind(store, root, paint) {
  let last = null;
  const draw = (state) => {
    // A refresh that came back with the same answer changes nothing on screen.
    const key = `${state.status === 'error' && !state.data ? 'error' : state.data ? 'data' : state.status}:${JSON.stringify(state.data)}`;
    if (key === last) return;
    last = key;
    paint(state);
  };
  draw(store.get());
  const off = store.subscribe((state) => {
    if (!root.isConnected) return off();
    draw(state);
  });
  // After the caller has put `root` on the page: loading starts changes the state, and a root that is not
  // attached yet would be taken for one that was removed.
  queueMicrotask(() => store.ensure());
  return root;
}

const SEEN_KEY = 'opalixAwardsSeen';

/** The awards this browser has already celebrated (kept in localStorage; blocked storage means this tab only). */
function seenAwards(storage) {
  let ids = [];
  try {
    const raw = JSON.parse(storage?.getItem(SEEN_KEY) ?? '[]');
    if (Array.isArray(raw)) ids = raw.filter((x) => typeof x === 'string').slice(-200);
  } catch {
    /* start empty */
  }
  const set = new Set(ids);
  return {
    has: (id) => set.has(String(id)),
    add(id) {
      set.add(String(id));
      try {
        storage?.setItem(SEEN_KEY, JSON.stringify([...set].slice(-200)));
      } catch {
        /* private mode */
      }
    },
  };
}

export function createProgressHub({
  api,
  plainError,
  getLevels,
  hasQuiz = () => false,
  isRunning = () => false,
  labKnown = () => true,
  plansHref = () => null,
  startLab = () => {},
  reducedMotion = () => false,
  resultAwardsHost = () => document.getElementById('resultAwards'),
}) {
  const levels = () => {
    try {
      return getLevels() ?? {};
    } catch {
      return {};
    }
  };
  /** A save that is still on its way, so a read of the path waits for it rather than finding no goal. */
  let saving = null;

  const profileFull = createLiveStore(() => api.profile({ starting: startingParam(levels()) }));
  const profileCompact = createLiveStore(() => api.profile({ compact: true, starting: startingParam(levels()) }));
  const pathStore = createLiveStore(async () => {
    await saving?.catch(() => {});
    return api.path();
  }, { ttl: 60_000 });

  const toasts = createAwardToasts({ reducedMotion });
  let storage = null;
  try {
    storage = globalThis.localStorage;
  } catch {
    /* blocked storage: celebrated awards are remembered for this tab only */
  }
  const seen = seenAwards(storage);
  let resultAwards = null;
  const result = () => {
    const host = resultAwardsHost();
    if (!host) return null;
    resultAwards ??= createResultAwards(host);
    return resultAwards;
  };

  /** The compact profile's `next_lab`: the lab object or null once it has answered, undefined until then. */
  const nextOf = (state) => (state.data && typeof state.data === 'object' && 'next_lab' in state.data ? (state.data.next_lab ?? null) : undefined);

  /** The learner's standing when the lab on screen started (a promise), to say what finishing it earned. */
  let startedWith = null;

  /** Something about the learner's progress changed (a check ran, an award came in): ask again next time. */
  function invalidate() {
    profileFull.invalidate();
    profileCompact.invalidate();
    pathStore.invalidate();
  }

  /** Saves the quiz result and the goal, and puts the path built from them in the cache. */
  async function savePathInputs(goal, from = levels()) {
    const body = pathInputsBody({ levels: from, goal });
    rememberGoal(goal);
    const call = api.savePathInputs(body);
    saving = call;
    try {
      const path = await call;
      pathStore.set(path);
      return path;
    } finally {
      if (saving === call) saving = null;
    }
  }

  // ------------------------------------------------------------ Home

  /** The bands above the path cards on Home. Empty slots stay hidden, so a learner with nothing yet sees nothing. */
  function homeBands() {
    const wrap = el('div', 'home-bands');
    const pathSlot = el('div', 'home-slot');
    const progressSlot = el('div', 'home-slot');
    pathSlot.hidden = true;
    progressSlot.hidden = true;
    wrap.append(pathSlot, progressSlot);

    const deps = { isRunning, labKnown, onStart: startLab };
    bind(pathStore, wrap, (state) => {
      let band = state.data ? pathBand(state.data, deps) : null;
      // A learner who took the quiz before paths existed has no goal yet: offer to make one.
      if (!band && !state.data && state.status === 'error' && state.error?.status === 404 && hasQuiz()) band = pathInvite();
      pathSlot.replaceChildren(...(band ? [band] : []));
      pathSlot.hidden = !band;
    });
    bind(profileCompact, wrap, (state) => {
      const band = state.data && typeof state.data === 'object' ? progressBand(state.data) : null;
      progressSlot.replaceChildren(...(band ? [band] : []));
      progressSlot.hidden = !band;
    });
    return wrap;
  }

  // ------------------------------------------------------------ the profile page

  function profileScreen() {
    const root = el('div', 'profile');
    const title = el('h1', 'profile-title', 'Your profile');
    title.id = 'profileTitle';
    title.tabIndex = -1;
    const body = el('div', 'profile-body');
    root.append(title, el('p', 'profile-lede', 'Your level, your skill scores and the awards you have earned.'), body);
    bind(profileFull, root, (state) => {
      body.replaceChildren(
        profilePage({
          state,
          startingLevels: levels(),
          errorText: state.error ? plainError(state.error) : '',
          retry: () => profileFull.ensure({ force: true }),
        })
      );
    });
    return root;
  }

  // ------------------------------------------------------------ the path page

  let formOpen = false;

  function pathScreen() {
    const root = el('div', 'mypath');
    const title = el('h1', 'mypath-title', 'Your path');
    title.id = 'mypathTitle';
    title.tabIndex = -1;
    const live = el('p', 'sr-only mypath-live');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    const body = el('div', 'mypath-slot');
    root.append(title, el('p', 'profile-lede', 'The labs picked for you, in the order that suits you, from your quiz answers, your goal and the labs you have done.'), live, body);

    const say = (text) => {
      live.textContent = '';
      setTimeout(() => (live.textContent = text), 30);
    };
    const deps = {
      isRunning,
      labKnown,
      plansHref,
      onStart: startLab,
      errorText: plainError,
      retry: () => pathStore.ensure({ force: true }),
      say,
      formOpen: () => formOpen,
      setFormOpen: (open) => (formOpen = open),
      recompute: async () => {
        const path = await api.recomputePath({ force: true });
        pathStore.set(path);
      },
      saveGoal: async (goal) => {
        const was = formOpen;
        formOpen = false;
        try {
          await savePathInputs(goal);
          say('Your goal is saved and your path is updated.');
        } catch (err) {
          formOpen = was;
          throw err;
        }
      },
    };
    bind(pathStore, root, (state) => {
      body.replaceChildren(myPathPage({ state, deps }));
    });
    return root;
  }

  return {
    homeBands,
    profileScreen,
    pathScreen,
    savePathInputs,
    invalidate,
    /** The next path read comes from the server (a lab was finished, the plan changed). */
    pathStore,
    /** The profile (full and compact) is asked again next time: the quiz result it starts from changed. */
    profileStore: {
      invalidate() {
        profileFull.invalidate();
        profileCompact.invalidate();
      },
    },
    /** An `award.earned {id, title, tier}` from the lab's event stream. */
    awardEarned(data) {
      if (!data || typeof data.title !== 'string') return;
      // A lab's event stream replays its last events to a console that reconnects or reloads: an award that was
      // already celebrated in this browser is not celebrated again (it still shows on the result card).
      if (!seen.has(data.id)) {
        seen.add(data.id);
        toasts.show(data);
      }
      result()?.add(data);
      invalidate();
    },
    /** A lab session begins: remember where the learner stands (reading the profile afresh if it is out of date). */
    labStarted() {
      startedWith = profileFull.ensure().then(() => standingOf(profileFull.get().data));
      startedWith.catch(() => {});
    },
    /**
     * A lab was completed: read the profile again and say what it earned, for the result card:
     * `{ gain: { xp, skill: { title, from, to } | null } | null, next }`. `area` is the skill the lab feeds;
     * `next` is the profile's `next_lab` (null when there is none, or it could not be read).
     */
    async finishedLab(area) {
      const before = await (startedWith ?? Promise.resolve(null)).catch(() => null);
      profileFull.invalidate();
      profileCompact.invalidate();
      await Promise.all([profileFull.ensure({ force: true }), profileCompact.ensure({ force: true })]);
      const after = standingOf(profileFull.get().data);
      return { gain: gainBetween(before, after, area, (id) => skillById(id)?.title ?? id), next: nextOf(profileCompact.get()) ?? null };
    },
    /** A new session starts with no awards on its result card. */
    clearResultAwards() {
      result()?.clear();
    },
    hasPath: () => Boolean(normalizePath(pathStore.get().data)),
    /**
     * The one next lab (GET /api/profile `next_lab`): { slug, title, skill, path, module }, null when there is
     * none, undefined while the profile has not answered (asking it is started here).
     */
    nextLab() {
      queueMicrotask(() => profileCompact.ensure());
      return nextOf(profileCompact.get());
    },
    /** fn() each time the next lab the profile names changes (its first answer included). Returns an unsubscribe. */
    onNextLab(fn) {
      let last = String(JSON.stringify(nextOf(profileCompact.get())));
      return profileCompact.subscribe((state) => {
        const key = String(JSON.stringify(nextOf(state)));
        if (key === last) return;
        last = key;
        fn(nextOf(state));
      });
    },
  };
}
