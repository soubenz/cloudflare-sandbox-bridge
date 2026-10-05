import pathsMeta from '../packages/catalogue/paths.json';
import concepts from '../packages/catalogue/concepts.json';

/**
 * The skills a learner is scored on: ONE list, derived from
 * packages/catalogue/paths.json. A skill is a module of a path that has
 * modules (the AI platform path), or a whole path that has none (its labs are
 * all module 1). So every published lab feeds exactly one skill, and a new
 * module or path gets a skill by naming one in that file.
 *
 * Titles, icons and accents are the module's or the path's: they are never
 * stored a second time. Ids never change (stored quiz levels, concept ids
 * `<skill>.<name>` and earned awards such as `area-proficient-gateway` are
 * keyed by them), and they are single lowercase words, which is what the
 * console's and the profile route's id patterns accept.
 *
 * `quiz` marks the skills the onboarding quiz has questions on
 * (packages/catalogue/concepts.json `quiz`): only those take a quiz level.
 *
 * dashboard/src/skills.js derives the same list for the console;
 * test/unit/skills.test.ts keeps the two equal.
 */

export interface SkillDef {
  /** Stable id: the module's or the flat path's `skill`. */
  id: string;
  /** The module's title, or the path's for a path without modules. */
  title: string;
  path: string;
  /** The module number, or null for a whole path. */
  module: number | null;
  icon: string;
  accent: string;
  /** True when the onboarding quiz asks about this skill (and so it can carry a quiz level). */
  quiz: boolean;
}

interface ModuleMeta {
  number: number;
  title: string;
  skill?: string;
  icon?: string;
  accent?: string;
}
interface PathMeta {
  slug: string;
  title: string;
  skill?: string;
  icon?: string;
  accent?: string;
  modules?: ModuleMeta[];
}

const SKILL_ID = /^[a-z]+$/;

/** Builds the list from the paths file and the quiz list. Exported for the tests; everything else uses SKILLS. */
export function deriveSkills(meta: { paths: readonly PathMeta[] }, quiz: readonly string[]): SkillDef[] {
  const asked = new Set(quiz);
  const out: SkillDef[] = [];
  const add = (id: string | undefined, title: string, path: string, module: number | null, icon: string | undefined, accent: string | undefined) => {
    if (!id || !SKILL_ID.test(id)) throw new Error(`paths.json: ${path}${module === null ? '' : ` module ${module}`} needs a "skill" id of lowercase letters`);
    if (out.some((s) => s.id === id)) throw new Error(`paths.json: skill "${id}" is named twice`);
    out.push({ id, title, path, module, icon: icon || 'grid', accent: accent || 'slate', quiz: asked.has(id) });
  };
  for (const p of meta.paths) {
    const modules = p.modules ?? [];
    if (modules.length === 0) add(p.skill, p.title, p.slug, null, p.icon, p.accent);
    else for (const m of [...modules].sort((a, b) => a.number - b.number)) add(m.skill, m.title, p.slug, m.number, m.icon, m.accent);
  }
  return out;
}

/** Every skill, in the order of packages/catalogue/paths.json (paths, then modules by number): the profile's order. */
export const SKILLS: readonly SkillDef[] = deriveSkills(pathsMeta as unknown as { paths: PathMeta[] }, concepts.quiz);

/**
 * The skill a lab placement feeds: the module's skill on a path with modules,
 * the path's own on a path without. Undefined for a lab with no path, a path
 * the catalogue copy does not describe, or a module it does not list.
 */
export function skillForPlacement(path: string | undefined, module: number | undefined, skills: readonly SkillDef[] = SKILLS): SkillDef | undefined {
  if (path === undefined) return undefined;
  const inPath = skills.filter((s) => s.path === path);
  const whole = inPath.find((s) => s.module === null);
  if (whole) return whole;
  if (module === undefined) return undefined;
  return inPath.find((s) => s.module === module);
}

export function skillById(id: string, skills: readonly SkillDef[] = SKILLS): SkillDef | undefined {
  return skills.find((s) => s.id === id);
}

/** The skills the onboarding quiz asks about: the only ones a quiz level may name. */
export const QUIZ_SKILLS: readonly SkillDef[] = SKILLS.filter((s) => s.quiz);
