import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  LEARNER_LAUNCH_PREFIX,
  LEARNER_WRITABLE_PATH_RE,
  LEARNER_WRITABLE_ROOTS,
  SETPRIV,
  buildServiceLaunch,
  defaultServiceUser,
  mentionsLearnerWritablePath,
  serviceUser,
} from '../../src/labs/service-user';
import { parseManifest } from '../../src/labs/manifest';
import { createFakeRuntime } from '../fakes/fake-runtime';
import { FakeBackend, FakeProcess } from '../fakes/fake-backend';
import { startService, restartService } from '../../src/session/services';
import type { ServiceRuntime, SessionRuntime } from '../../src/session/state';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('mentionsLearnerWritablePath', () => {
  it.each([
    '/workspace',
    '/workspace/app.py',
    'file:/workspace/jaeger/config.yaml',
    '--config=/workspace/x.yaml',
    'sqlite:////tmp/mlflow.db',
    'sqlite:////workspace/contextforge.db',
    '/tmp',
    '/tmp/pg',
    '/var/tmp/x',
    '/dev/shm/x',
    '/home/learner/.cache',
    'python3 -B /workspace/seed.py & exec litellm',
    "cp '/workspace/a' /etc/b",
  ])('sees %s', (value) => {
    expect(mentionsLearnerWritablePath(value)).toBe(true);
  });

  it.each([
    '/usr/share/grafana',
    '/opt/opalix/bin/jaeger',
    '/usr/tmp/x',
    '/opt/x/workspace/y',
    '/workspaces',
    '/tmpfoo',
    '/home/learner2',
    '/home/postgres',
    'grafana-server',
    '{{service.prefix}}',
    '/sessions/{{session.id}}/services/admin',
  ])('does not see %s', (value) => {
    expect(mentionsLearnerWritablePath(value)).toBe(false);
  });

  it('covers exactly the declared roots', () => {
    for (const root of LEARNER_WRITABLE_ROOTS) expect(mentionsLearnerWritablePath(root)).toBe(true);
  });
});

describe('defaultServiceUser', () => {
  it('is learner for a script under /workspace', () => {
    expect(defaultServiceUser({ argv: ['python3', '-B', '/workspace/view.py'], cwd: '/workspace' })).toBe('learner');
  });

  it('is learner when only the cwd is learner-writable (python -m, relative paths, ./config)', () => {
    expect(defaultServiceUser({ argv: ['python3.12', '-m', 'mcpgateway'], cwd: '/workspace' })).toBe('learner');
    expect(defaultServiceUser({ argv: ['litellm', '--port', '4000'], cwd: '/tmp' })).toBe('learner');
  });

  it('is learner when argv names a learner-writable config or data path', () => {
    expect(defaultServiceUser({ argv: ['jaeger', '--config', 'file:/workspace/jaeger.yaml'], cwd: '/opt' })).toBe('learner');
    expect(defaultServiceUser({ argv: ['sh', '-c', 'exec x --data /tmp/x'], cwd: '/' })).toBe('learner');
  });

  it('is root for a platform binary that touches nothing the learner can write', () => {
    expect(
      defaultServiceUser({ argv: ['/usr/sbin/grafana-server', '--homepath=/usr/share/grafana'], cwd: '/usr/share/grafana' })
    ).toBe('root');
  });
});

describe('serviceUser', () => {
  it('reads the resolved field', () => {
    expect(serviceUser({ user: 'learner' })).toBe('learner');
    expect(serviceUser({ user: 'root' })).toBe('root');
  });

  it('keeps a spec stored before the field existed on root, so a live session is not changed under it', () => {
    expect(serviceUser({})).toBe('root');
  });
});

describe('buildServiceLaunch', () => {
  const session = { OPALIX_SESSION_ID: 's1', SHARED: 'session' };

  it('drops a learner service through setpriv, in place, with the argv untouched after the prefix', () => {
    const argv = ['sh', '-c', 'python3 -B /workspace/seed.py & exec python3.12 -m mcpgateway'];
    const launch = buildServiceLaunch({ argv, user: 'learner' }, session);
    expect(launch.user).toBe('learner');
    expect(launch.argv).toEqual([SETPRIV, '--reuid=learner', '--regid=learner', '--init-groups', '--', ...argv]);
    expect(launch.argv.slice(LEARNER_LAUNCH_PREFIX.length)).toEqual(argv);
    expect(SETPRIV).toBe('/usr/bin/setpriv');
  });

  it("gives a learner service the learner's HOME/USER/LOGNAME, under the session and service env", () => {
    const launch = buildServiceLaunch({ argv: ['python3', 'a.py'], user: 'learner', env: { SHARED: 'service', X: '1' } }, session);
    expect(launch.env).toEqual({
      HOME: '/home/learner',
      USER: 'learner',
      LOGNAME: 'learner',
      OPALIX_SESSION_ID: 's1',
      SHARED: 'service',
      X: '1',
    });
    const own = buildServiceLaunch({ argv: ['x'], user: 'learner', env: { HOME: '/tmp/home' } }, session);
    expect(own.env.HOME).toBe('/tmp/home');
  });

  it('launches a root service exactly as before: argv as given, session env under service env, no identity vars', () => {
    const launch = buildServiceLaunch({ argv: ['litellm', '--port', '4000'], user: 'root', env: { SHARED: 'service' } }, session);
    expect(launch).toEqual({ user: 'root', argv: ['litellm', '--port', '4000'], env: { OPALIX_SESSION_ID: 's1', SHARED: 'service' } });
  });

  it('treats a legacy spec (no user) as root', () => {
    expect(buildServiceLaunch({ argv: ['python3', '/workspace/app.py'] }, {}).argv).toEqual(['python3', '/workspace/app.py']);
  });

  it('does not mutate the spec it was given', () => {
    const spec = { argv: ['a'], user: 'learner' as const, env: { A: '1' } };
    buildServiceLaunch(spec, session);
    expect(spec).toEqual({ argv: ['a'], user: 'learner', env: { A: '1' } });
  });
});

const BASE = {
  slug: 'fixture-lab',
  version: '1.0.0',
  title: 'Fixture',
  type: 'build',
  family: 'agent',
  timeout_minutes: 60,
  checks: [{ name: 'c', script: 'c.sh' }],
};

describe('parseManifest: services[].user', () => {
  it('resolves an omitted user by the rule and records it', () => {
    const m = parseManifest({
      ...BASE,
      services: [
        { name: 'view', argv: ['python3', '-B', '/workspace/view.py'] },
        { name: 'grafana', argv: ['/usr/sbin/grafana-server'], cwd: '/usr/share/grafana' },
      ],
    });
    expect(m.services.map((s) => [s.name, s.user])).toEqual([
      ['view', 'learner'],
      ['grafana', 'root'],
    ]);
  });

  it('keeps an explicit user, either way', () => {
    const m = parseManifest({
      ...BASE,
      services: [
        { name: 'pg', argv: ['sh', '-c', 'exec runuser -u postgres -- postgres -D /tmp/pg'], user: 'root' },
        { name: 'tool', argv: ['/usr/local/bin/tool'], cwd: '/opt', user: 'learner' },
      ],
    });
    expect(m.services.map((s) => s.user)).toEqual(['root', 'learner']);
  });

  it('leaves user: root with learner-writable paths to the lint, which can see comments and exemptions', () => {
    const m = parseManifest({ ...BASE, services: [{ name: 'app', argv: ['python3', '-B', '/workspace/app.py'], user: 'root' }] });
    expect(m.services[0]!.user).toBe('root');
  });

  it('rejects an unknown user', () => {
    expect(() => parseManifest({ ...BASE, services: [{ name: 'a', argv: ['x'], user: 'nobody' }] })).toThrow(/services\.0\.user/);
  });
});

describe('services.ts launches through buildServiceLaunch', () => {
  async function setup(spec: ServiceRuntime['spec']) {
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
    await rt.putSessionEnv({ S: 'session' });
    backend.addProcess(new FakeProcess('old-proc', 11));
    await rt.putServices({ [spec.name]: { spec, process_id: 'old-proc', pid: 11, started_at: 1, restarts: 0, health: 'healthy' } });
    return { rt: rt as SessionRuntime, backend };
  }

  const view = {
    name: 'view',
    argv: ['python3', '-B', '/workspace/view.py'],
    cwd: '/workspace',
    env: { VIEW_PORT: '8962' },
    depends_on: [],
    ui: true,
    user: 'learner',
  } as unknown as ServiceRuntime['spec'];

  it('starts a learner service via setpriv with its cwd and the learner identity env', async () => {
    const { rt, backend } = await setup(view);
    await startService(rt, view);
    expect(backend.callsTo('exec')).toEqual([
      [
        [...LEARNER_LAUNCH_PREFIX, 'python3', '-B', '/workspace/view.py'],
        { cwd: '/workspace', env: { HOME: '/home/learner', USER: 'learner', LOGNAME: 'learner', S: 'session', VIEW_PORT: '8962' } },
      ],
    ]);
  });

  it('restarts it the same way, and stores the spec unprefixed', async () => {
    const { rt, backend } = await setup(view);
    const runtime = await restartService(rt, 'view');
    const [[argv]] = backend.callsTo('exec') as [[string[]]];
    expect(argv.slice(0, LEARNER_LAUNCH_PREFIX.length)).toEqual([...LEARNER_LAUNCH_PREFIX]);
    expect(runtime.spec.argv).toEqual(['python3', '-B', '/workspace/view.py']);
    expect((await rt.services()).view!.spec).toEqual(view);
  });

  it('starts a root service with its argv unchanged', async () => {
    const pg = { ...view, name: 'postgres', argv: ['sh', '-c', 'exec runuser -u postgres -- postgres'], user: 'root' } as unknown as ServiceRuntime['spec'];
    const { rt, backend } = await setup(pg);
    await startService(rt, pg);
    expect(backend.callsTo('exec')[0]![0]).toEqual(['sh', '-c', 'exec runuser -u postgres -- postgres']);
  });
});

describe('the lint mirrors the rule', () => {
  let lint: { LEARNER_WRITABLE_PATH_RE: RegExp; defaultServiceUser: (svc: unknown) => string };
  beforeAll(async () => {
    lint = await import(pathToFileURL(join(repoRoot, 'scripts', 'lint-labs.mjs')).href);
  });

  it('uses the same path pattern', () => {
    expect(lint.LEARNER_WRITABLE_PATH_RE.source).toBe(LEARNER_WRITABLE_PATH_RE.source);
  });

  const labsDir = join(repoRoot, 'labs');
  const dirs = existsSync(labsDir) ? readdirSync(labsDir).filter((d) => existsSync(join(labsDir, d, 'manifest.yaml'))) : [];
  it.each(dirs)('agrees with parseManifest on labs/%s', (dir) => {
    const raw = parseYaml(readFileSync(join(labsDir, dir, 'manifest.yaml'), 'utf8')) as { services: { user?: string }[] };
    const parsed = parseManifest(raw);
    raw.services.forEach((svc, i) => {
      expect(svc.user ?? lint.defaultServiceUser(svc)).toBe(parsed.services[i]!.user);
    });
  });
});
