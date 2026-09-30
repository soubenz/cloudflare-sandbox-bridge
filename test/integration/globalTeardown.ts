/**
 * Vitest globalTeardown for the integration suite: deletes sessions the
 * suite left behind so a failed run does not hold a user's one-active-session
 * fence or a warm container.
 *
 * Uses the same env as the tests (OPALIX_URL, OPALIX_KEY) plus
 * OPALIX_USER_PREFIX (default `it-`). A session is deleted when its user_id
 * starts with the prefix AND it is older than ten minutes or is already
 * `ended`. The age guard keeps a concurrent run's live
 * sessions safe. GET /sessions only lists non-ended sessions (max 200), so the
 * `ended` check is defensive.
 *
 * Never throws: cleanup problems are logged and must not fail the run.
 */
const MAX_AGE_MS = 10 * 60 * 1000;

interface ListedSession {
  id: string;
  user_id: string;
  state: string;
  created_at: number;
}

export default async function globalTeardown(): Promise<void> {
  const base = process.env.OPALIX_URL?.replace(/\/+$/, '');
  const key = process.env.OPALIX_KEY;
  const prefix = process.env.OPALIX_USER_PREFIX ?? 'it-';
  if (!base || !key || !prefix) return;
  const headers = { Authorization: `Bearer ${key}` };

  try {
    const res = await fetch(`${base}/sessions`, { headers });
    if (!res.ok) {
      console.warn(`[integration teardown] GET /sessions -> ${res.status}; nothing cleaned up`);
      return;
    }
    const sessions = (await res.json()) as ListedSession[];
    const now = Date.now();
    const stale = sessions.filter(
      (s) => s.user_id?.startsWith(prefix) && (s.state === 'ended' || now - s.created_at > MAX_AGE_MS),
    );
    const deleted: string[] = [];
    for (const s of stale) {
      try {
        // snapshot=0: these are throwaway sessions, no need to back them up.
        const del = await fetch(`${base}/sessions/${encodeURIComponent(s.id)}?snapshot=0`, { method: 'DELETE', headers });
        if (del.ok) deleted.push(`${s.id} (${s.user_id}, ${s.state})`);
        else console.warn(`[integration teardown] DELETE ${s.id} -> ${del.status}`);
      } catch (err) {
        console.warn(`[integration teardown] DELETE ${s.id} failed: ${String(err)}`);
      }
    }
    console.log(
      `[integration teardown] prefix "${prefix}": ${sessions.length} live, ${deleted.length} deleted` +
        (deleted.length ? `: ${deleted.join(', ')}` : ''),
    );
  } catch (err) {
    console.warn(`[integration teardown] skipped: ${String(err)}`);
  }
}
