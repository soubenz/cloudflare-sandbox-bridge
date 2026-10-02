import type { SessionRuntime } from '../session/state';
import { emitEvent } from '../session/events';
import { recomputeAwards, syncSessionHints } from './store';

/**
 * After a check run is stored: recompute the learner's awards and tell the
 * session's console about each new one (`award.earned { id, title, tier }`),
 * so it can toast it. Best effort by contract: a failure here is logged and
 * never reaches the check run that triggered it.
 */
export async function announceNewAwards(rt: SessionRuntime, userId: string, sessionId: string): Promise<void> {
  try {
    await syncSessionHints(rt.env, sessionId, (await rt.hintsDelivered()).length);
    const awarded = await recomputeAwards(rt.env, userId, { sessionId });
    for (const a of awarded) emitEvent(rt, 'award.earned', { id: a.id, title: a.title, tier: a.tier });
  } catch (err) {
    console.error('award recompute failed:', err);
  }
}
