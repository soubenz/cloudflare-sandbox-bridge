import { areaForPlacement, type SkillArea } from './areas';
import type { CatalogueLab, ProfileFacts, RunFact, SessionFact, Streak } from './types';

/**
 * Turns the raw rows (check runs, sessions) into the per-lab facts every
 * other profile module reads. Pure: no clock, no I/O. A lab the catalogue
 * does not list, or lists as archived, is left out of everything.
 */

export const DAY_MS = 86_400_000;

/** The UTC calendar day of an epoch-ms time, as a day number. Midnight UTC belongs to the NEW day. */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** `YYYY-MM-DD` of a UTC day number. */
export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Index order: (path ?? 'zz', module ?? 999, order ?? 999, slug), the same as the catalogue's own. */
export function compareLabs(a: CatalogueLab, b: CatalogueLab): number {
  return (
    (a.path ?? 'zz').localeCompare(b.path ?? 'zz') ||
    (a.module ?? 999) - (b.module ?? 999) ||
    (a.order ?? 999) - (b.order ?? 999) ||
    a.slug.localeCompare(b.slug)
  );
}

/** Non-archived labs in catalogue order. */
export function activeLabs(catalogue: readonly CatalogueLab[]): CatalogueLab[] {
  return catalogue.filter((l) => l.archived !== true).sort(compareLabs);
}

/** When a run counts as having happened. */
export function runTime(run: Pick<RunFact, 'started_at' | 'finished_at'>): number {
  return run.finished_at ?? run.started_at;
}

/** The first run of a lab that passed every check, and what it took to get there. */
export interface Completion {
  slug: string;
  /** Epoch ms the lab was completed. */
  at: number;
  session_id: string;
  run_id: string;
  /** Runs of this lab up to and including the completing one (1 = first try). */
  attempts: number;
  /** Hints that had unlocked in the completing session. */
  hints: number;
  first_try: boolean;
  no_hints: boolean;
  /** Minutes from the session starting to the completing run; null when the session row is missing. */
  minutes: number | null;
  /** Finished in under half the lab's estimated time. */
  fast: boolean;
}

export interface BestResult {
  /** Best run's score, 0-100, before any penalty. */
  score: number;
  /** Runs of this lab up to and including the best one. */
  attempts: number;
  /** Hints that had unlocked in the best run's session. */
  hints: number;
}

export interface LabState {
  lab: CatalogueLab;
  area: SkillArea | undefined;
  /** How many runs the learner made of this lab. */
  runs: number;
  best: BestResult | null;
  completion: Completion | null;
}

function byTime(a: RunFact, b: RunFact): number {
  return a.started_at - b.started_at || a.run_id.localeCompare(b.run_id);
}

/** Per-lab facts for every non-archived catalogue lab, in catalogue order. */
export function deriveLabStates(facts: Pick<ProfileFacts, 'runs' | 'sessions'>, catalogue: readonly CatalogueLab[]): LabState[] {
  const sessions = new Map<string, SessionFact>(facts.sessions.map((s) => [s.id, s]));
  const runsByLab = new Map<string, RunFact[]>();
  for (const run of [...facts.runs].sort(byTime)) {
    const list = runsByLab.get(run.lab_slug);
    if (list) list.push(run);
    else runsByLab.set(run.lab_slug, [run]);
  }

  return activeLabs(catalogue).map((lab): LabState => {
    const runs = runsByLab.get(lab.slug) ?? [];
    const hintsOf = (run: RunFact) => sessions.get(run.session_id)?.hints_delivered ?? 0;

    // Best = highest score; a run that passed everything beats an equal-score
    // partial one; ties keep the earliest, so later runs never move it.
    let best: BestResult | null = null;
    let bestRun: RunFact | undefined;
    for (const [i, run] of runs.entries()) {
      if (!bestRun || run.score > bestRun.score || (run.score === bestRun.score && run.passed_all && !bestRun.passed_all)) {
        bestRun = run;
        best = { score: Math.min(100, Math.max(0, run.score * 100)), attempts: i + 1, hints: hintsOf(run) };
      }
    }

    let completion: Completion | null = null;
    const at = runs.findIndex((r) => r.passed_all);
    if (at >= 0) {
      const run = runs[at]!;
      const when = runTime(run);
      const session = sessions.get(run.session_id);
      const startedAt = session ? (session.started_at ?? session.created_at) : null;
      const minutes = startedAt === null ? null : Math.max(0, (when - startedAt) / 60_000);
      const hints = hintsOf(run);
      completion = {
        slug: lab.slug,
        at: when,
        session_id: run.session_id,
        run_id: run.run_id,
        attempts: at + 1,
        hints,
        first_try: at === 0,
        no_hints: hints === 0,
        minutes,
        fast: minutes !== null && lab.estimated_minutes !== undefined && minutes < lab.estimated_minutes * 0.5,
      };
    }
    return { lab, area: areaForPlacement(lab), runs: runs.length, best, completion };
  });
}

/**
 * Consecutive UTC days with a completed lab or a passing run. The current
 * streak stays alive through the end of the day after the last active day:
 * active yesterday and not yet today still counts. `best` is the longest ever.
 */
export function deriveStreak(runs: readonly RunFact[], now: number): { streak: Streak; days: number[] } {
  const days = [...new Set(runs.filter((r) => r.passed_all).map((r) => utcDay(runTime(r))))].sort((a, b) => a - b);
  if (days.length === 0) return { streak: { days: 0, best: 0, last_active: null }, days };

  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i] === days[i - 1]! + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const last = days[days.length - 1]!;
  // `run` now is the streak ending at `last`.
  const alive = utcDay(now) - last <= 1;
  return { streak: { days: alive ? run : 0, best, last_active: dayString(last) }, days };
}

/**
 * The first time the learner passed after failing in the SAME session: a run
 * that passed everything, with an earlier run in that session that had a
 * failing check. A partial run (`only`) that passed what it covered is not a failure.
 */
export function comebackAt(runs: readonly RunFact[]): number | null {
  const failedIn = new Set<string>();
  let at: number | null = null;
  for (const run of [...runs].sort(byTime)) {
    if (run.passed_all) {
      if (failedIn.has(run.session_id)) {
        const t = runTime(run);
        if (at === null || t < at) at = t;
      }
    } else if (run.score < 1) {
      failedIn.add(run.session_id);
    }
  }
  return at;
}
