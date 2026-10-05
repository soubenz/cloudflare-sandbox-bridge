import type { Env } from '../env';
import { loadCatalogue } from '../labs/bundle';
import { loadInputs, loadPathSteps, loadPlan } from '../path/service';
import type { AreaLevel } from '../path/rules';
import { QUIZ_SKILLS } from '../skills';
import { computeProfile, pendingAwards } from './compute';
import type { CatalogueLab, EarnedAward, Profile, ProfileFacts, RunFact, SessionFact, StartingLevel, StoredAward } from './types';

/**
 * The D1 side of the profile: read the facts, write newly earned awards.
 * Everything that decides anything is in the pure modules next to this one.
 */

/** A learner with more runs than this has their oldest ones left out of the profile. Far above any real learner. */
const MAX_RUNS = 5000;

interface RunRow {
  id: string;
  session_id: string;
  lab_slug: string;
  started_at: number;
  finished_at: number | null;
  score: number | null;
  passed_all: number | null;
}

interface SessionRow {
  id: string;
  lab_slug: string;
  created_at: number;
  started_at: number | null;
  hints_delivered: number | null;
}

interface AwardRow {
  award_id: string;
  earned_at: number;
  session_id: string | null;
}

export async function buildFacts(env: Env, userId: string, now = Date.now()): Promise<ProfileFacts> {
  const [runs, sessions, earned] = await Promise.all([
    env.DB.prepare(
      `SELECT id, session_id, lab_slug, started_at, finished_at, score, passed_all
       FROM check_runs WHERE user_id = ? AND lab_slug IS NOT NULL
       ORDER BY started_at DESC LIMIT ?`
    )
      .bind(userId, MAX_RUNS)
      .all<RunRow>(),
    env.DB.prepare(
      `SELECT id, lab_slug, created_at, started_at, hints_delivered
       FROM sessions WHERE id IN (SELECT DISTINCT session_id FROM check_runs WHERE user_id = ?)`
    )
      .bind(userId)
      .all<SessionRow>(),
    env.DB.prepare(`SELECT award_id, earned_at, session_id FROM awards WHERE user_id = ?`).bind(userId).all<AwardRow>(),
  ]);
  return {
    user_id: userId,
    now,
    runs: (runs.results ?? []).map(
      (r): RunFact => ({
        run_id: r.id,
        session_id: r.session_id,
        lab_slug: r.lab_slug,
        started_at: r.started_at,
        finished_at: r.finished_at ?? null,
        score: Number(r.score ?? 0),
        passed_all: Number(r.passed_all ?? 0) > 0,
      })
    ),
    sessions: (sessions.results ?? []).map(
      (s): SessionFact => ({
        id: s.id,
        lab_slug: s.lab_slug,
        created_at: s.created_at,
        started_at: s.started_at ?? null,
        hints_delivered: Number(s.hints_delivered ?? 0),
      })
    ),
    earned: (earned.results ?? []).map((a): StoredAward => ({ award_id: a.award_id, earned_at: a.earned_at, session_id: a.session_id ?? null })),
  };
}

/** The catalogue slice the profile reads, from the published index. */
export async function loadProfileCatalogue(env: Env): Promise<CatalogueLab[]> {
  return (await loadCatalogue(env)).map((e) => ({
    slug: e.slug,
    title: e.title,
    path: e.path,
    module: e.module,
    order: e.order,
    difficulty: e.difficulty,
    estimated_minutes: e.estimated_minutes,
    prerequisites: e.prerequisites,
    tier: e.tier,
    archived: e.archived === true,
  }));
}

/** The path's 'familiar' is the console's 'ok'. */
const STARTING_OF: Record<AreaLevel, StartingLevel> = { new: 'new', familiar: 'ok', strong: 'strong' };

/**
 * What the profile reads besides runs and awards: the quiz levels stored with the learner's path inputs (quiz
 * skills only; undefined when the learner has none), their plan, and the steps of their stored path.
 */
export async function loadLearner(env: Env, userId: string): Promise<Pick<ProfileFacts, 'starting_levels' | 'plan' | 'path_steps'>> {
  const [inputs, plan, steps] = await Promise.all([loadInputs(env, userId).catch(() => null), loadPlan(env, userId), loadPathSteps(env, userId)]);
  const quiz = new Set(QUIZ_SKILLS.map((s) => s.id));
  const levels = Object.entries(inputs?.areas ?? {}).filter(([id, l]) => quiz.has(id) && l in STARTING_OF);
  return {
    starting_levels: levels.length > 0 ? Object.fromEntries(levels.map(([id, l]) => [id, STARTING_OF[l]])) : undefined,
    plan,
    path_steps: steps,
  };
}

/**
 * Stores awards, ignoring any the learner already has, and returns only the
 * ones this call actually inserted. `ON CONFLICT DO NOTHING` plus the
 * `changes` count means two recomputes racing each other announce an award once.
 */
export async function insertAwards(env: Env, userId: string, awards: readonly EarnedAward[], sessionId: string | null): Promise<EarnedAward[]> {
  const inserted: EarnedAward[] = [];
  for (const a of awards) {
    const result = await env.DB.prepare(
      `INSERT INTO awards (user_id, award_id, earned_at, session_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, award_id) DO NOTHING`
    )
      .bind(userId, a.id, a.earned_at, sessionId)
      .run();
    if ((result.meta?.changes ?? 1) > 0) inserted.push({ ...a, session_id: sessionId });
  }
  return inserted;
}

/**
 * `sessions.hints_delivered` is otherwise written when the session ends, so a
 * lab completed mid-session would read as hint-free. The run that triggers a
 * recompute records the session's live count first. It only ever raises the
 * stored number, so the end-of-session write (which is the larger or equal)
 * and this one cannot fight.
 */
export async function syncSessionHints(env: Env, sessionId: string, hints: number): Promise<void> {
  await env.DB.prepare(`UPDATE sessions SET hints_delivered = MAX(COALESCE(hints_delivered, 0), ?) WHERE id = ?`).bind(hints, sessionId).run();
}

/**
 * Computes the learner's awards from their facts and stores the new ones.
 * Idempotent: nothing is ever updated, so a second call with no new activity
 * inserts nothing and returns []. Throws on a D1 or catalogue failure; the
 * callers that must not fail (a check run) catch it.
 */
export async function recomputeAwards(env: Env, userId: string, opts: { sessionId?: string; now?: number } = {}): Promise<EarnedAward[]> {
  const [facts, catalogue, learner] = await Promise.all([buildFacts(env, userId, opts.now), loadProfileCatalogue(env), loadLearner(env, userId)]);
  const profile = computeProfile({ ...facts, ...learner }, catalogue);
  return insertAwards(env, userId, pendingAwards(profile, facts.earned), opts.sessionId ?? null);
}

/**
 * The learner's profile. As a side effect it stores any award the learner has
 * already qualified for but that no check run announced (a backfill for
 * learners from before awards existed), so the `earned_at` it shows is the
 * one that stays. That write is best effort: a failure still returns the profile.
 */
export async function loadProfile(env: Env, userId: string, opts: { starting?: Record<string, StartingLevel> | undefined; now?: number } = {}): Promise<Profile> {
  const [facts, catalogue, learner] = await Promise.all([buildFacts(env, userId, opts.now), loadProfileCatalogue(env), loadLearner(env, userId)]);
  // The quiz levels stored with the path inputs win; the console's `?starting=` is the fallback for a learner who has none.
  const profile = computeProfile({ ...facts, ...learner, starting_levels: learner.starting_levels ?? opts.starting }, catalogue);
  const pending = pendingAwards(profile, facts.earned);
  if (pending.length > 0) {
    try {
      await insertAwards(env, userId, pending, null);
    } catch (err) {
      console.error('profile award backfill failed:', err);
    }
  }
  return profile;
}
