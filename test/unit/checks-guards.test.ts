import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRuntime } from '../../src/session/state';
import type { SessionMeta } from '../../src/session/state';
import type { Env } from '../../src/env';
import { createFakeStorage } from '../fakes/fake-storage';
import { parseManifest } from '../../src/labs/manifest';
import { FakeBackend, FakeProcess } from '../fakes/fake-backend';
import { ApiError, fromSdkError } from '../../src/lib/errors';
import { mintSessionToken } from '../../src/auth';

/**
 * POST /sessions/:id/checks guards: unknown selections are a 400, a run
 * is spaced from the previous one (429), a second concurrent run is a 409,
 * and a run that executes nothing is never written to check_runs.
 */

const db = vi.hoisted(() => ({
  insertCheckRun: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../../src/do/pool', () => ({ poolStub: () => ({}) }));
vi.mock('../../src/session/hydrate', () => ({
  ensureStageDir: async () => {},
  stagePath: (n: string) => `/x/${n}`,
  archiveGuard: () => 'true',
  removeStaged: async () => {},
}));
vi.mock('../../src/session/d1', () => ({
  insertCheckRun: db.insertCheckRun,
  bestEffort: (p: Promise<unknown>) => void p.catch(() => {}),
}));
vi.mock('../../src/profile/notify', () => ({ announceNewAwards: async () => {} }));
vi.mock('../../src/path/service', () => ({ refreshPath: async () => 'refreshed' }));

const { runChecks, CHECK_MIN_INTERVAL_MS } = await import('../../src/session/checks');
const { createRouter } = await import('../../src/router');

const meta = (): SessionMeta => ({
  id: 'sess-1', user_id: 'u1', lab_slug: 'lab-a', lab_version: '1.0.0', family: 'agent', state: 'running',
  created_at: Date.now() - 60_000, started_at: Date.now() - 60_000, resumed_count: 0,
});

const manifest = () =>
  parseManifest({
    slug: 'lab-a', version: '1.0.0', title: 'Lab A', type: 'build', family: 'agent', timeout_minutes: 90, idle_minutes: 15,
    objectives: ['do the thing'],
    services: [{ name: 'api', argv: ['python3', 'app.py'], port: 8000 }],
    checks: [{ name: 'c1', script: 'c1.sh' }, { name: 'c2', script: 'c2.sh' }],
  });

const OK = { exitCode: 0, stdout: '{"pass":true,"message":"ok"}', stderr: '', timedOut: false };

function runtime() {
  const storage = createFakeStorage();
  const env = { SESSION_TOKEN_SECRET: 's', LABS_BUCKET: { head: async () => null, get: async () => ({ body: new Uint8Array() }) } } as unknown as Env;
  const ctx = { id: { name: 'sess-1' }, storage: { ...storage, sql: { exec: () => [] } }, getWebSockets: () => [] };
  const rt = new SessionRuntime(ctx as unknown as DurableObjectState, env, 'sess-1');
  const fake = new FakeBackend();
  (rt as unknown as { _backend: unknown })._backend = fake.asBackend();
  /** Queues staging plus `n` passing checks. */
  const queueRun = (n: number) => {
    const proc = (out: object) => new FakeProcess().resolveNext('output', out);
    fake.resolveNext('exec', proc({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    for (let i = 0; i < n; i++) fake.resolveNext('exec', proc(OK));
  };
  return { rt, fake, queueRun };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const rejection = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as ApiError;

beforeEach(() => {
  db.insertCheckRun.mockClear();
});

describe('only: unknown selections are a 400 unknown_check', () => {
  it.each([
    ['a name no check has', ['x']],
    ['a real name next to a bad one', ['c1', 'nope']],
    ['an empty list', []],
    ['a non-array', 'c1'],
    ['a non-string entry', [1]],
  ])('%s', async (_label, only) => {
    const { rt, fake } = runtime();
    await rt.putMeta(meta());
    const err = await rejection(runChecks(rt, manifest(), only as unknown as string[]));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe('ApiError:400:unknown_check');
    // The valid names are listed, in the message and in the details.
    expect(err.message).toContain('Valid checks: c1, c2');
    expect(err.details).toMatchObject({ valid: ['c1', 'c2'] });
    // Nothing ran, nothing was stored, nothing was written.
    expect(fake.calls).toEqual([]);
    expect(await rt.lastChecks()).toBeUndefined();
    await settle();
    expect(db.insertCheckRun).not.toHaveBeenCalled();
  });

  it('a rejected selection does not start the interval: a valid request right after runs', async () => {
    const { rt, queueRun } = runtime();
    await rt.putMeta(meta());
    await rejection(runChecks(rt, manifest(), ['x']));
    queueRun(1);
    const run = await runChecks(rt, manifest(), ['c2']);
    expect(run.results.map((r) => r.name)).toEqual(['c2']);
  });
});

describe('a run that executes zero checks is never written', () => {
  it('returns an empty run without events, storage or a check_runs row, and does not start the interval', async () => {
    const { rt, fake, queueRun } = runtime();
    await rt.putMeta(meta());
    const empty = { ...manifest(), checks: [] };
    const run = await runChecks(rt, empty);
    expect(run.results).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(await rt.lastChecks()).toBeUndefined();
    expect(await rt.checkRunCount()).toBe(0);
    await settle();
    expect(db.insertCheckRun).not.toHaveBeenCalled();

    queueRun(2);
    await runChecks(rt, manifest());
    await settle();
    expect(db.insertCheckRun).toHaveBeenCalledTimes(1);
    expect((db.insertCheckRun.mock.calls[0]![2] as { results: unknown[] }).results).toHaveLength(2);
  });
});

describe('a minimum interval between runs', () => {
  it('a second request inside the window is 429 checks_too_frequent with retry_after_ms; nothing new is stored', async () => {
    const { rt, queueRun } = runtime();
    await rt.putMeta(meta());
    queueRun(2);
    await runChecks(rt, manifest());
    await settle();
    expect(db.insertCheckRun).toHaveBeenCalledTimes(1);

    const err = await rejection(runChecks(rt, manifest()));
    expect(err.name).toBe('ApiError:429:checks_too_frequent');
    const wait = (err.details as { retry_after_ms: number }).retry_after_ms;
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(CHECK_MIN_INTERVAL_MS);
    await settle();
    expect(db.insertCheckRun).toHaveBeenCalledTimes(1);
    expect(await rt.checkRunCount()).toBe(1);

    // After the RPC boundary only name and message survive; the hint is read back from the message.
    const flattened = Object.assign(new Error(err.message), { name: err.name });
    const back = fromSdkError(flattened);
    expect(back.status).toBe(429);
    expect(back.code).toBe('checks_too_frequent');
    expect(back.details).toEqual({ retry_after_ms: wait });
  });

  it('is open again once the window has passed', async () => {
    const { rt, queueRun } = runtime();
    await rt.putMeta(meta());
    queueRun(2);
    await runChecks(rt, manifest());
    const last = (await rt.lastChecks())!;
    await rt.putLastChecks({ ...last, started_at: Date.now() - CHECK_MIN_INTERVAL_MS - 1 });
    queueRun(2);
    await expect(runChecks(rt, manifest())).resolves.toMatchObject({ results: expect.any(Array) });
  });

  it('a run already in progress is 409 checks_running (before the interval is considered), and frees the slot afterwards', async () => {
    const { rt, fake, queueRun } = runtime();
    await rt.putMeta(meta());
    queueRun(2);
    // Hold the first run inside its staging step.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const exec = fake.exec.bind(fake);
    fake.exec = (async (...args: Parameters<typeof exec>) => {
      await gate;
      return exec(...args);
    }) as typeof fake.exec;

    const first = runChecks(rt, manifest());
    await settle();
    const err = await rejection(runChecks(rt, manifest()));
    expect(err.name).toBe('ApiError:409:checks_running');

    release();
    await first;
    // Released: the next error is the interval, not "in progress".
    expect((await rejection(runChecks(rt, manifest()))).name).toBe('ApiError:429:checks_too_frequent');
  });

  it('a failed run (staging error) frees the in-flight slot', async () => {
    const { rt, fake } = runtime();
    await rt.putMeta(meta());
    fake.rejectNext('exec', new Error('boom'));
    await expect(runChecks(rt, manifest())).rejects.toThrow('boom');
    expect((await rejection(runChecks(rt, manifest()))).name).toBe('ApiError:429:checks_too_frequent');
  });
});

describe('POST /sessions/:id/checks over HTTP', () => {
  const app = createRouter();

  /** A SESSION namespace whose runChecks is the real one, with errors flattened the way a DO RPC flattens them. */
  async function world() {
    const w = runtime();
    await w.rt.putMeta(meta());
    const env = {
      SESSION_TOKEN_SECRET: 'secret',
      SANDBOX_API_KEY: 'svc-key',
      PUBLIC_BASE_URL: 'https://api.test',
      SESSION: {
        idFromName: (id: string) => id,
        get: () => ({
          runChecks: async (only?: string[]) => {
            try {
              return await runChecks(w.rt, manifest(), only);
            } catch (e) {
              const err = e as Error;
              throw Object.assign(new Error(err.message), { name: err.name });
            }
          },
        }),
      },
    } as unknown as Env;
    const auth = { Authorization: `Bearer ${await mintSessionToken(env, { sid: 'sess-1', uid: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}` };
    const post = (body: unknown) =>
      app.fetch(new Request('https://api.test/sessions/sess-1/checks', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) }), env);
    return { ...w, post };
  }

  it('400 unknown_check lists the valid names', async () => {
    const w = await world();
    const res = await w.post({ only: ['x'] });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe('unknown_check');
    expect(error.message).toContain('"x"');
    expect(error.message).toContain('c1, c2');
  });

  it('200, then 429 with retry_after_ms in the body', async () => {
    const w = await world();
    w.queueRun(2);
    expect((await w.post({})).status).toBe(200);
    const res = await w.post({});
    expect(res.status).toBe(429);
    const { error } = (await res.json()) as { error: { code: string; details: { retry_after_ms: number } } };
    expect(error.code).toBe('checks_too_frequent');
    expect(error.details.retry_after_ms).toBeGreaterThan(0);
  });
});
