/**
 * The skills a learner is scored on, for the console: the same list as the server's src/skills.ts, derived the
 * same way from packages/catalogue/paths.json (a module of a path with modules, or a whole path without), with
 * `quiz` from packages/catalogue/concepts.json. test/unit/skills.test.ts keeps the two equal.
 *
 *   [{ id, title, path, module (number | null), icon, accent, quiz }]
 *
 * Titles, icons and accents are always the module's or the path's own. No DOM.
 */
import pathMeta from '../../packages/catalogue/paths.json';
import concepts from '../../packages/catalogue/concepts.json';

const SKILL_ID = /^[a-z]+$/;

/** The list from a paths file and a quiz list; a module or path without a valid `skill` id is left out. */
export function deriveSkills(meta = pathMeta, quiz = concepts.quiz) {
  const asked = new Set(Array.isArray(quiz) ? quiz : []);
  const out = [];
  const add = (id, title, path, module, icon, accent) => {
    if (typeof id !== 'string' || !SKILL_ID.test(id) || out.some((s) => s.id === id)) return;
    out.push({ id, title: String(title ?? id), path, module, icon: icon || 'grid', accent: accent || 'slate', quiz: asked.has(id) });
  };
  for (const p of Array.isArray(meta?.paths) ? meta.paths : []) {
    const modules = Array.isArray(p.modules) ? p.modules : [];
    if (modules.length === 0) add(p.skill, p.title, p.slug, null, p.icon, p.accent);
    else for (const m of [...modules].sort((a, b) => a.number - b.number)) add(m.skill, m.title, p.slug, Number(m.number), m.icon, m.accent);
  }
  return out;
}

/** Every skill, in the order of paths.json: the profile's order. */
export const SKILLS = deriveSkills();

/** The skill a lab placement feeds: the module's on a path with modules, the path's own on one without; or null. */
export function skillForPlacement(path, module, skills = SKILLS) {
  if (typeof path !== 'string' || !path) return null;
  const inPath = skills.filter((s) => s.path === path);
  const whole = inPath.find((s) => s.module === null);
  if (whole) return whole;
  const n = Number(module);
  return Number.isFinite(n) ? (inPath.find((s) => s.module === n) ?? null) : null;
}

export function skillById(id, skills = SKILLS) {
  return skills.find((s) => s.id === id) ?? null;
}

/** The icon and accent family of a skill, by id (a slate grid for an id the list does not know). */
export function skillLook(id, skills = SKILLS) {
  const s = skillById(id, skills);
  return { icon: s?.icon || 'grid', accent: s?.accent || 'slate' };
}
