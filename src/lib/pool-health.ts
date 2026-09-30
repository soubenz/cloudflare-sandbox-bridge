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

// --- Admission control (B-19) ---

/** Seconds a refused caller is told to wait when the pool is simply full. */
export const AT_CAPACITY_RETRY_S = 30;
/** The most a capacity backoff can ask a caller to wait, so a far-off `backoffUntil` never turns into an hours-long Retry-After. */
export const MAX_RETRY_AFTER_S = 300;
/** `max_instances` assumed when the `MAX_INSTANCES_*` var is unset or unusable; matches wrangler.jsonc. */
export const DEFAULT_MAX_INSTANCES = 10;

/** Parses a `MAX_INSTANCES_*` var (a string, like every wrangler var). Anything that is not a positive integer falls back to the default. */
export function resolveMaxInstances(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_INSTANCES;
}

export interface AdmissionInput {
  /** Containers held by live sessions. */
  claimed: number;
  /** Pre-started containers waiting to be claimed. */
  warm: number;
  /** The container class's `max_instances`. */
  max: number;
  /** The pool's capacity-backoff deadline (epoch ms); in the past or 0 when there is none. */
  backoffUntil: number;
  now: number;
}

export type AdmissionDecision = { ok: true } | { ok: false; retry_after_s: number };

/**
 * Whether a new session may be admitted.
 *
 * A warm container is already running and counted against `max_instances`,
 * so claiming one adds nothing: while any is warm the answer is yes, even
 * with `claimed + warm` at the ceiling. Refusing on that sum would turn away
 * every caller from a fully warmed pool. Only when nothing is warm does the
 * session need a cold start, and that is refused when the ceiling is already
 * held by live sessions, or while the pool is backing off after the platform
 * reported no capacity.
 */
export function admissionDecision(input: AdmissionInput): AdmissionDecision {
  const { claimed, warm, max, backoffUntil, now } = input;
  if (warm > 0) return { ok: true };
  if (claimed >= max) return { ok: false, retry_after_s: AT_CAPACITY_RETRY_S };
  if (backoffUntil > now) {
    return { ok: false, retry_after_s: Math.min(MAX_RETRY_AFTER_S, Math.max(1, Math.ceil((backoffUntil - now) / 1000))) };
  }
  return { ok: true };
}

/** Slots a new session could still get: `max_instances` less the containers live sessions hold. */
export function availableSlots(claimed: number, max: number): number {
  return Math.max(0, max - claimed);
}
