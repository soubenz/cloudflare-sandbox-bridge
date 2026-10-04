import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRuntime } from '../../src/session/state';
import type { SessionMeta, SnapshotEntry } from '../../src/session/state';
import type { Env } from '../../src/env';
import { createFakeStorage } from '../fakes/fake-storage';
import { ApiError } from '../../src/lib/errors';
import { parseManifest } from '../../src/labs/manifest';
import { scheduleTimer } from '../../src/session/timers';
import { endSession, handleAlarm, requestResume } from '../../src/session/lifecycle';

// lifecycle.ts reaches the pool through a dynamic import of do/pool, which
// pulls in `cloudflare:workers` and cannot load under plain Node. The stub
// records what a session asks of the pool.
const pool = { claim: vi.fn(), release: vi.fn() };
vi.mock('../../src/do/pool', () => ({ poolStub: () => pool }));

// Container-facing steps of a resume; none of them is under test here.
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
// The resume route reserved the user's slot (the row says `resuming`) before the DO is asked.
vi.mock('../../src/session/d1', () => ({
  updateSession: async () => {},
  insertSnapshot: async () => {},
  bestEffort: () => {},
  sessionRowState: async () => 'resuming',
  activeSessionRows: async () => [],
}));

/** A real SessionRuntime over fake storage that also implements deleteAll(), with the alarm calls observable. */
function makeRuntime() {
  const storage = createFakeStorage();
  const deleteAlarm = vi.fn(storage.deleteAlarm);
  const deleteAll = vi.fn(async () => storage._dump().clear());
  const ctx = {
    id: { name: 'sess-1' },
    storage: { ...storage, deleteAlarm, deleteAll, sql: { exec: () => [] } },
  };
  const rt = new SessionRuntime(ctx as unknown as DurableObjectState, { SESSION_TOKEN_SECRET: 'test-secret' } as Env, 'sess-1');
  const backend = {
    ensureRunning: vi.fn(async () => {}),
    restoreBackup: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  };
  // bindBackend() dynamically imports the real backend (and @cloudflare/sandbox).
  rt.bindBackend = async () => {
    (rt as unknown as { _backend: unknown })._backend = backend;
  };
  return { rt, storage, deleteAlarm, deleteAll, backend };
}

function manifest() {
  return parseManifest({
    slug: 'test-lab',
    version: '1.0.0',
    title: 'Test lab',
    type: 'build',
    family: 'agent',
    timeout_minutes: 120,
    services: [{ name: 'svc', argv: ['python3', '-m', 'http.server'], port: 8000 }],
    checks: [{ name: 'check-1', script: 'check.sh' }],
  });
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
    resumed_count: 0,
    ...extra,
  };
}

function snapshot(extra: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return { backup_id: 'bk-1', dir: '/workspace', ttl: 7 * 24 * 3600, created_at: Date.now() - 1000, reason: 'user', ...extra };
}

beforeEach(() => {
  pool.claim.mockReset();
  pool.release.mockReset();
  pool.claim.mockResolvedValue({ sandbox_id: 'claimed-1', warm: true });
  pool.release.mockResolvedValue(undefined);
});

describe('not_running guard (B-04)', () => {
  it('backend() on an unbound runtime is a 409 not_running, not a bare Error', () => {
    const { rt } = makeRuntime();
    let thrown: unknown;
    try {
      rt.backend();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(409);
    expect((thrown as ApiError).code).toBe('not_running');
  });

  it('requireRunning() passes only while the session is running', async () => {
    for (const state of ['created', 'starting', 'recovering', 'resuming', 'ended'] as const) {
      const { rt } = makeRuntime();
      await rt.putMeta(metaIn(state));
      await expect(rt.requireRunning()).rejects.toMatchObject({ status: 409, code: 'not_running' });
    }
    const { rt } = makeRuntime();
    await rt.putMeta(metaIn('running'));
    await expect(rt.requireRunning()).resolves.toBeUndefined();
  });

  it('a resume timer that fires after the session ended does nothing', async () => {
    const { rt } = makeRuntime();
    await rt.putMeta(metaIn('ended', { ended_at: Date.now() }));
    await rt.putManifest(manifest());
    await rt.putSnapshots([snapshot()]);
    await scheduleTimer(rt, 'resume', Date.now() - 1);

    await handleAlarm(rt);

    expect(pool.claim).not.toHaveBeenCalled();
    expect((await rt.requireMeta()).state).toBe('ended');
  });
});

describe('resume claims a fresh container (B-05)', () => {
  it('endSession clears sandbox_id, and the resume claims exactly once', async () => {
    const { rt, storage } = makeRuntime();
    await rt.putMeta(metaIn('running', { sandbox_id: 'old', started_at: Date.now() - 30_000 }));
    await rt.putManifest(manifest());
    await rt.putSnapshots([snapshot()]);
    await rt.bindBackend('agent', 'old');

    await endSession(rt, 'user', false);
    const ended = await rt.requireMeta();
    expect(ended.state).toBe('ended');
    expect(ended.sandbox_id).toBeUndefined();
    expect('sandbox_id' in (storage._dump().get('meta') as object)).toBe(false);
    expect(ended.last_sandbox_id).toBe('old');
    expect(pool.release).toHaveBeenCalledWith('old');

    await requestResume(rt);
    await handleAlarm(rt);

    expect(pool.claim).toHaveBeenCalledTimes(1);
    const resumed = await rt.requireMeta();
    expect(resumed.state).toBe('running');
    expect(resumed.sandbox_id).toBe('claimed-1');
    expect(resumed.last_sandbox_id).toBe('old');
  });
});

describe('ended sessions stop waking and then purge (B-06)', () => {
  it('endSession leaves only the cleanup timer, including ref-carrying pressure and hint timers', async () => {
    const { rt } = makeRuntime();
    const now = Date.now();
    await rt.putMeta(metaIn('running', { sandbox_id: 'old', started_at: now }));
    await rt.putManifest(manifest());
    await rt.bindBackend('agent', 'old');
    for (const [kind, ref] of [
      ['hard', undefined],
      ['idle', undefined],
      ['pressure', 'p1'],
      ['pressure', 'p2'],
      ['hint', '0'],
      ['hint', '1'],
      ['health', undefined],
      ['metrics', undefined],
      ['cleanup', undefined],
    ] as const) {
      await scheduleTimer(rt, kind, now + 60_000, ref);
    }

    await endSession(rt, 'user', false);

    expect((await rt.timers()).map((t) => t.kind)).toEqual(['cleanup']);
  });

  it('cleanup drops session_env and checks:last and schedules the purge at the last snapshot expiry', async () => {
    const { rt, storage } = makeRuntime();
    const first = snapshot({ backup_id: 'a', created_at: 1_000_000, ttl: 100 });
    const last = snapshot({ backup_id: 'b', created_at: 2_000_000, ttl: 100 });
    await rt.putMeta(metaIn('ended', { ended_at: Date.now() }));
    await rt.putSnapshots([first, last]);
    await rt.putSessionEnv({ A: 'b' });
    await rt.putLastChecks({ run_id: 'r', started_at: 1, results: [] });
    await scheduleTimer(rt, 'cleanup', Date.now() - 1);

    await handleAlarm(rt);

    expect(storage._dump().has('session_env')).toBe(false);
    expect(storage._dump().has('checks:last')).toBe(false);
    expect(storage._dump().has('meta')).toBe(true);
    expect(await rt.timers()).toEqual([{ kind: 'purge', at: 2_000_000 + 100 * 1000, ref: undefined }]);
  });

  it('cleanup with no snapshots schedules the purge a week out', async () => {
    const { rt } = makeRuntime();
    await rt.putMeta(metaIn('ended', { ended_at: Date.now() }));
    await scheduleTimer(rt, 'cleanup', Date.now() - 1);
    const before = Date.now();

    await handleAlarm(rt);

    const [purge] = await rt.timers();
    expect(purge!.kind).toBe('purge');
    expect(purge!.at).toBeGreaterThanOrEqual(before + 7 * 24 * 3600_000);
  });

  it('purge empties storage and clears the alarm, even though the session is ended', async () => {
    const { rt, storage, deleteAll, deleteAlarm } = makeRuntime();
    await rt.putMeta(metaIn('ended', { ended_at: Date.now() }));
    await rt.putManifest(manifest());
    await rt.putSnapshots([snapshot()]);
    await rt.putCost({ running_s: 1, usd: 1, llm_usd: 0 });
    await scheduleTimer(rt, 'purge', Date.now() - 1);

    await handleAlarm(rt);

    expect(deleteAll).toHaveBeenCalledTimes(1);
    expect(deleteAlarm).toHaveBeenCalled();
    expect(storage._dump().size).toBe(0);
    expect(await storage.getAlarm()).toBeNull();
  });

  it('purge leaves a session that was resumed since cleanup was scheduled alone', async () => {
    const { rt, deleteAll } = makeRuntime();
    await rt.putMeta(metaIn('running'));
    await scheduleTimer(rt, 'purge', Date.now() - 1);

    await handleAlarm(rt);

    expect(deleteAll).not.toHaveBeenCalled();
    expect((await rt.requireMeta()).state).toBe('running');
  });
});
