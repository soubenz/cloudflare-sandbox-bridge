import { SKILLS, skillForPlacement, type SkillDef } from '../skills';
import type { Plan } from './rules';

/**
 * The ONE answer to "which lab next?", overall and per skill. The profile
 * (each skill's `next_lab` and the top-level `next_lab`), the personal path
 * (which step is `next`) and, through the profile, the console's "Suggested
 * start" badge and the quiz's "Start here" all read it, so they cannot
 * disagree. Pure: no I/O, no clock.
 *
 * The rule, for the whole catalogue and again for each skill's labs:
 *
 *  1. The learner's stored path, when there is one: its first `next` or
 *     `upcoming` step (in path order) that is still in the catalogue, not
 *     done and startable on the learner's plan.
 *  2. Otherwise the first lab in catalogue order (path, module, order, slug)
 *     that is not done, that the plan can start, that the path does not skip
 *     (`skipped`: labs of a strong skill, see rules.ts `skippedForStrong`),
 *     and whose prerequisites are all done (or skipped). A prerequisite that
 *     is not in the active catalogue is ignored, as the path rules do.
 *  3. Otherwise none (null): everything is done, or what is left is locked.
 */

/** The slice of a catalogue lab the rule reads. A missing `tier` is 'pro', as in the manifest. */
export interface NextCandidate {
  slug: string;
  title: string;
  path?: string | undefined;
  module?: number | undefined;
  order?: number | undefined;
  prerequisites?: string[] | undefined;
  tier?: 'free' | 'pro' | undefined;
  archived?: boolean | undefined;
}

/** A catalogue lab and whether the learner has done it (a non-null `completion`), like the profile's LabState. */
export interface NextState {
  lab: NextCandidate;
  completion: unknown;
}

/** A path step as stored: only its slug and status matter here. */
export interface NextStep {
  slug: string;
  status: string;
}

export interface NextLab {
  slug: string;
  title: string;
  /** The skill the lab feeds, or null for a lab outside every skill. */
  skill: string | null;
  /** Where the lab sits, so the console can mark its module. */
  path: string | null;
  module: number | null;
}

export interface NextLabs {
  overall: NextLab | null;
  /** One entry per skill id, null when that skill has nothing to start next. */
  bySkill: Record<string, NextLab | null>;
}

/** Catalogue order: (path ?? 'zz', module ?? 999, order ?? 999, slug), the same as the published index. */
function compareCandidates(a: NextCandidate, b: NextCandidate): number {
  return (
    (a.path ?? 'zz').localeCompare(b.path ?? 'zz') ||
    (a.module ?? 999) - (b.module ?? 999) ||
    (a.order ?? 999) - (b.order ?? 999) ||
    a.slug.localeCompare(b.slug)
  );
}

export function nextLabs(
  steps: readonly NextStep[] | null | undefined,
  states: readonly NextState[],
  plan: Plan,
  opts: { skipped?: ReadonlySet<string>; skills?: readonly SkillDef[] } = {}
): NextLabs {
  const skills = opts.skills ?? SKILLS;
  const skipped = opts.skipped ?? new Set<string>();
  const active = states.filter((s) => s.lab.archived !== true).sort((a, b) => compareCandidates(a.lab, b.lab));
  const bySlug = new Map(active.map((s) => [s.lab.slug, s.lab] as const));
  const done = new Set(active.filter((s) => s.completion !== null && s.completion !== undefined).map((s) => s.lab.slug));
  const canStart = (l: NextCandidate) => plan === 'pro' || (l.tier ?? 'pro') === 'free';
  const skillOf = (l: NextCandidate) => skillForPlacement(l.path, l.module, skills)?.id ?? null;

  const fromPath: NextCandidate[] = [];
  for (const step of steps ?? []) {
    if (step.status !== 'next' && step.status !== 'upcoming') continue;
    const lab = bySlug.get(step.slug);
    if (lab && !done.has(lab.slug) && canStart(lab) && !fromPath.includes(lab)) fromPath.push(lab);
  }
  const met = (p: string) => !bySlug.has(p) || done.has(p) || skipped.has(p);
  const fromCatalogue = active
    .map((s) => s.lab)
    .filter((l) => !done.has(l.slug) && canStart(l) && !skipped.has(l.slug) && (l.prerequisites ?? []).every(met));

  const ref = (l: NextCandidate | undefined): NextLab | null =>
    l ? { slug: l.slug, title: l.title, skill: skillOf(l), path: l.path ?? null, module: l.module ?? null } : null;
  const pick = (keep: (l: NextCandidate) => boolean) => ref(fromPath.find(keep) ?? fromCatalogue.find(keep));

  const bySkill: Record<string, NextLab | null> = {};
  for (const s of skills) bySkill[s.id] = pick((l) => skillOf(l) === s.id);
  return { overall: pick(() => true), bySkill };
}
