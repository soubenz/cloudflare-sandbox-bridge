import type { SessionRuntime } from './state';
import type { TimerEntry, TimerKind } from './state';

/**
 * All of a session's scheduled work (idle/hard timeouts, pressure events,
 * health/metrics polling, cleanup) rides on the Session DO's single alarm.
 * Entries are kept sorted by `at`; `rearmAlarm` sets the DO's alarm to the
 * earliest entry so we never miss one, and `popDueTimers` is called from
 * the DO's `alarm()` to collect everything ready to run right now (more
 * than one can be due in the same tick, e.g. health + metrics).
 */
export async function scheduleTimer(rt: SessionRuntime, kind: TimerKind, at: number, ref?: string): Promise<void> {
  const timers = await rt.timers();
  const filtered = timers.filter((t) => !(t.kind === kind && t.ref === ref));
  filtered.push({ kind, at, ref });
  filtered.sort((a, b) => a.at - b.at);
  await rt.putTimers(filtered);
  await rearmAlarm(rt);
}

export async function cancelTimer(rt: SessionRuntime, kind: TimerKind, ref?: string): Promise<void> {
  const timers = await rt.timers();
  await rt.putTimers(timers.filter((t) => !(t.kind === kind && t.ref === ref)));
}

export async function popDueTimers(rt: SessionRuntime, now: number): Promise<TimerEntry[]> {
  const timers = await rt.timers();
  const due = timers.filter((t) => t.at <= now);
  const remaining = timers.filter((t) => t.at > now);
  await rt.putTimers(remaining);
  return due;
}

export async function rearmAlarm(rt: SessionRuntime): Promise<void> {
  const timers = await rt.timers();
  if (timers.length === 0) {
    await rt.storage.deleteAlarm();
    return;
  }
  const next = timers[0]!.at;
  const current = await rt.storage.getAlarm();
  if (current === null || current !== next) await rt.storage.setAlarm(next);
}
