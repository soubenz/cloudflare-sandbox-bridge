import type { Env } from '../env';
import type { SessionMeta, SnapshotEntry, ChecksRun } from './state';
import { scoreRun } from './progress';
import { newId } from '../lib/ids';

/**
 * D1 is an index for cross-session queries the app needs (one active
 * session per user, a user's history, lab pass/fail stats) — never the
 * source of truth for a live session, which is always the Session DO. Every
 * write here is best-effort: a D1 failure must never fail the session
 * operation that triggered it, so callers fire-and-forget with `void
 * upsertSession(...).catch(...)` rather than awaiting inline on the
 * critical path. The one exception is the initial insert in `POST
 * /sessions`, which IS awaited because its unique-index conflict is how the
 * one-session-per-user fence is enforced (see router.ts).
 */
export async function insertSession(env: Env, meta: SessionMeta): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, lab_slug, lab_version, family, state, sandbox_id, created_at, started_at, expires_at, ended_at, end_reason, resumed_count, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      meta.id,
      meta.user_id,
      meta.lab_slug,
      meta.lab_version,
      meta.family,
      meta.state,
      meta.sandbox_id ?? null,
      meta.created_at,
      meta.started_at ?? null,
      meta.expires_at ?? null,
      meta.ended_at ?? null,
      meta.end_reason ?? null,
      meta.resumed_count,
      meta.ip_hash ?? null
    )
    .run();
}

/** Final cost of a session, written to D1 when it ends (columns added in migration 0005). */
export interface SessionCostRow {
  cost_usd: number;
  llm_usd: number;
  running_s: number;
  /** Hints that had unlocked by the end (column added in migration 0005). */
  hints_delivered?: number;
}

export async function updateSession(env: Env, meta: SessionMeta, cost?: SessionCostRow): Promise<void> {
  const base = [meta.state, meta.sandbox_id ?? null, meta.started_at ?? null, meta.expires_at ?? null, meta.ended_at ?? null, meta.end_reason ?? null, meta.resumed_count];
  if (!cost) {
    await env.DB.prepare(
      `UPDATE sessions SET state = ?, sandbox_id = ?, started_at = ?, expires_at = ?, ended_at = ?, end_reason = ?, resumed_count = ?
       WHERE id = ?`
    )
      .bind(...base, meta.id)
      .run();
    return;
  }
  await env.DB.prepare(
    `UPDATE sessions SET state = ?, sandbox_id = ?, started_at = ?, expires_at = ?, ended_at = ?, end_reason = ?, resumed_count = ?,
       cost_usd = ?, llm_usd = ?, running_s = ?, hints_delivered = ?
     WHERE id = ?`
  )
    .bind(...base, cost.cost_usd, cost.llm_usd, cost.running_s, cost.hints_delivered ?? null, meta.id)
    .run();
}

export async function insertSnapshot(env: Env, sessionId: string, userId: string, labSlug: string, snapshot: SnapshotEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO snapshots (id, session_id, user_id, lab_slug, backup_id, dir, name, ttl_s, created_at, expires_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      `${sessionId}:${snapshot.backup_id}`,
      sessionId,
      userId,
      labSlug,
      snapshot.backup_id,
      snapshot.dir,
      snapshot.name ?? null,
      snapshot.ttl,
      snapshot.created_at,
      snapshot.created_at + snapshot.ttl * 1000,
      snapshot.reason
    )
    .run();
}

/** Who a check run belongs to; copied onto the row so progress needs no join through `sessions`. */
export interface CheckRunOwner {
  user_id: string;
  lab_slug: string;
  lab_version: string;
  /** How many checks the lab defines; a run of fewer (`only`) is never `passed_all`. */
  total_checks?: number;
}

/** The bound parameters of the `check_runs` INSERT, in column order. Pure, so it can be asserted on. */
export function checkRunParams(sessionId: string, run: ChecksRun, owner: CheckRunOwner): unknown[] {
  const { passed, total, score, passed_all } = scoreRun(run.results, owner.total_checks);
  return [
    run.run_id,
    sessionId,
    run.started_at,
    run.finished_at ?? null,
    passed,
    total,
    JSON.stringify(run.results),
    owner.user_id,
    owner.lab_slug,
    owner.lab_version,
    score,
    passed_all ? 1 : 0,
  ];
}

export async function insertCheckRun(env: Env, sessionId: string, run: ChecksRun, owner: CheckRunOwner): Promise<void> {
  const params = checkRunParams(sessionId, run, owner);
  await env.DB.prepare(
    `INSERT INTO check_runs (id, session_id, started_at, finished_at, passed, total, results_json, user_id, lab_slug, lab_version, score, passed_all)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(...params)
    .run();
  // The first run that passes everything is when the session's lab was completed.
  if (params[11] === 1) {
    await env.DB.prepare(`UPDATE sessions SET completed_at = COALESCE(completed_at, ?) WHERE id = ?`)
      .bind(run.finished_at ?? Date.now(), sessionId)
      .run();
  }
}

/** Creates or replaces a session's feedback (one row per session). */
export async function upsertFeedback(
  env: Env,
  fb: { session_id: string; user_id: string; lab_slug: string; rating: number; text: string | null },
  now = Date.now()
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO feedback (id, session_id, user_id, lab_slug, rating, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET rating = excluded.rating, text = excluded.text, created_at = excluded.created_at`
  )
    .bind(newId(), fb.session_id, fb.user_id, fb.lab_slug, fb.rating, fb.text, now)
    .run();
}

// --- Reconciliation of D1 with the Session DO (B-18) ---
//
// The unique index `sessions_active_user` locks a user out for as long as a
// row says active. A row can be stuck active when the DO never got created,
// or ended without D1 hearing of it, so these helpers let the router and the
// hourly sweeper close such rows once the DO has been asked.

/** True only for the unique-index violation on the one-active-session-per-user fence, not for any other D1 failure. */
export function isActiveSessionConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(message) || message.includes('sessions_active_user');
}

const ACTIVE_STATES_SQL = `('starting','running','recovering','resuming')`;

/** The active rows of one user (there is at most one, by the unique index). */
export async function activeSessionRows(env: Env, userId: string): Promise<Array<{ id: string; state: string }>> {
  const result = await env.DB.prepare(`SELECT id, state FROM sessions WHERE user_id = ? AND state IN ${ACTIVE_STATES_SQL}`)
    .bind(userId)
    .all<{ id: string; state: string }>();
  return result.results ?? [];
}

/** Active-looking rows older than `olderThanMs`, oldest first, for the sweeper. */
export async function staleActiveRows(env: Env, olderThanMs: number, limit = 100): Promise<Array<{ id: string }>> {
  const result = await env.DB.prepare(
    `SELECT id FROM sessions WHERE state IN ('starting','running') AND created_at < ? ORDER BY created_at ASC LIMIT ?`
  )
    .bind(olderThanMs, limit)
    .all<{ id: string }>();
  return result.results ?? [];
}

/**
 * Closes a row that still looks active. `ended_at` and `end_reason` keep
 * whatever the row (or the DO's meta, passed in) already says; without either
 * it was never a real session, so it ends now with reason `error`.
 */
export async function healSessionRow(
  env: Env,
  id: string,
  ended: { ended_at?: number; end_reason?: string } = {},
  now = Date.now()
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET state = 'ended', ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?)
     WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
  )
    .bind(ended.ended_at ?? now, ended.end_reason ?? 'error', id)
    .run();
}

/**
 * Deletes `snapshots` rows whose TTL has passed and returns how many went.
 * This removes the D1 index rows only; the R2 objects are deleted by the
 * bucket lifecycle rule (see docs/runbooks/backups.md). Throws on D1 failure
 * like the other writers here — the caller decides how to absorb it.
 */
export async function deleteExpiredSnapshots(env: Env, nowMs: number): Promise<number> {
  const result = await env.DB.prepare(`DELETE FROM snapshots WHERE expires_at < ?`).bind(nowMs).run();
  return result.meta?.changes ?? 0;
}

/** The cron fires every 5 minutes; sweep only in the first run of each UTC hour (minute 0-4). */
export function shouldSweepSnapshots(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() < 5;
}

/** Wraps a D1 write so a failure logs instead of throwing — see file-level doc above. */
export function bestEffort(promise: Promise<unknown>, what: string): void {
  promise.catch((err) => console.error(`d1 best-effort write failed (${what}):`, err));
}
