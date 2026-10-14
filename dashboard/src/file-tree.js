/**
 * What the editor's file tree leaves out. Pure: no DOM, no API, so the rules are unit tested
 * (test/unit/console-file-tree.test.ts) and app.js only supplies a way to list a folder.
 *
 * Two sources:
 *   - the platform's own: brief.md and hints.md at the top of /workspace. Publishing copies them
 *     there for the terminal, but the Brief and Hints tabs already show them, so the tree never does.
 *   - the lab's: manifest `hidden` (src/labs/manifest.ts), paths relative to /workspace where a
 *     trailing slash means a whole folder. Scaffolding such as a fake provider or a view tab's page.
 *
 * Hiding is only about the tree: the files stay in /workspace and open as usual by their path.
 * A folder left with nothing to show once its hidden entries are gone is left out too.
 */

/** Left out of the tree on every lab, at the top of /workspace only. */
export const ALWAYS_HIDDEN = ['brief.md', 'hints.md'];

/**
 * The tree's rules for one lab, from its manifest summary's `hidden` (absent or not an array: none).
 * Entries the schema would refuse (absolute, `..`, empty) are ignored rather than trusted.
 */
export function hiddenRules(hidden) {
  const files = new Set(ALWAYS_HIDDEN);
  const folders = [];
  for (const raw of Array.isArray(hidden) ? hidden : []) {
    if (typeof raw !== 'string') continue;
    const entry = raw.replace(/^\.\//, '');
    const bare = entry.replace(/\/+$/, '');
    if (!bare || entry.startsWith('/') || bare.split('/').some((s) => s === '' || s === '.' || s === '..')) continue;
    if (entry.endsWith('/')) folders.push(bare);
    else files.add(bare);
  }
  return { files, folders };
}

/** Whether the tree leaves out `path` (relative to /workspace), a file or a folder. */
export function isHidden(rules, path) {
  if (rules.files.has(path)) return true;
  return rules.folders.some((f) => path === f || path.startsWith(`${f}/`));
}

/** Whether something hidden sits somewhere below the folder `path`, so it may have nothing left to show. */
function hidesInside(rules, path) {
  const prefix = `${path}/`;
  return [...rules.files].some((f) => f.startsWith(prefix)) || rules.folders.some((f) => f.startsWith(prefix));
}

/**
 * The entries of folder `dir` ('' for /workspace) the tree shows. `entries` are `{ name, isDirectory }`
 * (anything else is kept as it is); `listDir(rel)` lists a subfolder the same way and is only called for
 * a folder with something hidden inside it, to find out whether anything else is left there. A folder
 * that cannot be listed is kept: better a folder too many than a file the learner cannot find.
 */
export async function visibleEntries(rules, dir, entries, listDir) {
  const out = [];
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (isHidden(rules, rel)) continue;
    if (entry.isDirectory && hidesInside(rules, rel)) {
      let children;
      try {
        children = await listDir(rel);
      } catch {
        out.push(entry);
        continue;
      }
      if ((await visibleEntries(rules, rel, children, listDir)).length === 0) continue;
    }
    out.push(entry);
  }
  return out;
}
