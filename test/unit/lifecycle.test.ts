import { describe, it, expect } from 'vitest';
import { createFakeRuntime } from '../fakes/fake-runtime';
import { createSession, handleAlarm } from '../../src/session/lifecycle';
import { parseManifest } from '../../src/labs/manifest';
import { verifySessionToken } from '../../src/auth';
import { scheduleTimer } from '../../src/session/timers';
import type { SessionMeta } from '../../src/session/state';

function manifest(overrides: Record<string, unknown> = {}) {
  return parseManifest({
    slug: 'test-lab',
    version: '1.0.0',
    title: 'Test lab',
    type: 'build',
    family: 'agent',
    timeout_minutes: 120,
    services: [{ name: 'svc', argv: ['python3', '-m', 'http.server'], port: 8000 }],
    checks: [{ name: 'check-1', script: 'check.sh' }],
    ...overrides,
  });
}

describe('createSession', () => {
  it('mints a token that covers the lab\'s full timeout, not a flat hour', async () => {
    const { rt } = createFakeRuntime();
    const before = Date.now();
    const { token } = await createSession(rt, {
      userId: 'user-1',
      labSlug: 'test-lab',
      labVersion: '1.0.0',
      family: 'agent',
      manifest: manifest({ timeout_minutes: 120 }),
    });

    const payload = await verifySessionToken(rt.env, token);
    // The session can still be alive 120 minutes in; the token must be too.
    expect(payload.exp * 1000).toBeGreaterThan(before + 120 * 60_000);
  });
});

describe('idle_warn alarm', () => {
  const IDLE_MINUTES = 10;
  const WARN_AFTER_MS = IDLE_MINUTES * 60_000 - 2 * 60_000;

  async function setup(lastInputAgoMs: number) {
    const { rt } = createFakeRuntime();
    const now = Date.now();
    const meta: SessionMeta = {
      id: 'test-session',
      user_id: 'user-1',
      lab_slug: 'test-lab',
      lab_version: '1.0.0',
      family: 'agent',
      state: 'running',
      created_at: now - 60 * 60_000,
      started_at: now - 60 * 60_000,
      last_input_at: now - lastInputAgoMs,
      resumed_count: 0,
    };
    await rt.putMeta(meta);
    await rt.putManifest(manifest({ idle_minutes: IDLE_MINUTES }));
    // The warning timer armed at session start, long since stale.
    await scheduleTimer(rt, 'idle_warn', now - 1000);
    await handleAlarm(rt);
    return { rt, now };
  }

  it('re-arms instead of warning when the learner has been active', async () => {
    const lastInputAgoMs = 60_000;
    const { rt, now } = await setup(lastInputAgoMs);
    const warn = (await rt.timers()).find((t) => t.kind === 'idle_warn');
    expect(warn).toBeDefined();
    expect(warn!.at).toBeGreaterThanOrEqual(now - lastInputAgoMs + WARN_AFTER_MS);
  });

  it('warns (and does not re-arm) once the session really has gone idle', async () => {
    const { rt } = await setup(WARN_AFTER_MS + 30_000);
    expect((await rt.timers()).find((t) => t.kind === 'idle_warn')).toBeUndefined();
  });
});
