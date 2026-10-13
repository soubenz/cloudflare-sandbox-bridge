import { z } from 'zod';
import type { Env } from '../env';
import { ApiError } from '../lib/errors';

/**
 * Where a learner is in a lab's pre-lab flow ("Before you begin") or in a warm-up, kept per user per
 * lab so it survives a closed tab, another browser and another device. The console owns the shape:
 * the API checks it is a flow record of sane size (zod, 32 KiB) and stores it as it came, with the
 * learn bundle version it was planned against. See docs/api.md ("Learn progress") and
 * docs/learning-content.md ("Saving progress").
 */

/** The largest PUT body read, in bytes. A whole flow (a dozen steps, thirty answers, the lesson pages) is a few KiB. */
export const MAX_LEARN_PROGRESS_BYTES = 32 * 1024;

const Id = z.string().min(1).max(80);
const Count = z.number().int().min(0).max(1000);
/** A record of at most `max` entries. */
const capped = <T extends z.ZodTypeAny>(value: T, max: number, keyMax = 200) =>
  z.record(z.string().max(keyMax), value).refine((r) => Object.keys(r).length <= max, { message: `at most ${max} entries` });

const StepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('story'), closing: z.boolean().optional() }),
  z.object({ kind: z.literal('round'), round: Count, rounds: Count, questions: z.array(Id).min(1).max(60) }),
  z.object({
    kind: z.literal('lessons'),
    part: Count,
    parts: Count,
    concepts: z.array(Id).min(1).max(60),
    plan: z.array(z.object({ concept: Id, state: z.string().max(24) })).max(60).default([]),
  }),
  z.object({ kind: z.literal('game'), game: Id }),
]);

const AnswerSchema = z.object({
  question_id: Id,
  concept: Id,
  correct: z.boolean(),
  selected: z.array(z.string().max(80)).max(20).default([]),
  unsure: z.boolean().optional(),
});

const GameSchema = z.object({ id: Id, tries: Count, skipped: z.boolean().optional() });

/** The lessons pager's memory: the lesson each chunk was on (keyed by the chunk's concept ids), the page of each lesson, the lessons read. */
const LessonPagesSchema = z.object({
  at: capped(Id, 60, 2000).default({}),
  pages: capped(Count, 120).default({}),
  read: z.array(Id).max(120).default([]),
});

export const LearnProgressStateSchema = z.object({
  v: z.literal(1),
  steps: z.array(StepSchema).min(1).max(64),
  /** The step on screen (0-based). */
  at: z.number().int().min(0).max(63),
  answers: capped(AnswerSchema, 120).default({}),
  /** A warm-up's games solved or skipped so far. */
  games: capped(GameSchema, 24).optional(),
  /** When the warm-up was opened, epoch ms. */
  started_at: z.number().int().positive().optional(),
  lessons: LessonPagesSchema.optional(),
  /** The name of the step on screen, so a page without the bundle can say "Step 3 of 7: Lessons". */
  label: z.string().max(200).optional(),
});

export const LearnProgressBodySchema = z.object({
  /** The learn bundle version the steps were planned against. */
  version: z.string().min(1).max(64),
  state: LearnProgressStateSchema,
});

export type LearnProgressBody = z.infer<typeof LearnProgressBodySchema>;
export type LearnProgressState = z.infer<typeof LearnProgressStateSchema>;
export interface LearnProgress {
  version: string;
  state: LearnProgressState;
  updated_at: number;
}

/** Throws 400 `invalid_learn_progress` for anything that is not `{ version, state }` as above. */
export function parseLearnProgressBody(raw: unknown): LearnProgressBody {
  const parsed = LearnProgressBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest('invalid_learn_progress', parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  const { state } = parsed.data;
  if (state.at >= state.steps.length) throw ApiError.badRequest('invalid_learn_progress', 'state.at: past the last step');
  return parsed.data;
}

/** The saved progress of `uid` on `slug`, or null. A row that no longer parses (it never should) reads as none. */
export async function loadLearnProgress(env: Env, uid: string, slug: string): Promise<LearnProgress | null> {
  const row = await env.DB.prepare(`SELECT version, state_json, updated_at FROM learn_progress WHERE user_id = ? AND slug = ?`)
    .bind(uid, slug)
    .first<{ version: string; state_json: string; updated_at: number }>();
  if (!row) return null;
  try {
    const state = LearnProgressStateSchema.parse(JSON.parse(row.state_json));
    return { version: row.version, state, updated_at: row.updated_at };
  } catch {
    return null;
  }
}

/** Replaces the saved progress of `uid` on `slug`. */
export async function saveLearnProgress(env: Env, uid: string, slug: string, body: LearnProgressBody, now = Date.now()): Promise<{ saved: true; updated_at: number }> {
  await env.DB.prepare(
    `INSERT INTO learn_progress (user_id, slug, version, state_json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, slug) DO UPDATE SET version = excluded.version, state_json = excluded.state_json, updated_at = excluded.updated_at`
  )
    .bind(uid, slug, body.version, JSON.stringify(body.state), now)
    .run();
  return { saved: true, updated_at: now };
}

/** Forgets the saved progress of `uid` on `slug` (start over, or done). Whether there was any. */
export async function deleteLearnProgress(env: Env, uid: string, slug: string): Promise<boolean> {
  const res = await env.DB.prepare(`DELETE FROM learn_progress WHERE user_id = ? AND slug = ?`).bind(uid, slug).run();
  return (res.meta?.changes ?? 0) > 0;
}
