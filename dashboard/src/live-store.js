/**
 * A small cache for something the console asks the server for and shows on more than one screen (the
 * learner's profile, their path). No DOM.
 *
 *   const store = createLiveStore(() => api.profile(...), { ttl: 30_000 });
 *   store.get()          { status, data, error, at }
 *   store.ensure()       loads when there is nothing yet, the answer is older than `ttl`, or it was
 *                        invalidated; otherwise resolves at once. `{ force: true }` always loads.
 *   store.invalidate()   the next ensure() loads again (what is shown stays until the answer is in)
 *   store.set(data)      puts an answer in (a call that already returned one, e.g. saving the goal)
 *   store.subscribe(fn)  fn(state) on every change; returns an unsubscribe
 *
 * A screen draws from `get()` at once (so redrawing it never flashes) and again on each change. A load
 * that fails keeps the last good answer, and says so in `error`. Calls that overlap share one request, and
 * an answer to a request that was overtaken by `set` or `invalidate` is dropped rather than shown.
 */

export function createLiveStore(load, { ttl = 30_000, now = () => Date.now() } = {}) {
  let state = { status: 'idle', data: null, error: null, at: 0 };
  let stale = true;
  let inflight = null;
  let generation = 0;
  const listeners = new Set();

  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch {
        /* one broken screen must not stop the others */
      }
    }
  };
  const change = (next) => {
    state = { ...state, ...next };
    emit();
  };

  async function run() {
    const mine = generation;
    change({ status: 'loading', error: null });
    try {
      const data = await load();
      if (mine !== generation) return state;
      stale = false;
      change({ status: 'ready', data, error: null, at: now() });
    } catch (error) {
      if (mine !== generation) return state;
      // Keep what was last known: a failed refresh must not blank a page that was fine.
      change({ status: 'error', error, at: now() });
    }
    return state;
  }

  return {
    get: () => state,
    ensure({ force = false } = {}) {
      if (inflight) return inflight;
      const fresh = state.status === 'ready' && !stale && now() - state.at < ttl;
      if (fresh && !force) return Promise.resolve(state);
      const mine = run().finally(() => {
        if (inflight === mine) inflight = null;
      });
      inflight = mine;
      return mine;
    },
    invalidate() {
      stale = true;
      generation++;
      inflight = null;
    },
    set(data) {
      generation++;
      inflight = null;
      stale = false;
      change({ status: 'ready', data, error: null, at: now() });
    },
    /** Forgets everything (a different learner, or a 404 that must be asked about again). */
    reset() {
      generation++;
      inflight = null;
      stale = true;
      change({ status: 'idle', data: null, error: null, at: 0 });
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
