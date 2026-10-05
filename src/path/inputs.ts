import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { QUIZ_SKILLS } from '../skills';
import type { AreaLevel } from './rules';

/** What the learner told us, as stored in `user_profile_inputs`. */
export interface PathInputs {
  /** Quiz level per area. Only areas the quiz knows; one the learner skipped is simply absent. */
  areas: Record<string, AreaLevel>;
  goal_text: string | null;
  goal_kind: 'role-ready' | 'specific-skill' | 'explore';
  hours_per_week: number;
}

export const GOAL_KINDS = ['role-ready', 'specific-skill', 'explore'] as const;
export const GOAL_TEXT_MAX = 200;
export const HOURS_MIN = 1;
export const HOURS_MAX = 20;

/**
 * The console stores the quiz outcome as 'strong' | 'ok' | 'new'
 * (dashboard/src/learn-model.js); the path speaks of 'familiar'. Both are
 * accepted and 'ok' is stored as 'familiar'.
 */
const level = z.enum(['new', 'familiar', 'ok', 'strong']).transform((l): AreaLevel => (l === 'ok' ? 'familiar' : l));

export const pathInputsSchema = z
  .object({
    areas: z.record(z.string(), level).superRefine((areas, ctx) => {
      // Only skills the onboarding quiz asks about take a level (src/skills.ts `quiz`).
      const quiz = QUIZ_SKILLS.map((s) => s.id);
      for (const key of Object.keys(areas)) {
        if (!quiz.includes(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown area "${key}"; the quiz areas are ${quiz.join(', ')}`, path: [key] });
      }
    }),
    goal_text: z
      .string()
      .max(GOAL_TEXT_MAX, `goal_text is at most ${GOAL_TEXT_MAX} characters`)
      .nullish()
      // Whitespace and control characters collapse to single spaces; an empty goal is no goal.
      .transform((t) => (t ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim() || null),
    goal_kind: z.enum(GOAL_KINDS).default('explore'),
    hours_per_week: z.number().int().min(HOURS_MIN).max(HOURS_MAX),
  })
  .strict();

/** Validates a request body; a bad one is `400 invalid_path_inputs` naming each problem. */
export function parsePathInputs(body: unknown): PathInputs {
  const result = pathInputsSchema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw ApiError.badRequest('invalid_path_inputs', issues.map((i) => `${i.path || 'body'}: ${i.message}`).join('; '), { issues });
  }
  return result.data;
}
