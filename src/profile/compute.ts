import pathsMeta from '../../packages/catalogue/paths.json';
import { AREAS } from './areas';
import { awardDefinitions, type AwardContext, type GroupProgress } from './awards';
import { comebackAt, deriveLabStates, deriveStreak, type Completion, type LabState } from './derive';
import { evaluateArea, evaluateOverall } from './evaluation';
import { areaScore, overallScore, skillLevel } from './scoring';
import { totalXp, xpLevel } from './xp';
import type { CatalogueLab, CompactProfile, EarnedAward, LockedAward, Profile, ProfileFacts, Skill } from './types';

/**
 * The whole profile as a pure function of the learner's facts and the
 * catalogue. Same inputs, same output: it reads neither D1 nor the clock
 * (`facts.now` is the clock), so every rule can be tested with plain objects.
 */

interface PathMeta {
  slug: string;
  title: string;
  modules: Array<{ number: number; title: string }>;
}
const PATHS = (pathsMeta as unknown as { paths: PathMeta[] }).paths;

function humanize(slug: string): string {
  const words = slug.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const pathTitle = (slug: string) => PATHS.find((p) => p.slug === slug)?.title ?? humanize(slug);
const moduleTitle = (path: string, n: number) => PATHS.find((p) => p.slug === path)?.modules.find((m) => m.number === n)?.title ?? `${pathTitle(path)}, module ${n}`;

function groupProgress(key: string, title: string, states: readonly LabState[]): GroupProgress {
  const done = states.filter((s) => s.completion !== null);
  const all = states.length > 0 && done.length === states.length;
  return {
    key,
    title,
    total: states.length,
    done: done.length,
    completed_at: all ? Math.max(...done.map((s) => s.completion!.at)) : null,
  };
}

/** Modules (of paths with more than one module) and paths, with how many of their labs are done. */
export function deriveGroups(states: readonly LabState[]): { modules: GroupProgress[]; paths: GroupProgress[] } {
  const byPath = new Map<string, LabState[]>();
  for (const s of states) {
    if (s.lab.path === undefined) continue;
    const list = byPath.get(s.lab.path);
    if (list) list.push(s);
    else byPath.set(s.lab.path, [s]);
  }
  const modules: GroupProgress[] = [];
  const paths: GroupProgress[] = [];
  for (const [path, members] of byPath) {
    paths.push(groupProgress(path, pathTitle(path), members));
    const numbers = [...new Set(members.map((s) => s.lab.module ?? 1))].sort((a, b) => a - b);
    if (numbers.length < 2) continue;
    for (const n of numbers) {
      modules.push(groupProgress(`${path}-${n}`, moduleTitle(path, n), members.filter((s) => (s.lab.module ?? 1) === n)));
    }
  }
  return { modules, paths };
}

/** First unfinished lab in catalogue order whose prerequisites are done; failing that, the first unfinished one. */
function nextLabOf(areaStates: readonly LabState[], doneSlugs: ReadonlySet<string>): CatalogueLab | null {
  const open = areaStates.filter((s) => s.completion === null).map((s) => s.lab);
  return open.find((l) => (l.prerequisites ?? []).every((p) => doneSlugs.has(p))) ?? open[0] ?? null;
}

export function computeProfile(facts: ProfileFacts, catalogue: readonly CatalogueLab[]): Profile {
  const states = deriveLabStates(facts, catalogue);
  const doneSlugs = new Set(states.filter((s) => s.completion).map((s) => s.lab.slug));

  const skills: Skill[] = AREAS.map((area) => {
    const mine = states.filter((s) => s.area?.id === area.id);
    const score = areaScore(mine);
    const level = skillLevel(score);
    const next = nextLabOf(mine, doneSlugs);
    const finished = mine.filter((s) => s.completion);
    const labs_done = finished.length;
    const labs_total = mine.length;
    return {
      area: area.id,
      title: area.title,
      score,
      level,
      evaluation: evaluateArea({
        title: area.title,
        level,
        labsDone: labs_done,
        labsTotal: labs_total,
        attempted: mine.some((s) => s.runs > 0),
        nextLab: next?.title ?? null,
        usedHints: finished.some((s) => s.completion!.hints > 0),
        retried: finished.some((s) => s.completion!.attempts > 1),
      }),
      labs_done,
      labs_total,
      next_lab: next ? { slug: next.slug, title: next.title } : null,
      starting_level: facts.starting_levels?.[area.id] ?? null,
    };
  });

  const overall = overallScore(skills.map((s) => s.score));
  const overallLevel = skillLevel(overall);
  const xp = totalXp(states);
  const { streak } = deriveStreak(facts.runs, facts.now);

  // Awards. A stored award always shows as earned, with the date it was stored.
  const completions: Completion[] = states.flatMap((s) => (s.completion ? [s.completion] : [])).sort((a, b) => a.at - b.at || a.slug.localeCompare(b.slug));
  const groups = deriveGroups(states);
  const ctx: AwardContext = {
    now: facts.now,
    completions,
    streak,
    areas: skills.map((s) => ({ id: s.area, title: s.title, score: s.score })),
    modules: groups.modules,
    paths: groups.paths,
    comeback_at: comebackAt(facts.runs),
  };
  const stored = new Map(facts.earned.map((a) => [a.award_id, a]));
  const earned: EarnedAward[] = [];
  const locked: LockedAward[] = [];
  for (const def of awardDefinitions(ctx)) {
    const base = { id: def.id, title: def.title, description: def.description, icon: def.icon, tier: def.tier };
    const row = stored.get(def.id);
    if (row) {
      earned.push({ ...base, earned_at: row.earned_at, session_id: row.session_id });
      continue;
    }
    const result = def.evaluate(ctx);
    if (result.earned) earned.push({ ...base, earned_at: result.at ?? facts.now, session_id: null });
    else locked.push({ ...base, progress: { have: result.have, need: result.need } });
  }
  earned.sort((a, b) => b.earned_at - a.earned_at); // newest first; the sort is stable, so ties keep display order

  return {
    user_id: facts.user_id,
    xp,
    level: xpLevel(xp),
    streak,
    skills,
    awards: { earned, locked },
    overall: {
      score: overall,
      level: overallLevel,
      evaluation: evaluateOverall({ level: overallLevel, attempted: states.some((s) => s.runs > 0), areas: skills }),
    },
    updated_at: facts.now,
  };
}

/** Awards the profile shows as earned that are not stored yet: what `recomputeAwards` has to insert. */
export function pendingAwards(profile: Profile, stored: readonly { award_id: string }[]): EarnedAward[] {
  const have = new Set(stored.map((a) => a.award_id));
  return profile.awards.earned.filter((a) => !have.has(a.id));
}

/** The Home widget's slice: overall, XP level, streak, the top three skills, the last three awards. */
export function compactProfile(profile: Profile): CompactProfile {
  const top = profile.skills
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
    .slice(0, 3)
    .map(({ s }) => ({ area: s.area, title: s.title, score: s.score, level: s.level }));
  return {
    user_id: profile.user_id,
    overall: profile.overall,
    level: profile.level,
    xp: profile.xp,
    streak: profile.streak,
    top_skills: top,
    recent_awards: profile.awards.earned.slice(0, 3),
    updated_at: profile.updated_at,
  };
}
