/**
 * Pure bookkeeping over a Pool DO's `claimed` map (sandbox id → who holds it),
 * kept out of do/pool.ts so it can be unit-tested without `cloudflare:workers`.
 */

export interface ClaimedEntry {
  session_id: string;
  claimed_at: number;
}

/**
 * The sandbox `sessionId` already holds, if any. A Session DO's start/resume
 * is retried after an eviction, and an eviction can land after the pool
 * recorded a claim but before the session stored the sandbox id; the retry
 * must get that same container back, not a second one that would leak until
 * the reaper (and count against admission meanwhile).
 */
export function claimOf(claimed: Record<string, ClaimedEntry>, sessionId: string): string | undefined {
  return Object.entries(claimed).find(([, entry]) => entry.session_id === sessionId)?.[0];
}

/** Every sandbox id held by `sessionId` (normally zero or one). */
export function claimsOf(claimed: Record<string, ClaimedEntry>, sessionId: string): string[] {
  return Object.entries(claimed)
    .filter(([, entry]) => entry.session_id === sessionId)
    .map(([id]) => id);
}
