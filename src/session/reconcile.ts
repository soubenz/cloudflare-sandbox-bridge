import type { Env } from '../env';
import { activeSessionRows, healSessionRow, staleActiveRows } from './d1';

/**
 * D1 says a session is active, the Session DO is the truth. These helpers
 * ask the DO and close the D1 row when the DO has ended or never existed,
 * so a stuck row cannot lock its user out through the unique index.
 */

/** Active rows older than this are checked by the hourly sweeper. A lab caps at 120 minutes, so anything older is suspect. */
export const STALE_ACTIVE_AFTER_MS = 3 * 60 * 60 * 1000;

export type RowVerdict = 'live' | 'healed';

/**
 * Asks the session's DO about `id`; closes the D1 row if the DO reports it
 * `ended` or has no meta (create() never ran or the DO was purged). Any other
 * failure to reach the DO leaves the row alone: "cannot tell" must not free a
 * slot that a live container may hold.
 */
export async function healIfStale(env: Env, id: string): Promise<RowVerdict> {
  const stub = env.SESSION.get(env.SESSION.idFromName(id));
  try {
    const { meta } = await stub.status();
    if (meta.state !== 'ended') return 'live';
    await healSessionRow(env, id, { ended_at: meta.ended_at, end_reason: meta.end_reason });
    return 'healed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/has no meta/.test(message)) return 'live';
    await healSessionRow(env, id);
    return 'healed';
  }
}

/** Heals every stuck active row of `userId`. True when at least one row was closed, so the caller may retry its insert. */
export async function healUserActiveRows(env: Env, userId: string): Promise<boolean> {
  let healed = false;
  for (const row of await activeSessionRows(env, userId)) {
    if ((await healIfStale(env, row.id)) === 'healed') healed = true;
  }
  return healed;
}

/** Hourly sweeper: checks active-looking rows older than three hours and heals the ones whose DO has ended or is gone. */
export async function sweepStaleSessions(env: Env, now = Date.now()): Promise<{ checked: number; healed: number }> {
  const rows = await staleActiveRows(env, now - STALE_ACTIVE_AFTER_MS);
  let healed = 0;
  for (const row of rows) {
    if ((await healIfStale(env, row.id)) === 'healed') healed += 1;
  }
  return { checked: rows.length, healed };
}
