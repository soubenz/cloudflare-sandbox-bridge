/**
 * The workspace files the tree shows, read ahead of a click, so opening one is instant.
 *
 * Reading a file is a round trip into the lab's machine (measured at ~1 s end to end), and the learner's
 * click used to wait for it every time. Once the tree is drawn, `prefetch` reads the text files it lists in
 * ONE batch call (POST /sessions/:id/files/read); `lookup` then answers an open from memory, and the console
 * still re-reads the file in the background (`revalidate`) and shows the new text only when it changed and
 * the learner has nothing unsaved (app.js decides the second part; this module knows nothing of the editor).
 *
 * What keeps it honest:
 *   - Entries belong to one session (`scope()`): a different session starts from empty.
 *   - A save or a new file `set`s the entry to what was written; `drop` forgets one.
 *   - Anything typed in the terminal (a Run button types there too) can change files, so it `markStale`s
 *     everything: the next tree refresh reads those again, and an open still shows the old text at once and
 *     revalidates it.
 *   - Each path carries a version, bumped by `set` and `drop`. A read that started before a newer write
 *     lands is thrown away, so a slow prefetch or revalidation can never put back the text a save replaced.
 *
 * Only UTF-8 text is kept; a binary file, a big one, or one the batch refused opens the old way.
 */

/** The API's own limit per batch. */
export const PREFETCH_MAX_FILES = 30;
/** Read ahead only files this small: the batch takes up to 256 KB, but a big file is rarely the one opened. */
export const PREFETCH_MAX_BYTES = 128 * 1024;

const BINARY =
  /\.(png|jpe?g|gif|webp|ico|bmp|svgz|pdf|zip|gz|tgz|tar|bz2|xz|7z|whl|egg|so|o|a|pyc|pyo|class|jar|db|sqlite3?|parquet|woff2?|ttf|otf|eot|mp3|mp4|wav|ogg|webm|mov|bin|exe|dll|wasm)$/i;

/** A tree row worth reading ahead: a small file that is not obviously binary. */
export function prefetchable(row) {
  return Boolean(row) && !row.isDirectory && typeof row.path === 'string' && (row.size ?? 0) <= PREFETCH_MAX_BYTES && !BINARY.test(row.path);
}

/**
 * `scope()` names the session the entries belong to; `readMany(paths)` resolves the batch answer
 * (`{files: [{path, content, encoding} | {path, error}]}`); `readOne(path)` the single read (`{content, encoding}`).
 */
export function createFileCache({ scope, readMany, readOne }) {
  /** path -> {content, stale} */
  const entries = new Map();
  /** path -> Promise<entry | undefined>, while a prefetch is reading it */
  const inflight = new Map();
  /** path -> how many times it was set or dropped */
  const versions = new Map();
  let owner;
  let epoch = 0;
  /** markStale calls so far: what a prefetch reads after one began is already stale when it lands */
  let staleMarks = 0;

  const version = (path) => versions.get(path) ?? 0;
  const bump = (path) => versions.set(path, version(path) + 1);

  function sync() {
    const current = scope();
    if (current !== owner) {
      owner = current;
      reset();
    }
  }

  function reset() {
    entries.clear();
    inflight.clear();
    versions.clear();
    epoch++;
  }

  function set(path, content) {
    sync();
    bump(path);
    entries.set(path, { content, stale: false });
  }

  function drop(path) {
    sync();
    bump(path);
    entries.delete(path);
  }

  return {
    /** The entry for `path` now, or undefined; never waits. */
    get(path) {
      sync();
      return entries.get(path);
    },

    /** The entry for `path`, waiting for a prefetch that is reading it right now; undefined when there is none. */
    async lookup(path) {
      sync();
      return entries.get(path) ?? (await inflight.get(path));
    },

    /**
     * Reads, in one batch, the rows that are prefetchable and not already held fresh (or being read).
     * Resolves how many entries it stored; never rejects (a failed batch just means opens read on their own).
     */
    async prefetch(rows) {
      sync();
      const paths = [];
      for (const row of rows ?? []) {
        if (paths.length >= PREFETCH_MAX_FILES) break;
        if (!prefetchable(row) || inflight.has(row.path) || paths.includes(row.path)) continue;
        const held = entries.get(row.path);
        if (held && !held.stale) continue;
        paths.push(row.path);
      }
      if (!paths.length) return 0;

      const startEpoch = epoch;
      const startMarks = staleMarks;
      const before = new Map(paths.map((p) => [p, version(p)]));
      const batch = Promise.resolve()
        .then(() => readMany(paths))
        .then((answer) => {
          const got = new Map();
          if (epoch !== startEpoch) return got;
          for (const file of answer?.files ?? []) {
            const path = file?.path;
            // A write that landed while this was in flight is newer than what came back.
            if (!before.has(path) || version(path) !== before.get(path)) continue;
            if (file.error || file.encoding === 'base64' || typeof file.content !== 'string') {
              entries.delete(path);
              continue;
            }
            const entry = { content: file.content, stale: staleMarks !== startMarks };
            entries.set(path, entry);
            got.set(path, entry);
          }
          return got;
        })
        .catch(() => new Map());

      for (const path of paths) {
        const pending = batch.then((got) => got.get(path));
        inflight.set(path, pending);
        pending.finally(() => {
          if (inflight.get(path) === pending) inflight.delete(path);
        });
      }
      return (await batch).size;
    },

    /**
     * Reads `path` again on its own and stores the answer. Resolves `{content, changed}`, or null when the answer
     * is not worth showing: a newer write landed meanwhile, the session changed, or the file is not text.
     * Rejects as the read does (the entry is dropped first, so the next open reads afresh).
     */
    async revalidate(path) {
      sync();
      const startEpoch = epoch;
      const before = version(path);
      let result;
      try {
        result = await readOne(path);
      } catch (err) {
        if (epoch === startEpoch && version(path) === before) drop(path);
        throw err;
      }
      if (epoch !== startEpoch || version(path) !== before) return null;
      if (result?.encoding === 'base64' || typeof result?.content !== 'string') {
        drop(path);
        return null;
      }
      const prior = entries.get(path);
      set(path, result.content);
      return { content: result.content, changed: prior?.content !== result.content };
    },

    /** The file now holds `content` (it was just saved or created). */
    set,
    /** Forget `path` (deleted, or no longer to be trusted). */
    drop,
    /** Everything held may have changed (terminal activity): keep it to show at once, but read it again. */
    markStale() {
      staleMarks++;
      for (const entry of entries.values()) entry.stale = true;
    },
    /** Forget everything. */
    clear: reset,
  };
}
