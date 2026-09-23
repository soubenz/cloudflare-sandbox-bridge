import { describe, it, expect } from 'vitest';
import { OpalixClient } from '../../cli/src/client';
import { collectSse, startRunningSession } from './helpers';

/**
 * Tier 3 of the test plan: the time- and failure-driven behaviors that
 * only the DO alarm can produce. These are slow by nature — each one
 * waits on a real timer — so they live apart from the fast route suite
 * and are opt-in via OPALIX_SLOW=1.
 *
 * Fixtures: `impatient` (idle_minutes at the schema minimum of 1, a
 * pressure event at T+1min) and `fragile` (a pressure event that kills
 * the container's init process). Both must be published first.
 *
 * Not covered here: the hard timeout. The manifest schema floors
 * timeout_minutes at 60, so an end-to-end hard-expiry test would take an
 * hour; the scheduling half of it is asserted below instead, and the
 * firing half is covered by the timer unit tests.
 */
const OPALIX_URL = process.env.OPALIX_URL;
const OPALIX_KEY = process.env.OPALIX_KEY;
const SLOW = process.env.OPALIX_SLOW === '1';
const describeIfSlow = OPALIX_URL && OPALIX_KEY && SLOW ? describe : describe.skip;

describeIfSlow('session timing and failure behaviors', () => {
  const service = new OpalixClient({ baseUrl: OPALIX_URL!, serviceKey: OPALIX_KEY });

  it('schedules the hard timeout from the manifest', async () => {
    const { id, session } = await startRunningSession(service, OPALIX_URL!, 'hello');
    try {
      const { meta } = await session.status(id);
      expect(meta.started_at).toBeTruthy();
      expect(meta.expires_at).toBeTruthy();
      // hello declares timeout_minutes: 60.
      const window = meta.expires_at! - meta.started_at!;
      expect(window).toBe(60 * 60_000);
    } finally {
      await session.end(id, false).catch(() => {});
    }
  }, 180_000);

  it('fires the pressure event and lands it on SSE with the authored copy', async () => {
    const { id, session } = await startRunningSession(service, OPALIX_URL!, 'impatient');
    try {
      // at_minutes: 1, so allow the alarm a generous margin past T+60s.
      const events = await collectSse(session.eventsUrl(id), 150_000, (e) => e.event === 'pressure');
      const pressure = events.find((e) => e.event === 'pressure');
      expect(pressure).toBeTruthy();
      const data = JSON.parse(pressure!.data);
      expect(data.event_id).toBe('burst');
      expect(data.title).toBe('A burst arrives');
      expect(data.message).toContain('Something changed');
    } finally {
      await session.end(id, false).catch(() => {});
    }
  }, 240_000);

  it('ends an idle session once idle_minutes elapses', async () => {
    const { id, session } = await startRunningSession(service, OPALIX_URL!, 'impatient');
    try {
      // Deliberately send no input: no terminal frames, no file writes, no
      // checks, no proxy hits — any of those would refresh last_input_at.
      const deadline = Date.now() + 240_000;
      let state = 'running';
      while (Date.now() < deadline && state !== 'ended') {
        await new Promise((r) => setTimeout(r, 5_000));
        state = (await service.status(id)).meta.state;
      }
      expect(state).toBe('ended');
      const { meta, snapshots } = await service.status(id);
      expect((meta as { end_reason?: string }).end_reason).toBe('idle');
      // The idle path is supposed to snapshot before destroying, so a
      // learner who wandered off can resume. Requires R2 backup creds.
      if (process.env.OPALIX_R2_BACKUPS === '1') expect(snapshots.length).toBeGreaterThan(0);
    } finally {
      await service.end(id, false).catch(() => {});
    }
  }, 300_000);

  it('recovers when the container is killed under a live session', async () => {
    const { id, session } = await startRunningSession(service, OPALIX_URL!, 'fragile');
    try {
      const events = await collectSse(
        session.eventsUrl(id),
        180_000,
        (e) => e.event === 'container.restarted'
      );
      expect(events.some((e) => e.event === 'container.restarted')).toBe(true);

      // After recovery the session must still be usable: services
      // relaunched from their stored spec, workspace back, state running.
      const deadline = Date.now() + 120_000;
      let status = await session.status(id);
      while (Date.now() < deadline && status.meta.state !== 'running') {
        await new Promise((r) => setTimeout(r, 3_000));
        status = await session.status(id);
      }
      expect(status.meta.state).toBe('running');
      expect(status.services.echo!.health).not.toBe('unhealthy');

      await session.writeFile(id, 'after-restart.txt', 'still alive');
      expect((await session.readFile(id, 'after-restart.txt')).content).toBe('still alive');
    } finally {
      await session.end(id, false).catch(() => {});
    }
  }, 400_000);
});
