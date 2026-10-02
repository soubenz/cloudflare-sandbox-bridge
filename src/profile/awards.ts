import type { Completion } from './derive';
import type { AwardTier } from './types';

/**
 * Every award, as data plus a pure rule over a facts object (`AwardContext`).
 * Nothing here reads D1 or the clock, so each rule is unit-testable on its
 * own. Persisting an award, and never moving its `earned_at`, is the job of
 * store.ts; a rule only says whether the learner qualifies and how far along
 * they are.
 *
 * Some awards are generated from the catalogue: one per module (for paths
 * with more than one module, since a one-module path IS its module and
 * would otherwise be awarded twice), one per path, and two per skill area.
 */

/** The only icon names an award may use; the console maps each to a glyph. */
export const AWARD_ICONS = ['flag', 'target', 'feather', 'stack', 'trophy', 'flame', 'bolt', 'refresh', 'puzzle', 'map', 'star', 'medal', 'compass'] as const;
export type AwardIcon = (typeof AWARD_ICONS)[number];

/** Progress of a group of labs (a module or a path) the learner may complete. */
export interface GroupProgress {
  /** Stable key: `${path}-${module}` for a module, the path slug for a path. */
  key: string;
  title: string;
  total: number;
  done: number;
  /** When the last lab of the group was completed; null until it is all done. */
  completed_at: number | null;
}

export interface AwardContext {
  now: number;
  /** Completed labs, oldest first. */
  completions: readonly Completion[];
  streak: { days: number; best: number };
  areas: ReadonlyArray<{ id: string; title: string; score: number }>;
  /** Modules of paths that have more than one module. */
  modules: readonly GroupProgress[];
  paths: readonly GroupProgress[];
  /** When the learner first passed after a failed run in the same session, or null. */
  comeback_at: number | null;
}

export interface AwardEval {
  earned: boolean;
  have: number;
  need: number;
  /** When the learner qualified, if the facts say; otherwise the caller uses "now". */
  at?: number | undefined;
}

export interface AwardDef {
  id: string;
  title: string;
  description: string;
  icon: AwardIcon;
  tier: AwardTier;
  evaluate(ctx: AwardContext): AwardEval;
}

export const PROFICIENT_SCORE = 60;
export const EXPERT_SCORE = 85;

const flag = (earned: boolean, at?: number): AwardEval => ({ earned, have: earned ? 1 : 0, need: 1, at });

function countRule(need: number, count: (ctx: AwardContext) => number, at: (ctx: AwardContext) => number | undefined): (ctx: AwardContext) => AwardEval {
  return (ctx) => {
    const have = count(ctx);
    return { earned: have >= need, have: Math.min(have, need), need, at: have >= need ? at(ctx) : undefined };
  };
}

/** The awards that do not depend on the catalogue. */
const FIXED: readonly AwardDef[] = [
  {
    id: 'first-lab',
    title: 'First steps',
    description: 'Finish your first lab.',
    icon: 'flag',
    tier: 'bronze',
    evaluate: countRule(1, (c) => c.completions.length, (c) => c.completions[0]?.at),
  },
  {
    id: 'first-try-pass',
    title: 'Right first time',
    description: 'Pass a lab on your very first attempt.',
    icon: 'target',
    tier: 'bronze',
    evaluate: (c) => {
      const hit = c.completions.find((x) => x.first_try);
      return flag(hit !== undefined, hit?.at);
    },
  },
  {
    id: 'no-hints-finish',
    title: 'On your own',
    description: 'Finish a lab without using a single hint.',
    icon: 'feather',
    tier: 'bronze',
    evaluate: (c) => {
      const hit = c.completions.find((x) => x.no_hints);
      return flag(hit !== undefined, hit?.at);
    },
  },
  {
    id: 'three-labs',
    title: 'Getting going',
    description: 'Finish three labs.',
    icon: 'stack',
    tier: 'bronze',
    evaluate: countRule(3, (c) => c.completions.length, (c) => c.completions[2]?.at),
  },
  {
    id: 'ten-labs',
    title: 'Ten down',
    description: 'Finish ten labs.',
    icon: 'trophy',
    tier: 'silver',
    evaluate: countRule(10, (c) => c.completions.length, (c) => c.completions[9]?.at),
  },
  {
    id: 'streak-3-days',
    title: 'Three in a row',
    description: 'Finish a lab or pass a lab on three days in a row.',
    icon: 'flame',
    tier: 'bronze',
    evaluate: countRule(3, (c) => c.streak.best, () => undefined),
  },
  {
    id: 'streak-7-days',
    title: 'A full week',
    description: 'Finish a lab or pass a lab on seven days in a row.',
    icon: 'flame',
    tier: 'silver',
    evaluate: countRule(7, (c) => c.streak.best, () => undefined),
  },
  {
    id: 'speed-run',
    title: 'Speed run',
    description: 'Finish a lab in less than half of its estimated time.',
    icon: 'bolt',
    tier: 'silver',
    evaluate: (c) => {
      const hit = c.completions.find((x) => x.fast);
      return flag(hit !== undefined, hit?.at);
    },
  },
  {
    id: 'comeback',
    title: 'Comeback',
    description: 'Pass a lab after a failed attempt in the same sitting.',
    icon: 'refresh',
    tier: 'bronze',
    evaluate: (c) => flag(c.comeback_at !== null, c.comeback_at ?? undefined),
  },
];

const ALL_AREAS: AwardDef = {
  id: 'all-six-areas',
  title: 'Well rounded',
  description: 'Reach at least Foundations in every skill area.',
  icon: 'compass',
  tier: 'gold',
  evaluate: (c) => {
    const have = c.areas.filter((a) => a.score >= 1).length;
    const need = c.areas.length;
    return { earned: need > 0 && have >= need, have, need };
  },
};

function groupRule(key: string, groups: (c: AwardContext) => readonly GroupProgress[]): (c: AwardContext) => AwardEval {
  return (c) => {
    const g = groups(c).find((x) => x.key === key);
    if (!g || g.total === 0) return { earned: false, have: 0, need: 1 };
    const earned = g.done >= g.total;
    return { earned, have: g.done, need: g.total, at: earned ? (g.completed_at ?? undefined) : undefined };
  };
}

function areaRule(id: string, need: number): (c: AwardContext) => AwardEval {
  return (c) => {
    const score = c.areas.find((a) => a.id === id)?.score ?? 0;
    return { earned: score >= need, have: Math.min(score, need), need };
  };
}

/**
 * Every award the learner can see, in display order. The generated ones come
 * from the groups and areas present in `ctx`, so a new module or area gets its
 * award without a code change here.
 */
export function awardDefinitions(ctx: Pick<AwardContext, 'modules' | 'paths' | 'areas'>): AwardDef[] {
  const defs: AwardDef[] = [...FIXED];
  for (const m of ctx.modules) {
    defs.push({
      id: `module-complete-${m.key}`,
      title: `Module complete: ${m.title}`,
      description: `Finish every lab in the module "${m.title}".`,
      icon: 'puzzle',
      tier: 'silver',
      evaluate: groupRule(m.key, (c) => c.modules),
    });
  }
  for (const p of ctx.paths) {
    defs.push({
      id: `path-complete-${p.key}`,
      title: `Path complete: ${p.title}`,
      description: `Finish every lab in the path "${p.title}".`,
      icon: 'map',
      tier: 'gold',
      evaluate: groupRule(p.key, (c) => c.paths),
    });
  }
  for (const a of ctx.areas) {
    defs.push({
      id: `area-proficient-${a.id}`,
      title: `Proficient in ${a.title}`,
      description: `Reach a score of ${PROFICIENT_SCORE} in ${a.title}.`,
      icon: 'star',
      tier: 'silver',
      evaluate: areaRule(a.id, PROFICIENT_SCORE),
    });
  }
  for (const a of ctx.areas) {
    defs.push({
      id: `area-expert-${a.id}`,
      title: `Expert in ${a.title}`,
      description: `Reach a score of ${EXPERT_SCORE} in ${a.title}.`,
      icon: 'medal',
      tier: 'gold',
      evaluate: areaRule(a.id, EXPERT_SCORE),
    });
  }
  defs.push(ALL_AREAS);
  return defs;
}
