/**
 * A page opened before a deploy can ask for a piece of the console (the editor, a language grammar) that the
 * new build no longer serves: those files are named by their content, and the old names go away.
 * The browser reports it as a failed dynamic import. The cure is a reload, which is safe in a lab because the
 * session's address restores it; this module decides whether to do it for the learner or to ask.
 */

const FLAG = 'opalix.staleReload';
/** A second stale failure inside this window means the reload did not help: stop reloading and say so. */
const WINDOW_MS = 60_000;

/** Whether `err` is a browser's way of saying "that module file is not there (any more)". */
export function isStaleChunkError(err) {
  const text = `${err?.name ?? ''} ${err?.message ?? err ?? ''}`;
  return /ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk .* failed/i.test(text);
}

/**
 * Reloads the page once when it is safe (`canReload`: nothing unsaved) and it has not just been done.
 * Returns true when a reload was started, false when the caller should show the "reload" prompt instead.
 */
export function recoverFromStaleBuild({ canReload, now = Date.now(), reload = () => location.reload(), storage } = {}) {
  if (!canReload) return false;
  let store = storage;
  try {
    store ??= window.sessionStorage;
    const last = Number(store.getItem(FLAG) ?? 0);
    if (last && now - last < WINDOW_MS) return false;
    store.setItem(FLAG, String(now));
  } catch {
    // No storage: reloading could loop, so do not.
    return false;
  }
  reload();
  return true;
}
