import type { Env } from '../env';
import { activeSessionRows, healSessionRow, staleActiveRows } from './d1';
import { isStuck, STUCK_BOOT_MS } from './state';

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
 * `ended` or has no meta (create() never ran or the DO was purged). A DO that
 * has sat in `starting`, `resuming` or `recovering` for STUCK_BOOT_MS (its
 * boot timer was lost, or it keeps failing) is ended first, inside the DO, so
 * its container and pool claim are released like any other end. Any other
 * failure to reach the DO leaves the row alone: "cannot tell" must not free a
 * slot that a live container may hold.
 */
export async function healIfStale(env: Env, id: string, now = Date.now()): Promise<RowVerdict> {
  const stub = env.SESSION.get(env.SESSION.idFromName(id));
  try {
    let { meta } = await stub.status();
    if (meta.state !== 'ended') {
      if (!isStuck(meta, now)) return 'live';
      // The DO re-checks with its own clock and state, so a boot that finished
      // a moment ago is never ended on this caller's stale read.
      const ended = await stub.endIfStuck();
      if (!ended) return 'live';
      meta = ended;
    }
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

/**
 * Hourly sweeper: checks active-looking rows older than three hours, and rows
 * in a boot state (`starting`, `resuming`, `recovering`) older than
 * STUCK_BOOT_MS, and heals the ones whose DO has ended, is gone or is stuck.
 */
export async function sweepStaleSessions(env: Env, now = Date.now()): Promise<{ checked: number; healed: number }> {
  const rows = await staleActiveRows(env, now - STALE_ACTIVE_AFTER_MS, 100, now - STUCK_BOOT_MS);
  let healed = 0;
  for (const row of rows) {
    if ((await healIfStale(env, row.id, now)) === 'healed') healed += 1;
  }
  return { checked: rows.length, healed };
}
