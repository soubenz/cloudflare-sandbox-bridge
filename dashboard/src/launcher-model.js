/**
 * The launcher's data, with no DOM: labs grouped by path and module, every
 * total the page prints, and which labs are locked. app.js draws it and
 * test/unit/launcher-model.test.ts pins it.
 *
 *   buildLauncherModel(labs, meta, { passed })
 *     labs    the catalogue as GET /api/labs returns it (progress merged in)
 *     meta    packages/catalogue/paths.json: title, intro, icon, accent and
 *             skills of each path and module. It may be missing, partly
 *             filled or out of date; nothing here throws for want of it.
 *     passed  Set of slugs this person has passed every check of (defaults
 *             to the labs whose progress says so)
 *
 * The result is paths -> modules -> labs, in the order the catalogue gives:
 * paths in the order of the metadata (then any path the metadata does not
 * know, by slug), modules by number, labs by `order` then slug. Labs with no
 * `path` close the list as one "Other labs" group (and that group is not
 * drawn when it has no labs).
 *
 * Archived labs (`archived: true`: test fixtures, retired labs) are not
 * learner-facing: they are left out of every group, count and total here.
 * They are still in the catalogue the caller holds, which is what a lookup by
 * slug (a deep link, the resume card, starting a lab) must use.
 */

/** The accent families the design tokens define (packages/design/tokens.css). */
export const ACCENTS = ['blue', 'teal', 'green', 'amber', 'rose', 'violet', 'indigo', 'slate'];

/**
 * 24px stroke glyphs, drawn on `fill="none" stroke="currentColor"`, keyed by
 * the `icon` field of the metadata. `grid` is what a path or module with no
 * (or an unknown) icon gets.
 */
export const ICONS = {
  bolt: '<path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11H12z"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12.5 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  route: '<circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M7 19h6a3.5 3.5 0 0 0 0-7h-2a3.5 3.5 0 0 1 0-7h6"/>',
  plug: '<path d="M9 2.5v5M15 2.5v5"/><path d="M6 7.5h12v3.5a6 6 0 0 1-12 0z"/><path d="M12 17v4.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20.5 20.5-5.4-5.4"/>',
  chart: '<path d="M4 3.5v17h17"/><path d="m8 15.5 3.5-4.5 3 2.5 5-6.5"/>',
  stack: '<rect x="4" y="3.5" width="16" height="5" rx="1.5"/><rect x="4" y="10" width="16" height="5" rx="1.5"/><rect x="4" y="16.5" width="16" height="4" rx="1.5"/><path d="M7.5 6h.01M7.5 12.5h.01"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.8 8.2-2.1 5.5-5.5 2.1 2.1-5.5z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2"/>',
  gate: '<path d="M4.5 21V4M19.5 21V4"/><path d="M4.5 8h15M4.5 13.5h15"/><path d="m9.5 19 1.7 1.7 3.3-3.4"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
};

/** Rank for sorting: a finite number sorts by value, anything else last. */
const rank = (v) => (Number.isFinite(v) ? v : Infinity);
const cmp = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

/** Labs of one module: `order`, then slug. */
const compareLabs = (a, b) => cmp(rank(a.order), rank(b.order)) || cmp(String(a.slug), String(b.slug));

/** "agent-foundations" -> "Agent foundations". */
export function humanize(slug) {
  const words = String(slug ?? '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Minutes as "2 h 10 min", "45 min" or "3 h". Anything that is not a
 * positive number reads "0 min".
 */
export function minutesLabel(minutes) {
  const total = Math.round(Number(minutes));
  if (!Number.isFinite(total) || total <= 0) return '0 min';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * A length for a summary line, rounded the way people say it: to five
 * minutes under two hours, to the half hour under ten, else to the hour.
 * "about 21 h" for a path of 1230 minutes. Empty when there is no time.
 */
export function approxMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 120) return minutesLabel(Math.max(5, Math.round(n / 5) * 5));
  if (n < 600) return `${Math.round(n / 30) / 2} h`;
  return `${Math.round(n / 60)} h`;
}

/** True for a lab the manifest archived: hidden from learners, still startable by slug. */
export const isArchived = (lab) => lab?.archived === true;

/** The labs a learner sees: the catalogue without the archived ones. Keep the full list for lookups by slug. */
export const visibleLabs = (labs) => (Array.isArray(labs) ? labs.filter((lab) => !isArchived(lab)) : []);

/** Slugs this person has passed every check of. */
export function passedSlugs(labs) {
  return new Set(labs.filter((lab) => lab.progress?.passed_all).map((lab) => lab.slug));
}

/** not started / started / done, from the progress the Worker merged in. */
export function labStatus(lab) {
  if (lab.progress?.passed_all) return 'done';
  return lab.progress?.attempts > 0 ? 'started' : 'todo';
}

/**
 * The first prerequisite this person has not passed, or null when the lab is
 * open. A prerequisite the catalogue does not list counts as unmet: it cannot
 * have been passed through this console.
 */
export function unmetPrerequisite(lab, passed) {
  return (lab.prerequisites ?? []).find((slug) => !passed.has(slug)) ?? null;
}

const accentOf = (value) => (ACCENTS.includes(value) ? value : 'slate');
const text = (value) => (typeof value === 'string' ? value.trim() : '');

function totalsOf(entries) {
  let done = 0;
  let minutes = 0;
  let free = 0;
  for (const e of entries) {
    if (e.done) done++;
    if (e.free) free++;
    minutes += e.minutes;
  }
  return { labs: entries.length, done, minutes, free };
}

export function buildLauncherModel(labs, meta, { passed } = {}) {
  const all = Array.isArray(labs) ? labs.filter((lab) => lab && typeof lab === 'object' && lab.slug) : [];
  const passedSet = passed ?? passedSlugs(all);
  // Titles and passed slugs come from the whole catalogue (a visible lab may
  // name an archived prerequisite); only the grouping below is learner-facing.
  const titleOf = new Map(all.map((lab) => [lab.slug, lab.title]));
  const shown = visibleLabs(all);

  const metaPaths = Array.isArray(meta?.paths) ? meta.paths.filter((p) => p && typeof p.slug === 'string') : [];
  const metaPath = new Map(metaPaths.map((p) => [p.slug, p]));

  /** The row a lab becomes: the lab itself plus everything the page derives from it. */
  const entry = (lab, index) => {
    const lockedBy = unmetPrerequisite(lab, passedSet);
    const minutes = Number.isFinite(lab.estimated_minutes) && lab.estimated_minutes > 0 ? lab.estimated_minutes : 0;
    return {
      lab,
      index,
      done: passedSet.has(lab.slug),
      status: labStatus(lab),
      locked: lockedBy !== null,
      lockedBy,
      lockedByTitle: lockedBy === null ? null : (titleOf.get(lockedBy) ?? lockedBy),
      free: lab.tier === 'free',
      minutes,
    };
  };

  // Bucket by path (in first-seen order, fixed up below), then by module.
  const byPath = new Map();
  const noPath = [];
  for (const lab of shown) {
    const slug = text(lab.path);
    if (!slug) {
      noPath.push(lab);
      continue;
    }
    if (!byPath.has(slug)) byPath.set(slug, []);
    byPath.get(slug).push(lab);
  }

  const known = metaPaths.map((p) => p.slug).filter((slug) => byPath.has(slug));
  const unknown = [...byPath.keys()].filter((slug) => !metaPath.has(slug)).sort();
  const order = [...known, ...unknown];

  /** Modules of one path: labs grouped by module number, described by the metadata when it has them. */
  const modulesOf = (pathLabs, pathMeta) => {
    const numbers = new Map();
    for (const lab of pathLabs) {
      const n = Number.isFinite(lab.module) ? lab.module : 1;
      if (!numbers.has(n)) numbers.set(n, []);
      numbers.get(n).push(lab);
    }
    const metaModules = Array.isArray(pathMeta?.modules) ? pathMeta.modules.filter((m) => m && Number.isFinite(m.number)) : [];
    const describe = new Map(metaModules.map((m) => [m.number, m]));
    const cards = metaModules.length > 0 || numbers.size > 1;
    const modules = [...numbers.keys()]
      .sort((a, b) => a - b)
      .map((number) => {
        const m = describe.get(number);
        const entries = numbers
          .get(number)
          .sort(compareLabs)
          .map((lab, i) => entry(lab, i + 1));
        return {
          number,
          known: Boolean(m),
          eyebrow: `Module ${number}`,
          title: text(m?.title) || `Module ${number}`,
          intro: text(m?.intro),
          skills: Array.isArray(m?.skills) ? m.skills.filter((s) => typeof s === 'string' && s.trim()) : [],
          icon: text(m?.icon),
          accent: accentOf(m?.accent),
          optional: m?.optional === true,
          labs: entries,
          totals: totalsOf(entries),
        };
      });
    return { cards, modules };
  };

  const paths = order.map((slug, i) => {
    const pathMeta = metaPath.get(slug);
    const { cards, modules } = modulesOf(byPath.get(slug), pathMeta);
    const entries = modules.flatMap((m) => m.labs);
    return {
      slug,
      number: i + 1,
      known: Boolean(pathMeta),
      other: false,
      title: text(pathMeta?.title) || humanize(slug),
      intro: text(pathMeta?.intro),
      icon: text(pathMeta?.icon),
      accent: accentOf(pathMeta?.accent),
      cards,
      modules,
      labs: entries,
      totals: totalsOf(entries),
    };
  });

  if (noPath.length) {
    const entries = noPath.sort((a, b) => cmp(String(a.slug), String(b.slug))).map((lab, i) => entry(lab, i + 1));
    const totals = totalsOf(entries);
    const module = { number: null, known: false, eyebrow: '', title: '', intro: '', skills: [], icon: '', accent: 'slate', optional: false, labs: entries, totals };
    paths.push({
      slug: '',
      number: paths.length + 1,
      known: false,
      other: true,
      // "Other" only makes sense next to real paths.
      title: order.length ? 'Other labs' : 'All labs',
      intro: '',
      icon: '',
      accent: 'slate',
      cards: false,
      modules: [module],
      labs: entries,
      totals,
    });
  }

  return { paths, totals: totalsOf(paths.flatMap((p) => p.labs)) };
}

/** "31 labs · about 21 h · 2 free · 3 done": the line under a path's title. */
export function summaryLine(totals) {
  const parts = [`${totals.labs} ${totals.labs === 1 ? 'lab' : 'labs'}`];
  const approx = approxMinutes(totals.minutes);
  if (approx) parts.push(`about ${approx}`);
  if (totals.free) parts.push(`${totals.free} free`);
  parts.push(`${totals.done} done`);
  return parts.join(' · ');
}

/** "5 labs · ~2 h · 1 free": the line under a module's skills. */
export function moduleMetaLine(totals) {
  const parts = [`${totals.labs} ${totals.labs === 1 ? 'lab' : 'labs'}`];
  const approx = approxMinutes(totals.minutes);
  if (approx) parts.push(`~${approx}`);
  if (totals.free) parts.push(`${totals.free} free`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// The hero, the running lab's place in the catalogue, and which modules open.

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const LEDE_TAIL = 'Start with an explore lab, then build or fix the real thing. Your progress is kept on this browser.';

/**
 * The line under the hero: how many paths there are, then the same advice.
 * "Four paths, each a run of hands-on labs. Start with an explore lab, …"
 * `count` is the number of real paths (not the "Other labs" group).
 */
export function heroLede(count) {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n < 1) return `Each path is a run of hands-on labs. ${LEDE_TAIL}`;
  if (n === 1) return `One path, a run of hands-on labs. ${LEDE_TAIL}`;
  const word = NUMBER_WORDS[n] ?? String(n);
  return `${word.charAt(0).toUpperCase() + word.slice(1)} paths, each a run of hands-on labs. ${LEDE_TAIL}`;
}

/**
 * Where a lab sits: `{ path, module, entry, position, total }` (position is 1-based
 * within its module, total the module's lab count), or null when the catalogue has
 * no such lab. The resume card says "lab 3 of 6" from this.
 */
export function locateLab(model, slug) {
  for (const path of model?.paths ?? []) {
    for (const module of path.modules) {
      const at = module.labs.findIndex((e) => e.lab.slug === slug);
      if (at >= 0) return { path, module, entry: module.labs[at], position: at + 1, total: module.labs.length };
    }
  }
  return null;
}

/** A path with more modules than this opens only the ones worth opening; the rest are cards to open. */
export const MINI_AFTER = 4;
/** How many modules, from the first, always open. */
export const OPEN_FIRST = 2;

/**
 * Which modules of a path show in full and which as a condensed card:
 * a Map of module number to 'full' | 'mini'.
 *
 * A path of up to MINI_AFTER modules, and a path with no module cards, shows
 * everything. A longer one opens its first OPEN_FIRST modules, any module with
 * a lab under way, the one holding the running lab, the one the quiz suggests,
 * and any module in `open` (the ones the learner opened); the others are minis.
 * Nothing is ever dropped: a mini opens in place, and a search or filter opens
 * every module that has a match (app.js, `is-filtering`).
 */
export function moduleViews(path, { suggested = null, running = null, open = [] } = {}) {
  const views = new Map();
  const condense = Boolean(path?.cards) && path.modules.length > MINI_AFTER;
  path.modules.forEach((module, i) => {
    let full = !condense || i < OPEN_FIRST || new Set(open).has(module.number);
    if (!full) {
      full =
        module.labs.some((e) => e.status === 'started' || e.lab.slug === running) ||
        (suggested && suggested.path === path.slug && suggested.number === module.number);
    }
    views.set(module.number, full ? 'full' : 'mini');
  });
  return views;
}

// ---------------------------------------------------------------------------
// The pages: home (paths), a path (modules), a module (labs), a lab.

/** The id a path has in an address: its slug, or `other` for the labs that belong to none. */
export const pathId = (path) => (path.other ? 'other' : path.slug);

/** The path an address's id names (`other` is the group of labs with no path), or null. */
export function findPath(model, id) {
  return (model?.paths ?? []).find((p) => pathId(p) === id) ?? null;
}

/**
 * The module with this number, or null. Only a path that draws module cards has addressable modules: a
 * path with one implicit module is its labs, and the "Other labs" group has no numbers at all.
 */
export function findModule(path, number) {
  if (!path?.cards) return null;
  return path.modules.find((m) => m.number === number) ?? null;
}

/** "Module 3" or "Module 3: Retrieval", as a crumb or a heading says it. */
export const moduleLabel = (module) => (module.known && module.title ? `${module.eyebrow}: ${module.title}` : module.eyebrow || 'Module');

/** "7 modules · 31 labs · about 21 h": the line under a path's title on its card. */
export function pathCardLine(path) {
  const parts = [];
  if (path.cards) parts.push(`${path.modules.length} ${path.modules.length === 1 ? 'module' : 'modules'}`);
  parts.push(`${path.totals.labs} ${path.totals.labs === 1 ? 'lab' : 'labs'}`);
  const approx = approxMinutes(path.totals.minutes);
  if (approx) parts.push(`about ${approx}`);
  return parts.join(' · ');
}

/**
 * The trail of a page, Home first and the page itself last (its `route` is null: it is not a link).
 * Each other item carries the route (`{ name, ...params }`) it links to. `lab` is the catalogue entry
 * for a lab page (an archived lab, which the model leaves out, is Home > Lab).
 */
export function breadcrumbs(model, route, lab = null) {
  const items = [{ label: 'Home', route: { name: 'launcher' } }];
  const add = (label, to) => items.push({ label, route: to });
  switch (route?.name) {
    case 'profile':
      add('Profile', null);
      break;
    case 'my-path':
      add('Your path', null);
      break;
    case 'path': {
      const path = findPath(model, route.path);
      add(path?.title ?? humanize(route.path), null);
      break;
    }
    case 'module': {
      const path = findPath(model, route.path);
      const module = findModule(path, route.module);
      add(path?.title ?? humanize(route.path), { name: 'path', path: route.path });
      add(module ? moduleLabel(module) : `Module ${route.module}`, null);
      break;
    }
    case 'lab': {
      const at = locateLab(model, route.slug);
      if (at) {
        add(at.path.title, { name: 'path', path: pathId(at.path) });
        if (at.path.cards) add(moduleLabel(at.module), { name: 'module', path: pathId(at.path), module: at.module.number });
      }
      add(lab?.title || route.slug, null);
      break;
    }
    default:
      break;
  }
  items[items.length - 1].route = null;
  return items;
}

/** The labs a page is about, for its search and filters: every lab (home), a path's, or a module's. Empty for a page with none. */
export function scopeEntries(model, route) {
  switch (route?.name) {
    case 'launcher':
      return (model?.paths ?? []).flatMap((p) => p.labs);
    case 'path':
      return findPath(model, route.path)?.labs ?? [];
    case 'module':
      return findModule(findPath(model, route.path), route.module)?.labs ?? [];
    default:
      return [];
  }
}
