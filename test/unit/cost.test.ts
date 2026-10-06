import { describe, it, expect, vi } from 'vitest';
import { SessionRuntime } from '../../src/session/state';
import type { SessionMeta } from '../../src/session/state';
import type { Env } from '../../src/env';
import { createFakeStorage } from '../fakes/fake-storage';
import { tickMetrics } from '../../src/session/metrics';
import { FakeBackend } from '../fakes/fake-backend';
import { parseManifest, requireRunnable } from '../../src/labs/manifest';

// do/session.ts extends DurableObject from the `cloudflare:workers` virtual
// module, which plain Node cannot resolve. Alias it to a bare class so
// status() can be called directly.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../../src/do/pool', () => ({ poolStub: () => ({ claim: async () => ({ sandbox_id: 'claimed-1' }), release: async () => {} }) }));
vi.mock('../../src/session/hydrate', () => ({
  hydrateWorkspaceFiles: async () => {},
  hydratePressureScripts: async () => {},
  applySessionEnv: async () => {},
}));
vi.mock('../../src/session/services', () => ({
  startAllServices: async () => {},
  relaunchAllServices: async () => {},
  healthCheckAll: async () => {},
  allServicesGone: async () => false,
}));
const updateSession = vi.hoisted(() => vi.fn(async () => {}));
// The resume route reserved the user's slot (the row says `resuming`) before the DO is asked.
vi.mock('../../src/session/d1', () => ({ updateSession, insertSnapshot: async () => {}, bestEffort: () => {}, sessionRowState: async () => 'resuming', activeSessionRows: async () => [] }));

function makeRuntime() {
  const storage = createFakeStorage();
  const ctx = { id: { name: 'sess-1' }, storage: { ...storage, sql: { exec: () => [] } }, getWebSockets: () => [] };
  const rt = new SessionRuntime(ctx as unknown as DurableObjectState, { SESSION_TOKEN_SECRET: 'test-secret' } as Env, 'sess-1');
  return { rt, ctx };
}

function metaIn(extra: Partial<SessionMeta> = {}): SessionMeta {
  const now = Date.now();
  return { id: 'sess-1', user_id: 'u', lab_slug: 'l', lab_version: '1', family: 'agent', state: 'running', created_at: now - 120_000, resumed_count: 0, ...extra };
}

describe('cost accounting (B-11)', () => {
  it('adds only the time since accounted_until to running_s', async () => {
    const { rt } = makeRuntime();
    const now = Date.now();
    await rt.putMeta(metaIn({ started_at: now - 60_000 }));
    await rt.putCost({ running_s: 600, usd: 0, llm_usd: 0.5, accounted_until: now - 60_000 });

    await tickMetrics(rt);

    const cost = await rt.cost();
    expect(cost.running_s).toBeGreaterThanOrEqual(659);
    expect(cost.running_s).toBeLessThanOrEqual(661);
    expect(Math.abs(cost.accounted_until! - Date.now())).toBeLessThan(1000);
    expect(cost.usd).toBeGreaterThan(0);
    expect(cost.llm_usd).toBe(0.5);
  });

  it('a tick right after resume adds about nothing and keeps the earlier compute', async () => {
    const { rt } = makeRuntime();
    const now = Date.now();
    // What runResume leaves behind: started_at and accounted_until both "now", running_s carried over.
    await rt.putMeta(metaIn({ started_at: now, resumed_count: 1 }));
    await rt.putCost({ running_s: 600, usd: 1, llm_usd: 0, accounted_until: now });

    await tickMetrics(rt);

    expect((await rt.cost()).running_s).toBeGreaterThanOrEqual(600);
    expect((await rt.cost()).running_s).toBeLessThan(601);
  });

  it('never counts time before started_at, even with a stale accounted_until', async () => {
    const { rt } = makeRuntime();
    const now = Date.now();
    await rt.putMeta(metaIn({ started_at: now - 10_000 }));
    await rt.putCost({ running_s: 100, usd: 0, llm_usd: 0, accounted_until: now - 3_600_000 });

    await tickMetrics(rt);

    const { running_s } = await rt.cost();
    expect(running_s).toBeGreaterThanOrEqual(109);
    expect(running_s).toBeLessThanOrEqual(111);
  });

  it('status() returns cost alongside meta', async () => {
    const { Session } = await import('../../src/do/session');
    const { rt, ctx } = makeRuntime();
    await rt.putMeta(metaIn({ started_at: Date.now() }));
    await rt.putCost({ running_s: 12, usd: 0.01, llm_usd: 0.02 });
    const doInstance = Object.create(Session.prototype) as { rt: SessionRuntime; status(): Promise<Record<string, unknown>> };
    doInstance.rt = rt;
    void ctx;

    const status = await doInstance.status();

    expect(status.cost).toMatchObject({ running_s: 12, usd: 0.01, llm_usd: 0.02 });
    expect(Object.keys(status)).toEqual(expect.arrayContaining(['meta', 'services', 'snapshots', 'checks', 'cost']));
  });

  it('endSession runs a final tick and hands the cost to D1', async () => {
    const { endSession } = await import('../../src/session/lifecycle');
    const { rt } = makeRuntime();
    const now = Date.now();
    await rt.putMeta(metaIn({ started_at: now - 90_000 }));
    await rt.putCost({ running_s: 10, usd: 0, llm_usd: 0.25, accounted_until: now - 90_000 });

    await endSession(rt, 'user', false);

    const [, , cost] = updateSession.mock.calls.at(-1) as unknown as [unknown, unknown, { cost_usd: number; llm_usd: number; running_s: number }];
    expect(cost.running_s).toBeGreaterThanOrEqual(99);
    expect(cost.running_s).toBeLessThanOrEqual(101);
    expect(cost.cost_usd).toBeGreaterThan(0);
    expect(cost.llm_usd).toBe(0.25);
  });

  it('resume keeps prior running_s and usd, and moves accounted_until to now so the ended gap is not billed', async () => {
    const { endSession, requestResume, handleAlarm } = await import('../../src/session/lifecycle');
    const { rt } = makeRuntime();
    const backend = new FakeBackend();
    rt.bindBackend = async () => {
      (rt as unknown as { _backend: unknown })._backend = backend.asBackend();
    };
    const now = Date.now();
    await rt.putMeta(metaIn({ started_at: now - 30_000, sandbox_id: 'old' }));
    await rt.putManifest(
      requireRunnable(parseManifest({
        slug: 'test-lab',
        version: '1.0.0',
        title: 'Test lab',
        type: 'build',
        family: 'agent',
        timeout_minutes: 120,
        services: [{ name: 'svc', argv: ['python3', '-m', 'http.server'], port: 8000 }],
        checks: [{ name: 'check-1', script: 'check.sh' }],
      }))
    );
    await rt.putSnapshots([{ backup_id: 'bk', dir: '/workspace', ttl: 3600, created_at: now, reason: 'user' }]);
    await rt.putCost({ running_s: 600, usd: 0.5, llm_usd: 0, accounted_until: now - 30_000 });
    await rt.bindBackend('agent', 'old');
    await endSession(rt, 'user', false);
    const endedCost = await rt.cost();

    await requestResume(rt);
    await handleAlarm(rt);

    expect((await rt.requireMeta()).state).toBe('running');
    const cost = await rt.cost();
    expect(cost.running_s).toBe(endedCost.running_s);
    expect(cost.usd).toBe(endedCost.usd);
    expect(cost.running_s).toBeGreaterThanOrEqual(629);
    expect(Math.abs(cost.accounted_until! - (await rt.requireMeta()).started_at!)).toBeLessThan(50);
  });
});
