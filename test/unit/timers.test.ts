import { describe, it, expect } from 'vitest';
import { createFakeRuntime } from '../fakes/fake-runtime';
import { scheduleTimer, cancelTimer, popDueTimers, rearmAlarm } from '../../src/session/timers';

describe('session timers', () => {
  it('schedules and arms the alarm to the earliest timer', async () => {
    const { rt, storage } = createFakeRuntime();
    await scheduleTimer(rt, 'hard', 1000);
    await scheduleTimer(rt, 'idle', 500);
    await scheduleTimer(rt, 'metrics', 1500);
    expect(await storage.getAlarm()).toBe(500);
  });

  it('replaces an existing timer of the same kind+ref instead of duplicating it', async () => {
    const { rt } = createFakeRuntime();
    await scheduleTimer(rt, 'pressure', 1000, 'burst-1');
    await scheduleTimer(rt, 'pressure', 2000, 'burst-1');
    const due = await popDueTimers(rt, 2000);
    expect(due).toHaveLength(1);
    expect(due[0]!.at).toBe(2000);
  });

  it('keeps distinct refs of the same kind as separate timers', async () => {
    const { rt } = createFakeRuntime();
    await scheduleTimer(rt, 'pressure', 1000, 'a');
    await scheduleTimer(rt, 'pressure', 1000, 'b');
    const due = await popDueTimers(rt, 1000);
    expect(due.map((t) => t.ref).sort()).toEqual(['a', 'b']);
  });

  it('popDueTimers only removes and returns timers at or before `now`', async () => {
    const { rt } = createFakeRuntime();
    await scheduleTimer(rt, 'idle', 100);
    await scheduleTimer(rt, 'hard', 200);
    const due = await popDueTimers(rt, 150);
    expect(due.map((t) => t.kind)).toEqual(['idle']);
    const remaining = await rt.timers();
    expect(remaining.map((t) => t.kind)).toEqual(['hard']);
  });

  it('cancelTimer removes a scheduled timer without affecting others', async () => {
    const { rt } = createFakeRuntime();
    await scheduleTimer(rt, 'idle', 100);
    await scheduleTimer(rt, 'hard', 200);
    await cancelTimer(rt, 'idle');
    const remaining = await rt.timers();
    expect(remaining.map((t) => t.kind)).toEqual(['hard']);
  });

  it('rearmAlarm clears the alarm when there are no timers left', async () => {
    const { rt, storage } = createFakeRuntime();
    await scheduleTimer(rt, 'idle', 100);
    await cancelTimer(rt, 'idle');
    await rearmAlarm(rt);
    expect(await storage.getAlarm()).toBeNull();
  });
});
