import { SKILLS, skillById, skillForPlacement, type SkillDef } from '../skills';

/**
 * The skill areas of a learner's profile, and which labs feed each one: the
 * one skill list of src/skills.ts (derived from packages/catalogue/paths.json),
 * under the names the profile code has always used. Every published lab feeds
 * exactly one skill (test/unit/skills.test.ts).
 */

export type SkillArea = SkillDef;

/** In the order of packages/catalogue/paths.json, which is the order the profile shows them. */
export const AREAS: readonly SkillArea[] = SKILLS;

/** The skill a lab placement feeds, or undefined for a lab with no placement the catalogue copy knows. */
export function areaForPlacement(placement: { path?: string | undefined; module?: number | undefined }): SkillArea | undefined {
  return skillForPlacement(placement.path, placement.module);
}

export function areaById(id: string): SkillArea | undefined {
  return skillById(id);
}
