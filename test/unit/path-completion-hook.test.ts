import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRuntime } from '../../src/session/state';
import type { SessionMeta } from '../../src/session/state';
import type { Env } from '../../src/env';
import { createFakeStorage } from '../fakes/fake-storage';
import { parseManifest } from '../../src/labs/manifest';
import { FakeBackend, FakeProcess } from '../fakes/fake-backend';

/**
 * Completing a lab (a check run that passes every check) refreshes the
 * learner's path, best effort and never in the way of the run itself.
 */

const hook = vi.hoisted(() => ({
  refreshPath: vi.fn(async (..._args: unknown[]) => 'refreshed'),
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
  insertCheckRun: hook.insertCheckRun,
  bestEffort: (p: Promise<unknown>) => void p.catch(() => {}),
}));
vi.mock('../../src/path/service', () => ({ refreshPath: hook.refreshPath }));

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

async function run(passes: boolean[], only?: string[]) {
  const { runChecks } = await import('../../src/session/checks');
  const storage = createFakeStorage();
  const env = { SESSION_TOKEN_SECRET: 's', LABS_BUCKET: { head: async () => null, get: async () => ({ body: new Uint8Array() }) } } as unknown as Env;
  const ctx = { id: { name: 'sess-1' }, storage: { ...storage, sql: { exec: () => [] } }, getWebSockets: () => [] };
  const rt = new SessionRuntime(ctx as unknown as DurableObjectState, env, 'sess-1');
  await rt.putMeta(meta());
  const fake = new FakeBackend();
  const proc = (out: object) => new FakeProcess().resolveNext('output', out);
  fake.resolveNext('exec', proc({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
  for (const pass of passes) fake.resolveNext('exec', proc({ exitCode: pass ? 0 : 1, stdout: JSON.stringify({ pass, message: 'm' }), stderr: '', timedOut: false }));
  (rt as unknown as { _backend: unknown })._backend = fake.asBackend();
  const result = await runChecks(rt, manifest(), only);
  await new Promise((r) => setTimeout(r, 0)); // let the best-effort chain finish
  return { rt, env, result };
}

beforeEach(() => {
  hook.refreshPath.mockClear();
  hook.insertCheckRun.mockClear();
  hook.refreshPath.mockImplementation(async () => 'refreshed');
  hook.insertCheckRun.mockImplementation(async () => {});
});

describe('lab completion refreshes the path', () => {
  it('a run that passes every check calls refreshPath for that user, after the row is written', async () => {
    const order: string[] = [];
    hook.insertCheckRun.mockImplementation(async () => void order.push('insert'));
    hook.refreshPath.mockImplementation(async () => (order.push('refresh'), 'refreshed'));
    const { env } = await run([true, true]);
    expect(hook.refreshPath).toHaveBeenCalledTimes(1);
    expect(hook.refreshPath).toHaveBeenCalledWith(env, 'u1');
    expect(order).toEqual(['insert', 'refresh']);
  });

  it('a failing run, or a subset of the checks, does not', async () => {
    await run([true, false]);
    await run([true], ['c1']);
    expect(hook.refreshPath).not.toHaveBeenCalled();
  });

  it('a refresh that fails does not touch the run or its result', async () => {
    hook.refreshPath.mockImplementation(async () => {
      throw new Error('d1 is down');
    });
    const { result, rt } = await run([true, true]);
    expect(result.results.every((r) => r.pass)).toBe(true);
    expect(await rt.checksCompleted()).toBe(true);
  });

  it('does not wait for the refresh: the run returns while it is still pending', async () => {
    let release!: () => void;
    hook.refreshPath.mockImplementation(() => new Promise<string>((r) => (release = () => r('refreshed'))));
    const { result } = await run([true, true]);
    expect(result.results).toHaveLength(2);
    release();
  });

  it('a row that could not be written means no refresh, since nothing was completed in D1', async () => {
    hook.insertCheckRun.mockImplementation(async () => {
      throw new Error('d1 write failed');
    });
    await run([true, true]);
    expect(hook.refreshPath).not.toHaveBeenCalled();
  });
});
