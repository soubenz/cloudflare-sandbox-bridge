import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/env';
import { mintSessionToken } from '../../src/auth';
import { SOLUTION_RULE, buildSolutionStatus, type SolutionProgress } from '../../src/session/solution';
import { makeTgz, streamOf } from './tar-writer';

vi.mock('../../src/do/pool', () => ({ poolStub: () => ({ admit: async () => {}, stats: async () => ({}) }) }));

const { createRouter } = await import('../../src/router');
const app = createRouter();

const SERVICE = { Authorization: 'Bearer svc-key' };
const KEY = 'labs/lab-a/1.0.0/solution.tgz';

const progress = (p: Partial<SolutionProgress> = {}): SolutionProgress => ({
  check_runs: 0, hints_delivered: 0, hints_total: 2, completed: false, ...p,
});

interface Fixture {
  env: Env;
  /** What the DO's status() reports for `solution`; mutate to move the session along. */
  state: { progress: SolutionProgress; available: boolean };
  statusCalls: number;
  gets: string[];
  store: Map<string, Uint8Array>;
}

function fixture(): Fixture {
  const store = new Map<string, Uint8Array>();
  const f = { state: { progress: progress(), available: true }, statusCalls: 0, gets: [] as string[], store } as Fixture;
  f.env = {
    SANDBOX_API_KEY: 'svc-key',
    SESSION_TOKEN_SECRET: 'secret',
    PUBLIC_BASE_URL: 'https://api.test',
    LABS_BUCKET: {
      get: async (key: string) => {
        f.gets.push(key);
        const bytes = store.get(key);
        if (!bytes) return null;
        const text = () => Promise.resolve(new TextDecoder().decode(bytes));
        return { body: streamOf(bytes, 200), text, json: async () => JSON.parse(await text()) };
      },
      head: async (key: string) => (store.has(key) ? { key } : null),
      put: async (key: string, value: ArrayBuffer | string) => {
        store.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));
      },
      delete: async (key: string) => void store.delete(key),
      list: async () => ({ objects: [...store.keys()].map((key) => ({ key })), truncated: false }),
    },
    SESSION: {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        status: async () => {
          f.statusCalls++;
          return {
            meta: { id, user_id: 'u1', lab_slug: 'lab-a', lab_version: '1.0.0', state: 'running' },
            solution: buildSolutionStatus(f.state.progress, f.state.available),
          };
        },
      }),
    },
  } as unknown as Env;
  return f;
}

const get = (env: Env, path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`https://api.test${path}`, { headers }), env);

async function token(env: Env, sid = 's1') {
  return { Authorization: `Bearer ${await mintSessionToken(env, { sid, uid: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}` };
}

const body = async (res: Response) => (await res.json()) as any;

let f: Fixture;
beforeEach(() => {
  f = fixture();
  f.store.set(
    KEY,
    new Uint8Array(
      makeTgz([
        { name: './app/main.py', content: 'print("solved")\n' },
        { name: './config.yaml', content: 'ok: true\n' },
        { name: './logo.png', content: new Uint8Array([0x89, 0x50, 0x00, 0x1a]) },
      ])
    )
  );
});

describe('GET /sessions/:id/solution', () => {
  it('is 403 solution_locked with the rule and progress, then 200 with the files once the rule is met', async () => {
    const auth = await token(f.env);

    // Locked: one run, no hints.
    f.state.progress = progress({ check_runs: 1, hints_delivered: 0, hints_total: 2 });
    const locked = await get(f.env, '/sessions/s1/solution', auth);
    expect(locked.status).toBe(403);
    expect(await body(locked)).toEqual({
      error: {
        code: 'solution_locked',
        message: expect.any(String),
        details: {
          rule: 'Pass every check, or use every hint and run the checks twice.',
          progress: { check_runs: 1, hints_delivered: 0, hints_total: 2, completed: false },
        },
      },
    });
    expect(f.gets).toEqual([]); // a locked session never touches the tarball

    // The learner uses every hint and runs the checks a second time.
    f.state.progress = progress({ check_runs: 2, hints_delivered: 2, hints_total: 2 });
    const open = await get(f.env, '/sessions/s1/solution', auth);
    expect(open.status).toBe(200);
    expect(await body(open)).toEqual({
      files: [
        { path: 'app/main.py', content: 'print("solved")\n' },
        { path: 'config.yaml', content: 'ok: true\n' },
      ],
      truncated: false,
    });
    expect(f.gets).toEqual([KEY]);
  });

  it('completing the lab unlocks it without any hints', async () => {
    f.state.progress = progress({ check_runs: 1, completed: true });
    expect((await get(f.env, '/sessions/s1/solution', await token(f.env))).status).toBe(200);
  });

  it('is 404 no_solution when the lab has none, whatever the progress', async () => {
    f.state.available = false;
    f.state.progress = progress({ completed: true, check_runs: 5 });
    const res = await get(f.env, '/sessions/s1/solution', await token(f.env));
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe('no_solution');
    expect(f.gets).toEqual([]);
  });

  it('is 404 no_solution when the object vanished after status() said it was there', async () => {
    f.state.progress = progress({ completed: true });
    f.store.delete(KEY);
    const res = await get(f.env, '/sessions/s1/solution', await token(f.env));
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe('no_solution');
  });

  it('a locked session with no solution is 404, not 403: it does not hint that one exists', async () => {
    f.state.available = false;
    f.state.progress = progress();
    expect((await get(f.env, '/sessions/s1/solution', await token(f.env))).status).toBe(404);
  });

  it('refuses the service key, like the cookie route, before asking the session anything', async () => {
    f.state.progress = progress({ completed: true });
    const res = await get(f.env, '/sessions/s1/solution', SERVICE);
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe('session_token_required');
    expect(f.statusCalls).toBe(0);
    expect(f.gets).toEqual([]);
  });

  it('needs a token for that very session', async () => {
    f.state.progress = progress({ completed: true });
    expect((await get(f.env, '/sessions/s1/solution')).status).toBe(401);
    expect((await get(f.env, '/sessions/s1/solution', await token(f.env, 'someone-else'))).status).toBe(401);
    expect(f.statusCalls).toBe(0);
  });

  it('reports truncated when a cap dropped a file', async () => {
    f.store.set(
      KEY,
      new Uint8Array(makeTgz([{ name: 'small.txt', content: 'ok' }, { name: 'huge.txt', content: 'x'.repeat(65 * 1024) }]))
    );
    f.state.progress = progress({ completed: true });
    const res = await get(f.env, '/sessions/s1/solution', await token(f.env));
    expect(await body(res)).toEqual({ files: [{ path: 'small.txt', content: 'ok' }], truncated: true });
  });

  it('a corrupt stored archive is a 500 solution_unreadable, not a crash', async () => {
    f.store.set(KEY, new Uint8Array(makeTgz([{ name: '../escape.txt', content: 'x' }])));
    f.state.progress = progress({ completed: true });
    const res = await get(f.env, '/sessions/s1/solution', await token(f.env));
    expect(res.status).toBe(500);
    expect((await body(res)).error.code).toBe('solution_unreadable');
  });

  it('accepts the session token as ?token= like the other session routes', async () => {
    f.state.progress = progress({ completed: true });
    const raw = (await token(f.env)).Authorization.slice(7);
    expect((await get(f.env, `/sessions/s1/solution?token=${raw}`)).status).toBe(200);
  });
});

describe('POST /labs/publish with a solution part', () => {
  const manifest = {
    slug: 'lab-a', version: '1.0.0', title: 'Lab A', type: 'build', family: 'agent', timeout_minutes: 60,
    services: [{ name: 'svc', argv: ['x'], port: 8000 }],
    checks: [{ name: 'c', script: 'c.sh' }],
  };
  const publish = (env: Env, parts: { solution?: Uint8Array | 'empty'; force?: boolean }) => {
    const form = new FormData();
    form.set('manifest', new Blob([JSON.stringify(manifest)], { type: 'application/json' }), 'manifest.json');
    form.set('workspace', new Blob([new Uint8Array(4)]), 'workspace.tgz');
    form.set('private', new Blob([new Uint8Array(4)]), 'private.tgz');
    if (parts.solution) form.set('solution', new Blob([parts.solution === 'empty' ? new Uint8Array() : parts.solution]), 'solution.tgz');
    if (parts.force) form.set('force', 'true');
    return app.fetch(new Request('https://api.test/labs/publish', { method: 'POST', headers: SERVICE, body: form }), env);
  };

  it('stores solution.tgz next to the other parts when sent', async () => {
    const env = fixture();
    const tgz = new Uint8Array(makeTgz([{ name: 'a.txt', content: 'a' }]));
    expect((await publish(env.env, { solution: tgz })).status).toBe(201);
    expect(env.store.get(KEY)).toEqual(tgz);
    expect([...env.store.keys()].filter((k) => k.endsWith('.tgz')).sort()).toEqual([
      'labs/lab-a/1.0.0/private.tgz',
      KEY,
      'labs/lab-a/1.0.0/workspace.tgz',
    ]);
  });

  it('stores nothing for a lab without one (no part, or an empty part)', async () => {
    for (const parts of [{}, { solution: 'empty' as const }]) {
      const env = fixture();
      expect((await publish(env.env, parts)).status).toBe(201);
      expect(env.store.has(KEY)).toBe(false);
    }
  });

  it('is never served by a catalogue route', async () => {
    const env = fixture();
    await publish(env.env, { solution: new Uint8Array(makeTgz([{ name: 'a.txt', content: 'a' }])) });
    const list = await (await get(env.env, '/labs', SERVICE)).text();
    const one = await (await get(env.env, '/labs/lab-a', SERVICE)).text();
    expect(list + one).not.toContain('solution');
  });
});

describe('the rule text', () => {
  it('is fixed', () => {
    expect(SOLUTION_RULE).toBe('Pass every check, or use every hint and run the checks twice.');
  });
});
