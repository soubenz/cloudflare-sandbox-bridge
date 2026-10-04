import concepts from '../../packages/catalogue/concepts.json';
import { compareCatalogueEntries, type LabIndexEntry } from '../labs/bundle';

/**
 * The rules of the personal learning path. Pure: no I/O, no clock, no model.
 *
 * The rules decide WHICH labs may be on a learner's path and give a baseline
 * order (`rulesOrder`). A model may reorder the allowed labs afterwards
 * (src/path/ai.ts), but it can never add, remove or break a rule: the server
 * validates its answer against the set and the prerequisite order computed
 * here (src/path/validate.ts).
 *
 * The rules, in the order they apply:
 *
 *  1. Archived labs are never on a path.
 *  2. A lab the learner has completed (passed every check, per `check_runs`)
 *     is shown as done and is never asked for again.
 *  3. Plan. The free plan may start only labs with `tier: 'free'` (the
 *     manifest's "whether the free plan may start this lab"). Any other lab
 *     is `locked` for a free learner, and so is a lab whose prerequisite is.
 *     Locked labs are not offered to the model and do not count in the totals.
 *  4. A 'strong' area (quiz level) is skipped, except one capstone: the
 *     highest-order lab of that area the learner's plan can start. A skipped
 *     lab counts as known, so a capstone's prerequisites inside the area are
 *     satisfied without being on the path.
 *  5. Prerequisites. A lab is only allowed after its prerequisites: each must
 *     be on the path before it, completed, or skipped under rule 4. A
 *     prerequisite that is not in the (active) catalogue is ignored, like the
 *     publish step that only warns about it.
 *  6. A 'new' area starts with its foundation labs (the labs marked
 *     `difficulty: 'intro'`, or the area's first lab when none is), ahead of
 *     everything else; the rest keeps catalogue order.
 */

export type AreaLevel = 'new' | 'familiar' | 'strong';
export type Plan = 'free' | 'pro';

/** The quiz's areas: id -> where its labs live (packages/catalogue/concepts.json). */
export type AreaRegistry = Record<string, { title: string; path: string; module: number }>;

export const AREAS: AreaRegistry = concepts.areas;

/** The area a lab belongs to: the quiz area whose (path, module) the lab sits in. Labs outside every area have none. */
export function labArea(lab: Pick<LabIndexEntry, 'path' | 'module'>, areas: AreaRegistry = AREAS): string | null {
  for (const [id, a] of Object.entries(areas)) {
    if (lab.path === a.path && lab.module === a.module) return id;
  }
  return null;
}

export interface RulesInput {
  /** The catalogue as published (any order, archived included). */
  catalogue: readonly LabIndexEntry[];
  /** Quiz level per area. An area missing here has no adjustment (treated like 'familiar'). */
  levels: Readonly<Record<string, AreaLevel>>;
  plan: Plan;
  /** Slugs of labs the learner has passed every check of. */
  completed: ReadonlySet<string>;
  areas?: AreaRegistry;
}

/**
 * Why a lab is locked. `plan`: the lab's tier is pro and the learner is on the
 * free plan, so a plan unlocks it. `prerequisite`: the plan could start it, but
 * a prerequisite (`by`) is itself locked, so it opens only after that one.
 */
export type LockInfo = { lock: 'plan' } | { lock: 'prerequisite'; by: LabIndexEntry };

export interface RulesResult {
  /** Completed labs still in the catalogue, in catalogue order. */
  done: LabIndexEntry[];
  /** The labs a model may order, in the rules' own order (`rulesOrder`). Prerequisites always come first. */
  allowed: LabIndexEntry[];
  /** Labs the learner's plan cannot start (or that need one), in catalogue order. */
  locked: LabIndexEntry[];
  /** Why each locked lab is locked, by slug: one entry for every lab in `locked`. */
  locks: ReadonlyMap<string, LockInfo>;
  /** Slugs that are the single lab kept for a 'strong' area. */
  capstones: ReadonlySet<string>;
  /** Slugs that are the foundation labs of a 'new' area (the ones put first). */
  foundations: ReadonlySet<string>;
}

/** The prerequisites of `lab` that are in `inSet`: the only ones an ordering has to respect. */
export function prerequisitesIn(lab: Pick<LabIndexEntry, 'prerequisites'>, inSet: ReadonlySet<string>): string[] {
  return (lab.prerequisites ?? []).filter((p) => inSet.has(p));
}

/**
 * Stable topological fix-up: walks `items` in order and, at each step, emits
 * the first remaining item whose prerequisites (within `items`) are all
 * emitted already. An item that is early only because nothing forced it later
 * keeps its place; one that precedes its prerequisite is moved just after it.
 * A cycle cannot be satisfied, so when nothing is ready the first remaining
 * item is emitted anyway: the result is always a permutation of `items`.
 */
export function stableTopo<T>(items: readonly T[], slugOf: (t: T) => string, prereqsOf: (t: T) => readonly string[]): T[] {
  const inSet = new Set(items.map(slugOf));
  const remaining = [...items];
  const emitted = new Set<string>();
  const out: T[] = [];
  while (remaining.length > 0) {
    let at = remaining.findIndex((t) => prereqsOf(t).every((p) => p === slugOf(t) || !inSet.has(p) || emitted.has(p)));
    if (at < 0) at = 0;
    const [next] = remaining.splice(at, 1);
    out.push(next!);
    emitted.add(slugOf(next!));
  }
  return out;
}

/** Applies every rule above. Deterministic: the same input is always the same result. */
export function applyRules(input: RulesInput): RulesResult {
  const areas = input.areas ?? AREAS;
  const active = input.catalogue.filter((l) => !l.archived).sort(compareCatalogueEntries);
  const activeSlugs = new Set(active.map((l) => l.slug));
  const canStart = (l: LabIndexEntry) => input.plan === 'pro' || (l.tier ?? 'pro') === 'free';
  const areaOf = new Map(active.map((l) => [l.slug, labArea(l, areas)] as const));

  const done = active.filter((l) => input.completed.has(l.slug));
  const doneSlugs = new Set(done.map((l) => l.slug));

  // Rule 4: one capstone per strong area, then everything else of that area is skipped.
  const capstones = new Set<string>();
  for (const [area, level] of Object.entries(input.levels)) {
    if (level !== 'strong') continue;
    const startable = active.filter((l) => areaOf.get(l.slug) === area && canStart(l));
    const last = startable[startable.length - 1];
    if (last) capstones.add(last.slug);
  }
  const skipped = new Set(
    active.filter((l) => !doneSlugs.has(l.slug) && input.levels[areaOf.get(l.slug) ?? ''] === 'strong' && !capstones.has(l.slug)).map((l) => l.slug)
  );

  const candidates = active.filter((l) => !doneSlugs.has(l.slug) && !skipped.has(l.slug));

  // Rule 3: plan. A lab is locked when the plan cannot start it, or a prerequisite that is itself locked stands in the way.
  const locked = new Set(candidates.filter((l) => !canStart(l)).map((l) => l.slug));
  const locks = new Map<string, LockInfo>([...locked].map((slug) => [slug, { lock: 'plan' }] as const));
  const bySlug = new Map(candidates.map((l) => [l.slug, l] as const));
  for (let changed = true; changed; ) {
    changed = false;
    for (const l of candidates) {
      if (locked.has(l.slug)) continue;
      const blocker = (l.prerequisites ?? []).find((p) => locked.has(p));
      if (blocker) {
        locked.add(l.slug);
        locks.set(l.slug, { lock: 'prerequisite', by: bySlug.get(blocker)! });
        changed = true;
      }
    }
  }
  const reachable = candidates.filter((l) => !locked.has(l.slug));

  // Rule 6: foundations of 'new' areas first.
  const foundations = new Set<string>();
  for (const [area, level] of Object.entries(input.levels)) {
    if (level !== 'new') continue;
    const inArea = reachable.filter((l) => areaOf.get(l.slug) === area);
    const intro = inArea.filter((l) => l.difficulty === 'intro');
    for (const l of intro.length > 0 ? intro : inArea.slice(0, 1)) foundations.add(l.slug);
  }
  const ordered = [...reachable.filter((l) => foundations.has(l.slug)), ...reachable.filter((l) => !foundations.has(l.slug))];

  // Rule 5: prerequisites (only those still to be done matter; the rest are completed, skipped or unknown).
  const reachableSlugs = new Set(reachable.map((l) => l.slug));
  const allowed = stableTopo(
    ordered,
    (l) => l.slug,
    (l) => prerequisitesIn(l, reachableSlugs).filter((p) => activeSlugs.has(p))
  );

  return { done, allowed, locked: candidates.filter((l) => locked.has(l.slug)), locks, capstones, foundations };
}

/** The baseline order: what the learner gets when no model orders the labs. */
export function rulesOrder(input: RulesInput): LabIndexEntry[] {
  return applyRules(input).allowed;
}
