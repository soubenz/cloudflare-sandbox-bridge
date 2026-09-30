import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRuntime } from '../../src/session/state';
import type { SessionMeta } from '../../src/session/state';
import type { Env } from '../../src/env';
import { createFakeStorage } from '../fakes/fake-storage';
import { FakeBackend } from '../fakes/fake-backend';
import { parseManifest } from '../../src/labs/manifest';
import { scheduleTimer } from '../../src/session/timers';
import { handleAlarm, recover } from '../../src/session/lifecycle';

// Same container-facing stubs as session-guards.test.ts. The service probes
// are mocks here so a test can make one throw.
const pool = { claim: vi.fn(), release: vi.fn() };
vi.mock('../../src/do/pool', () => ({ poolStub: () => pool }));
vi.mock('../../src/session/hydrate', () => ({
  hydrateWorkspaceFiles: async () => {},
  hydratePressureScripts: async () => {},
  applySessionEnv: async () => {},
}));
const services = vi.hoisted(() => ({
  startAllServices: vi.fn(async () => {}),
  relaunchAllServices: vi.fn(async () => {}),
  healthCheckAll: vi.fn(async () => {}),
  allServicesGone: vi.fn(async () => false),
}));
vi.mock('../../src/session/services', () => services);
vi.mock('../../src/session/d1', () => ({
  updateSession: async () => {},
  insertSnapshot: async () => {},
  bestEffort: () => {},
}));

function makeRuntime() {
  const storage = createFakeStorage();
  const sqlCalls: unknown[][] = [];
  const ctx = {
    id: { name: 'sess-1' },
    storage: { ...storage, sql: { exec: (...args: unknown[]) => (sqlCalls.push(args), []) } },
    getWebSockets: () => [],
  };
  const rt = new SessionRuntime(ctx as unknown as DurableObjectState, { SESSION_TOKEN_SECRET: 'test-secret' } as Env, 'sess-1');
  const backend = new FakeBackend();
  (rt as unknown as { _backend: unknown })._backend = backend.asBackend();
  /** Every event recorded through emitEvent, as { type, data }. */
  const events = () =>
    sqlCalls
      .filter((c) => String(c[0]).startsWith('INSERT INTO events'))
      .map((c) => ({ type: c[2] as string, data: JSON.parse(c[3] as string) as Record<string, unknown> }));
  return { rt, backend, events };
}

function metaIn(state: SessionMeta['state'], extra: Partial<SessionMeta> = {}): SessionMeta {
  const now = Date.now();
  return {
    id: 'sess-1',
    user_id: 'user-1',
    lab_slug: 'test-lab',
    lab_version: '1.0.0',
    family: 'agent',
    state,
    created_at: now - 60_000,
    started_at: now - 60_000,
    resumed_count: 0,
    ...extra,
  };
}

const manifest = () =>
  parseManifest({
    slug: 'test-lab',
    version: '1.0.0',
    title: 'Test lab',
    type: 'build',
    family: 'agent',
    timeout_minutes: 120,
    services: [{ name: 'svc', argv: ['python3', '-m', 'http.server'], port: 8000 }],
    checks: [{ name: 'check-1', script: 'check.sh' }],
  });

beforeEach(() => {
  pool.claim.mockReset();
  pool.release.mockReset();
  pool.release.mockResolvedValue(undefined);
  services.allServicesGone.mockReset().mockResolvedValue(false);
  services.healthCheckAll.mockReset().mockResolvedValue(undefined);
  services.relaunchAllServices.mockReset().mockResolvedValue(undefined);
});

describe('recurring timers survive a throw (B-10)', () => {
  it('a health tick whose probe throws still leaves exactly one future health timer', async () => {
    const { rt, backend, events } = makeRuntime();
    await rt.putMeta(metaIn('running', { sandbox_id: 'sb' }));
    services.healthCheckAll.mockRejectedValueOnce(new Error('probe blew up'));
    const before = Date.now();
    await scheduleTimer(rt, 'health', before - 1);

    await handleAlarm(rt);

    const health = (await rt.timers()).filter((t) => t.kind === 'health');
    expect(health).toHaveLength(1);
    expect(health[0]!.at).toBeGreaterThan(before);
    expect(events().some((e) => e.type === 'alert' && e.data.kind === 'timer_failed' && e.data.timer === 'health')).toBe(true);
    expect(backend.callsTo('destroy')).toHaveLength(0);
  });

  it('a metrics tick that throws still leaves exactly one future metrics timer', async () => {
    const { rt } = makeRuntime();
    await rt.putMeta(metaIn('running', { sandbox_id: 'sb' }));
    vi.spyOn(rt, 'putCost').mockRejectedValueOnce(new Error('storage hiccup'));
    const before = Date.now();
    await scheduleTimer(rt, 'metrics', before - 1);

    await handleAlarm(rt);

    const metrics = (await rt.timers()).filter((t) => t.kind === 'metrics');
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.at).toBeGreaterThan(before);
  });

  it('does not double-schedule when the handler already re-armed before throwing', async () => {
    const { rt } = makeRuntime();
    await rt.putMeta(metaIn('running', { sandbox_id: 'sb' }));
    const rearmed = Date.now() + 15_000;
    services.healthCheckAll.mockImplementationOnce(async () => {
      await scheduleTimer(rt, 'health', rearmed);
      throw new Error('late failure');
    });
    await scheduleTimer(rt, 'health', Date.now() - 1);

    await handleAlarm(rt);

    expect((await rt.timers()).filter((t) => t.kind === 'health')).toEqual([{ kind: 'health', at: rearmed, ref: undefined }]);
  });

  it('does not re-arm on an ended session', async () => {
    const { rt } = makeRuntime();
    await rt.putMeta(metaIn('running', { sandbox_id: 'sb' }));
    services.healthCheckAll.mockImplementationOnce(async () => {
      await rt.patchMeta({ state: 'ended' });
      throw new Error('ended mid-tick');
    });
    await scheduleTimer(rt, 'health', Date.now() - 1);

    await handleAlarm(rt);

    expect((await rt.timers()).filter((t) => t.kind === 'health')).toHaveLength(0);
  });
});

describe('recovering cannot wedge (B-10)', () => {
  it('a health tick ends a session stuck in recovering for over 5 minutes', async () => {
    const { rt } = makeRuntime();
    await rt.putMeta(metaIn('recovering', { sandbox_id: 'sb', recovering_since: Date.now() - 10 * 60_000 }));
    await rt.putManifest(manifest());
    await scheduleTimer(rt, 'health', Date.now() - 1);

    await handleAlarm(rt);

    const meta = await rt.requireMeta();
    expect(meta.state).toBe('ended');
    expect(meta.end_reason).toBe('error');
  });

  it('a recovering session that is still fresh is left alone and keeps polling', async () => {
    const { rt } = makeRuntime();
    await rt.putMeta(metaIn('recovering', { sandbox_id: 'sb', recovering_since: Date.now() - 30_000 }));
    await scheduleTimer(rt, 'health', Date.now() - 1);

    await handleAlarm(rt);

    expect((await rt.requireMeta()).state).toBe('recovering');
    expect((await rt.timers()).filter((t) => t.kind === 'health')).toHaveLength(1);
  });

  it('three failed recoveries end the session on the next health tick', async () => {
    const { rt } = makeRuntime();
    await rt.putMeta(metaIn('running', { sandbox_id: 'sb', recover_failures: 3 }));
    await rt.putManifest(manifest());
    await scheduleTimer(rt, 'health', Date.now() - 1);

    await handleAlarm(rt);

    expect((await rt.requireMeta()).end_reason).toBe('error');
  });

  it('recover() whose relaunch throws goes back to running, counts the failure and alerts', async () => {
    const { rt, events } = makeRuntime();
    await rt.putMeta(metaIn('running', { sandbox_id: 'sb' }));
    await rt.putManifest(manifest());
    services.relaunchAllServices.mockRejectedValueOnce(new Error('exec failed'));

    await expect(recover(rt, 'all_services_gone')).resolves.toBeUndefined();

    const meta = await rt.requireMeta();
    expect(meta.state).toBe('running');
    expect(meta.recover_failures).toBe(1);
    expect(meta.recovering_since).toBeUndefined();
    expect(events().some((e) => e.type === 'alert' && e.data.kind === 'recover_failed' && String(e.data.error).includes('exec failed'))).toBe(true);

    // The next attempt can run (it used to be blocked by the stuck state) and success clears the counter.
    await recover(rt, 'all_services_gone');
    const healed = await rt.requireMeta();
    expect(healed.state).toBe('running');
    expect(healed.recover_failures).toBeUndefined();
    expect('recover_failures' in healed).toBe(false);
  });
});
