/**
 * Pure pool-health logic, kept out of do/pool.ts because that module imports
 * `cloudflare:workers` and cannot load under the plain-Node unit runner.
 * do/pool.ts re-exports `degradedTransition` so callers can import it from
 * either place.
 */

/** Consecutive failed starts, with an empty pool, before a pool counts as degraded. */
export const DEGRADED_AFTER_FAILURES = 3;

export interface DegradedInput {
  /** Whether the pool is currently flagged degraded. */
  degraded: boolean;
  /** Configured warm target. A pool with target 0 is empty on purpose. */
  target: number;
  /** Warm containers right now (after this alarm's refill attempt). */
  warm: number;
  /** consecutive_start_failures (after this alarm's refill attempt; reset to 0 by any successful start). */
  failures: number;
}

/**
 * What the alarm should do about the degraded flag:
 * - `'degrade'`: not yet degraded, the pool should have warm containers, has none, and starts keep failing.
 * - `'recover'`: degraded, and a start has since succeeded (failures back to 0).
 * - `null`: no change.
 */
export function degradedTransition(prev: DegradedInput): 'degrade' | 'recover' | null {
  if (!prev.degraded) {
    return prev.target > 0 && prev.warm === 0 && prev.failures >= DEGRADED_AFTER_FAILURES ? 'degrade' : null;
  }
  return prev.failures === 0 ? 'recover' : null;
}

/** Body for the alert webhook. `text` is what Slack reads, `content` what Discord reads. */
export function alertPayload(text: string): { text: string; content: string } {
  return { text, content: text };
}

export function degradedMessage(family: string, lastError: string | undefined): string {
  return `opalix: ${family} pool degraded — ${lastError ?? 'unknown error'}`;
}

export function recoveredMessage(family: string): string {
  return `opalix: ${family} pool recovered`;
}

/**
 * POSTs `text` to the alert webhook. No-op when `url` is unset. Never throws:
 * an unreachable webhook must not break the pool's alarm loop.
 */
export async function postAlert(url: string | undefined, text: string, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!url) return;
  try {
    await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(alertPayload(text)),
    });
  } catch (err) {
    console.error('alert webhook failed:', err);
  }
}
