import type { Env } from '../env';
import type { SessionMeta, SnapshotEntry, ChecksRun } from './state';

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
       cost_usd = ?, llm_usd = ?, running_s = ?
     WHERE id = ?`
  )
    .bind(...base, cost.cost_usd, cost.llm_usd, cost.running_s, meta.id)
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

export async function insertCheckRun(env: Env, sessionId: string, run: ChecksRun): Promise<void> {
  const passed = run.results.filter((r) => r.pass).length;
  await env.DB.prepare(
    `INSERT INTO check_runs (id, session_id, started_at, finished_at, passed, total, results_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(run.run_id, sessionId, run.started_at, run.finished_at ?? null, passed, run.results.length, JSON.stringify(run.results))
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
