import type { PressureEvent } from '../labs/manifest';
import type { SessionRuntime } from './state';
import { emitEvent } from './events';

/**
 * Fires one manifest-declared pressure event: runs its script (from the
 * private bundle at /opt/lab, root-owned so the learner can't read it
 * ahead of time) and emits a `pressure` event with the lab-authored title
 * and message. Scheduled by lifecycle.start (one `pressure` timer per
 * event, keyed by event id) and dispatched from the Session DO's alarm.
 */
export async function firePressureEvent(rt: SessionRuntime, event: PressureEvent): Promise<void> {
  const status = await rt.pressureStatus();
  try {
    const proc = await rt.backend().exec(event.argv, {
      cwd: '/opt/lab',
      env: await rt.sessionEnv(),
      timeout: 30_000,
    });
    const out = await proc.output();
    if (out.exitCode !== 0) {
      status[event.id] = { status: 'failed', fired_at: Date.now() };
      await rt.putPressureStatus(status);
      emitEvent(rt, 'alert', { kind: 'pressure_failed', event_id: event.id, exit_code: out.exitCode });
      return;
    }
    status[event.id] = { status: 'fired', fired_at: Date.now() };
    await rt.putPressureStatus(status);
    emitEvent(rt, 'pressure', { event_id: event.id, title: event.title, message: event.message });
  } catch (err) {
    status[event.id] = { status: 'failed', fired_at: Date.now() };
    await rt.putPressureStatus(status);
    emitEvent(rt, 'alert', { kind: 'pressure_failed', event_id: event.id, error: String(err) });
  }
}
