import { z } from 'zod';
import type { Env } from '../env';
import type { CheckResultEntry, ChecksRun } from '../session/state';
import { loadCurrentManifest, loadCurrentLearn } from './bundle';
import { isWarmUp, slugPattern } from './manifest';
import { insertCheckRun } from '../session/d1';
import { recomputeAwards } from '../profile/store';
import { refreshPath } from '../path/service';
import { ApiError } from '../lib/errors';

/**
 * Finishing a warm-up. A warm-up has no container, so no checks ever run for
 * it; the console plays its games in the browser and reports here when they
 * are all solved. The completion is written as an ordinary `check_runs` row
 * that passed everything (one result per game), under a synthetic session id,
 * so every reader of "done" (progress, the path's next lab, skills, XP,
 * awards, module completion) sees it exactly like a finished lab and needs no
 * change. `check_runs` has no foreign key on `session_id`, and those readers
 * look a session up only optionally.
 */

/** The largest body read, in bytes. Six games are well under 1 KB. */
export const MAX_WARM_UP_BODY_BYTES = 16 * 1024;

/** The result name used when a warm-up has no games at all, so the row still has one passing result. */
export const WARM_UP_FINISHED = 'finished';

const WarmUpGameSchema = z.object({
  id: z.string().min(1).max(40),
  solved: z.boolean(),
  tries: z.number().int().min(0).max(10_000),
});

export const WarmUpBodySchema = z.object({
  games: z.array(WarmUpGameSchema).max(24).default([]),
  /** When the learner opened the warm-up, epoch ms; defaults to now. */
  started_at: z.number().int().positive().optional(),
});

export type WarmUpBody = z.infer<typeof WarmUpBodySchema>;

/** Throws 400 `invalid_warm_up_body` for anything that is not a warm-up completion body. */
export function parseWarmUpBody(raw: unknown): WarmUpBody {
  const parsed = WarmUpBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest('invalid_warm_up_body', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

/** A lab slug as the manifest spells them; anything else cannot name a published lab, so it is 404 `lab_not_found`. */
export function parseWarmUpSlug(raw: string | undefined): string {
  if (!raw || !slugPattern.test(raw)) throw ApiError.notFound('lab_not_found', `No published lab "${String(raw).slice(0, 80)}"`);
  return raw;
}

export type WarmUpResult = { done: true; already: true } | { done: true; already: false; run_id: string };

/** The synthetic session id a warm-up completion is filed under (no `sessions` row has it). */
export const warmUpSessionId = (uid: string, slug: string) => `warmup:${uid}:${slug}`;

/**
 * Marks a warm-up done for `uid`. 404 `lab_not_found` when unpublished, 400
 * `not_a_warm_up` for a lab with a container, 400 `warm_up_incomplete` (with
 * the missing game ids) unless every game of the current learn bundle is
 * reported solved. Idempotent: a learner who already finished it gets
 * `already: true` and nothing is written.
 */
export async function completeWarmUp(env: Env, uid: string, slug: string, body: WarmUpBody, now = Date.now()): Promise<WarmUpResult> {
  const { version, manifest } = await loadCurrentManifest(env, slug);
  if (!isWarmUp(manifest)) throw ApiError.badRequest('not_a_warm_up', `Lab "${slug}" is not a warm-up: it is finished by passing its checks`);

  // A warm-up is published with a learn part; one without is treated as having no games.
  const found = await loadCurrentLearn(env, slug);
  const gameIds = (found?.learn.games ?? []).map((g) => g.id);
  const reported = new Map(body.games.filter((g) => g.solved).map((g) => [g.id, g] as const));
  const missing = gameIds.filter((id) => !reported.has(id));
  if (missing.length > 0) {
    throw ApiError.badRequest('warm_up_incomplete', `Not every game of "${slug}" is solved: ${missing.join(', ')}`, { missing });
  }

  const prior = await env.DB.prepare(`SELECT 1 AS done FROM check_runs WHERE user_id = ? AND lab_slug = ? AND passed_all = 1 LIMIT 1`)
    .bind(uid, slug)
    .first<{ done: number }>();
  if (prior) return { done: true, already: true };

  const result = (name: string, message: string): CheckResultEntry => ({ name, pass: true, message, duration_ms: 0, exit_code: 0, timed_out: false, weight: 1 });
  const results =
    gameIds.length > 0
      ? gameIds.map((id) => {
          const tries = reported.get(id)!.tries;
          return result(id, `solved in ${tries} ${tries === 1 ? 'try' : 'tries'}`);
        })
      : [result(WARM_UP_FINISHED, 'warm-up finished')];
  const run: ChecksRun = {
    run_id: crypto.randomUUID(),
    started_at: Math.min(body.started_at ?? now, now),
    finished_at: now,
    results,
  };
  await insertCheckRun(env, warmUpSessionId(uid, slug), run, {
    user_id: uid,
    lab_slug: slug,
    lab_version: version,
    total_checks: results.length,
  });

  // Same follow-ups as a check run that completes a lab (src/session/checks.ts), and just as optional:
  // the row is written, so a failure here never fails the request. Awaited so the next read sees them.
  await recomputeAwards(env, uid, {}).catch((err) => console.error('warm-up awards recompute failed:', err));
  await refreshPath(env, uid).catch((err) => console.error('warm-up path refresh failed:', err));
  return { done: true, already: false, run_id: run.run_id };
}
