/**
 * The skill areas of a learner's profile, and which labs feed each one.
 *
 * The six areas are the six areas of the platform onboarding quiz
 * (packages/catalogue/onboarding.json), with the titles of
 * packages/catalogue/concepts.json. A lab belongs to an area through its
 * catalogue placement (`path` + `module`): the table below is the ONE place
 * that mapping lives. A unit test keeps it equal to the quiz and the concepts
 * file, and fails when a published lab sits in a module that is neither
 * mapped here nor listed in UNMAPPED_MODULES, so adding a module forces a
 * decision rather than silently scoring nothing.
 */

export interface SkillArea {
  /** The area id used by the onboarding quiz and the concepts file. */
  id: string;
  /** What a learner sees. */
  title: string;
  path: string;
  module: number;
}

/** In the order the onboarding quiz lists them, which is the order the profile shows them. */
export const AREAS: readonly SkillArea[] = [
  { id: 'gateway', title: 'LLM gateway', path: 'ai-platform', module: 1 },
  { id: 'mcp', title: 'Tools and MCP', path: 'ai-platform', module: 2 },
  { id: 'rag', title: 'Retrieval', path: 'ai-platform', module: 3 },
  { id: 'otel', title: 'Tracing and cost', path: 'ai-platform', module: 4 },
  { id: 'platform', title: 'Self-service platform', path: 'ai-platform', module: 6 },
  { id: 'sovereignty', title: 'Data sovereignty', path: 'ai-platform', module: 7 },
];

/**
 * Published modules that deliberately feed no area. Their labs still earn XP
 * and count toward awards; they just do not move a skill score.
 */
export const UNMAPPED_MODULES: ReadonlyArray<{ path: string; module: number; why: string }> = [
  { path: 'ai-platform', module: 5, why: 'Optional runtime and durability module; the quiz has no area for it' },
  { path: 'production-agents', module: 1, why: 'Agent reliability labs; not one of the six platform areas' },
  { path: 'securing-agents', module: 1, why: 'Agent security labs; not one of the six platform areas' },
  { path: 'evals-releases', module: 1, why: 'Evaluation labs; not one of the six platform areas' },
];

/** The area a lab placement feeds, or undefined for a lab with no placement or an unmapped module. */
export function areaForPlacement(placement: { path?: string | undefined; module?: number | undefined }): SkillArea | undefined {
  if (placement.path === undefined || placement.module === undefined) return undefined;
  return AREAS.find((a) => a.path === placement.path && a.module === placement.module);
}

export function areaById(id: string): SkillArea | undefined {
  return AREAS.find((a) => a.id === id);
}
