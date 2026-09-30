import { z } from 'zod';
import type { Env } from '../env';
import { ApiError } from '../lib/errors';

/**
 * Anonymous answer analytics for the learning layer: which quiz questions do
 * learners get right? Rows go to D1 `learn_answers` (migrations/
 * 0008_learn_answers.sql) with no user id, no session id and no IP.
 *
 * The console Worker calls POST /learn/answers with the service key after a
 * learner finishes the onboarding quiz or a lab's "Before you begin" quiz.
 * The schema is `.strict()` on purpose: a body carrying a `user_id`, `email`
 * or anything else is a 400, so an identifier cannot reach this table by
 * accident on the console's side.
 */

export const MAX_ANSWERS_PER_REQUEST = 60;

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const QUESTION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const CONCEPT_ID = /^[a-z]+\.[a-z0-9]+(-[a-z0-9]+)*$/;

export const AnswerItemSchema = z
  .object({
    question_id: z.string().regex(QUESTION_ID, 'question_id: lowercase letters, digits and hyphens'),
    concept: z.string().max(80).regex(CONCEPT_ID, 'concept: an id like area.some-name'),
    correct: z.boolean(),
    phase: z.enum(['onboarding', 'diagnostic']),
  })
  .strict();

export const AnswersBodySchema = z
  .object({
    lab_slug: z.string().regex(SLUG, 'lab_slug: not a lab slug').optional(),
    lab_version: z.string().regex(VERSION, 'lab_version: a semver such as 1.2.0').optional(),
    answers: z.array(AnswerItemSchema).min(1).max(MAX_ANSWERS_PER_REQUEST),
  })
  .strict();

export type AnswersBody = z.infer<typeof AnswersBodySchema>;

/** Validates a `POST /learn/answers` body; throws `400 bad_answers` naming every problem. */
export function parseAnswersBody(raw: unknown): AnswersBody {
  const parsed = AnswersBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest('bad_answers', parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

/**
 * Inserts every answer in one D1 batch (a transaction: all rows or none).
 * One statement per row rather than one multi-row INSERT, because D1 allows
 * at most 100 bound parameters per statement and 60 rows of 6 would not fit.
 */
export async function recordAnswers(env: Env, body: AnswersBody, now: number = Date.now()): Promise<number> {
  const stmt = env.DB.prepare(
    `INSERT INTO learn_answers (lab_slug, lab_version, question_id, concept, correct, phase, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  await env.DB.batch(
    body.answers.map((a) => stmt.bind(body.lab_slug ?? null, body.lab_version ?? null, a.question_id, a.concept, a.correct ? 1 : 0, a.phase, now))
  );
  return body.answers.length;
}
